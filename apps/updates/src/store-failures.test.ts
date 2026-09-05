import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import { UpdateStore } from "./store.ts";
import { sqliteDatabase } from "./test-support.ts";

const run = <A, E>(effect: Effect.Effect<A, E, UpdateStore | SqlClient.SqlClient>) =>
  Effect.runPromise(effect.pipe(Effect.provide(UpdateStore.layer.pipe(Layer.provideMerge(sqliteDatabase())))));

describe("SQL failure handling", () => {
  it("keeps a partially written publish invisible through every read and rollout", () =>
    run(
      Effect.gen(function* () {
        const store = yield* UpdateStore;
        const sql = yield* SqlClient.SqlClient;
        yield* sql`CREATE TRIGGER fail_android BEFORE INSERT ON updates
      WHEN NEW.platform = 'android' BEGIN SELECT RAISE(ABORT, 'simulated write failure'); END`;
        const update = { runtimeVersion: "rt-1", rollbackToEmbedded: true } as const;
        const error = yield* Effect.flip(
          store.publishGroup({ branch: "staging", updates: { ios: update, android: update } }),
        );
        expect(error._tag).toBe("StorageError");
        const rows = yield* sql<{
          id: string;
          published_at: string | null;
        }>`SELECT id, published_at FROM update_groups`;
        expect(rows).toHaveLength(1);
        expect(rows[0]!.published_at).toBeNull();
        const id = rows[0]!.id;
        expect(yield* store.groupById(id)).toBeNull();
        expect(yield* store.listGroups("staging", { limit: 10 })).toEqual([]);
        expect(yield* store.latestPerRuntime()).toEqual([]);
        expect(
          yield* store.latestUpdates({ branch: "staging", platform: "ios", runtimeVersion: "rt-1", limit: 2 }),
        ).toEqual([]);
        expect(yield* store.rollbackTargets("staging")).toEqual([]);
        expect(yield* store.setRollout(id, 100)).toBe(false);
        yield* sql`DROP TRIGGER fail_android`;
        const published = yield* store.publishGroup({ branch: "staging", updates: { ios: update, android: update } });
        expect((yield* store.groupById(published.groupId))?.updates).toHaveLength(2);
      }),
    ));

  it("rejects an incomplete stored bundle instead of turning it into a rollback", () =>
    run(
      Effect.gen(function* () {
        const store = yield* UpdateStore;
        const sql = yield* SqlClient.SqlClient;
        const group = yield* store.publishGroup({
          branch: "staging",
          updates: { ios: { runtimeVersion: "rt-1", rollbackToEmbedded: true } },
        });
        yield* sql`UPDATE updates SET rollback_to_embedded = 0 WHERE group_id = ${group.groupId}`;
        const error = yield* Effect.flip(
          store.latestUpdates({
            branch: "staging",
            platform: "ios",
            runtimeVersion: "rt-1",
            limit: 2,
          }),
        );
        expect(error._tag).toBe("StorageError");
      }),
    ));
});
