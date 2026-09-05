import { Effect, Layer, Stream } from "effect";
import * as Reactivity from "effect/unstable/reactivity/Reactivity";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type * as SqlConnection from "effect/unstable/sql/SqlConnection";
import * as Statement from "effect/unstable/sql/Statement";
import { describe, expect, it } from "vitest";
import { UpdateStore } from "./store.ts";

// D1's hard limit. A statement over it fails with a 500 the caller cannot act
// on, which is exactly how a large publish used to break.
const d1BoundParameterLimit = 100;

// A driver double: it answers from `rows` and keeps every compiled statement so
// the tests can check what D1 would have been asked to run.
const recordingStore = (rows: (sql: string, params: ReadonlyArray<unknown>) => ReadonlyArray<unknown>) => {
  const statements: Array<{ readonly sql: string; readonly params: ReadonlyArray<unknown> }> = [];
  const execute = (sql: string, params: ReadonlyArray<unknown>) =>
    Effect.sync(() => {
      statements.push({ sql, params });
      return rows(sql, params);
    });
  const unsupported = () => Effect.die("the recording connection does not support this");
  const connection = {
    execute,
    executeUnprepared: execute,
    executeRaw: execute,
    executeValues: unsupported,
    executeValuesUnprepared: unsupported,
    executeStream: () => Stream.die("the recording connection does not support streams"),
  } satisfies SqlConnection.Connection;
  const client = Layer.effect(
    SqlClient.SqlClient,
    SqlClient.make({
      acquirer: Effect.succeed(connection),
      compiler: Statement.makeCompilerSqlite(),
      spanAttributes: [],
    }),
  ).pipe(Layer.provide(Reactivity.layer));
  const run = <A>(use: (store: UpdateStore["Service"]) => Effect.Effect<A, unknown>) =>
    Effect.runPromise(
      Effect.gen(function* () {
        return yield* use(yield* UpdateStore);
      }).pipe(Effect.provide(UpdateStore.layer.pipe(Layer.provide(client))), Effect.orDie),
    );
  return { statements, run };
};

const hashes = (count: number) => Array.from({ length: count }, (_, index) => `hash-${index}`);

describe("the sql store stays inside D1's limits", () => {
  it("asks for missing assets in batches", async () => {
    const stored = new Set(hashes(1000).filter((_, index) => index % 2 === 0));
    const { statements, run } = recordingStore((_, params) =>
      params.filter((param) => stored.has(param as string)).map((hash) => ({ hash })),
    );

    const missing = await run((store) => store.missingAssets(hashes(1000)));

    expect(missing).toEqual(hashes(1000).filter((hash) => !stored.has(hash)));
    expect(statements.length).toBeGreaterThan(1);
    for (const statement of statements) {
      expect(statement.params.length).toBeLessThanOrEqual(d1BoundParameterLimit);
    }
  });

  it("reads the updates of a page of groups in batches", async () => {
    const groups = Array.from({ length: 250 }, (_, index) => ({
      id: `group-${index}`,
      branch_name: "staging",
      message: null,
      git_commit: null,
      actor: null,
      created_at: "2026-09-02T00:00:00.000Z",
    }));
    const { statements, run } = recordingStore((sql) => (sql.includes("FROM update_groups") ? groups : []));

    const listed = await run((store) => store.listGroups("staging", { limit: groups.length }));

    expect(listed).toHaveLength(groups.length);
    for (const statement of statements) {
      expect(statement.params.length).toBeLessThanOrEqual(d1BoundParameterLimit);
    }
  });

  it("asks nothing at all for an empty list", async () => {
    const { statements, run } = recordingStore(() => []);

    expect(await run((store) => store.missingAssets([]))).toEqual([]);
    expect(statements).toEqual([]);
  });
});
