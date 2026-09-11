import { DateTime, Effect } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";
import type { PublishGroupInput } from "./model.ts";
import { UpdateStore, recentChecksKept, type DeviceCheck, type DeviceQuery } from "./store.ts";
import { stores } from "./test-support.ts";

const bundle = (hash = "A".repeat(43)) => ({
  runtimeVersion: "rt-1",
  launchAsset: { hash, key: "key", contentType: "application/javascript" },
  assets: [],
});
const check = (overrides: Partial<DeviceCheck> = {}): DeviceCheck => ({
  clientId: "device",
  platform: "ios",
  runtimeVersion: "rt-1",
  channel: "staging",
  currentUpdateId: undefined,
  embeddedUpdateId: undefined,
  servedUpdateId: undefined,
  country: undefined,
  city: undefined,
  decision: "none",
  reason: "no-update-for-runtime",
  fatalError: undefined,
  ...overrides,
});

// Every filter off: a search each test narrows one field at a time.
const anyDevice: DeviceQuery = {
  platform: undefined,
  runtimeVersion: undefined,
  channel: undefined,
  currentUpdateId: undefined,
  country: undefined,
  seenWithinMinutes: undefined,
  limit: 50,
};

describe.each(stores)("store contract over %s", (_, layer) => {
  const run = <A, E>(effect: Effect.Effect<A, E, UpdateStore>) =>
    Effect.runPromise(effect.pipe(Effect.provide(layer()), Effect.provide(TestClock.layer())));
  const seed = Effect.gen(function* () {
    const store = yield* UpdateStore;
    for (const hash of ["A".repeat(43), "B".repeat(43)]) {
      yield* store.insertAsset({ hash, contentType: "application/javascript", size: 1, compressedSize: null });
    }
    return store;
  });

  it("validates every publish before writing a branch or group", () =>
    run(
      Effect.gen(function* () {
        const store = yield* UpdateStore;
        for (const input of [
          { branch: "invalid", updates: {} },
          { branch: "invalid", updates: { ios: bundle() } },
        ] satisfies PublishGroupInput[]) {
          const error = yield* Effect.flip(store.publishGroup(input));
          expect(error._tag).toBe("BadRequest");
        }
        expect(yield* store.listBranches()).not.toContain("invalid");
        expect(yield* store.listGroups("invalid", { limit: 10 })).toEqual([]);
      }),
    ));

  it("blocks overlapping rollouts atomically and allows explicit recovery", () => run(Effect.gen(function* () {
    const store = yield* seed;
    yield* store.publishGroup({ branch: "staging", updates: { ios: bundle() } });
    const input = { branch: "staging", rolloutPercent: 10, updates: { ios: bundle("B".repeat(43)) } };
    const attempts = yield* Effect.all([Effect.result(store.publishGroup(input)), Effect.result(store.publishGroup(input))], { concurrency: 2 });
    expect(attempts.filter((result) => result._tag === "Success")).toHaveLength(1);
    expect(attempts.filter((result) => result._tag === "Failure")).toHaveLength(1);
    expect((yield* store.listGroups("staging", { limit: 10 }))).toHaveLength(2);
    expect((yield* Effect.flip(store.publishGroup({ branch: "staging", updates: { ios: bundle() } })))._tag).toBe("Conflict");
    const active = (yield* store.latestUpdates({ branch: "staging", platform: "ios", runtimeVersion: "rt-1", limit: 1 }))[0]!;
    expect((yield* Effect.flip(store.setRollout(active.groupId, 0)))._tag).toBe("Conflict");
    yield* store.setRollout(active.groupId, 100);
    yield* store.publishGroup(input);
    yield* store.publishGroup({ branch: "staging", updates: { ios: bundle() } }, { revert: true });
    yield* store.publishGroup(input);
    yield* store.publishGroup({ branch: "staging", updates: { ios: { runtimeVersion: "rt-1", rollbackToEmbedded: true } } });
  })));

  it("isolates active rollouts by branch, platform and runtime", () => run(Effect.gen(function* () {
    const store = yield* seed;
    yield* store.publishGroup({ branch: "staging", rolloutPercent: 10, updates: { ios: bundle() } });
    yield* store.publishGroup({ branch: "production", updates: { ios: bundle() } });
    yield* store.publishGroup({ branch: "staging", updates: { android: bundle() } });
    yield* store.publishGroup({ branch: "staging", updates: { ios: { ...bundle(), runtimeVersion: "rt-2" } } });
    expect((yield* Effect.flip(store.publishGroup({ branch: "staging", updates: { ios: bundle(), android: bundle() } })))._tag).toBe("Conflict");
  })));

  it("pages through every group when timestamps tie", () =>
    run(
      Effect.gen(function* () {
        const store = yield* seed;
        const published = [];
        for (let index = 0; index < 5; index++) {
          published.push(yield* store.publishGroup({ branch: "staging", updates: { ios: bundle() } }));
        }
        const first = yield* store.listGroups("staging", { limit: 2 });
        const second = yield* store.listGroups("staging", { limit: 2, before: first[1]!.id });
        const third = yield* store.listGroups("staging", { limit: 2, before: second[1]!.id });
        expect([...first, ...second, ...third].map((group) => group.id)).toEqual(
          published.reverse().map((group) => group.groupId),
        );
      }),
    ));

  it("finds the previous different bundle beyond ten republishes", () =>
    run(
      Effect.gen(function* () {
        const store = yield* seed;
        const previous = yield* store.publishGroup({ branch: "staging", updates: { ios: bundle() } });
        for (let index = 0; index < 12; index++) {
          yield* store.publishGroup({ branch: "staging", updates: { ios: bundle("B".repeat(43)) } });
        }
        expect((yield* store.rollbackTargets("staging"))[0]?.previous?.groupId).toBe(previous.groupId);
      }),
    ));

  it("counts only devices on channels linked to the rollback branch", () =>
    run(
      Effect.gen(function* () {
        const store = yield* seed;
        yield* store.publishGroup({ branch: "staging", updates: { ios: bundle() } });
        yield* store.setChannelBranch("beta", "staging");
        for (const channel of ["staging", "beta", "production", "unknown"]) {
          yield* store.recordCheck(check({ channel, clientId: channel }));
        }
        expect((yield* store.rollbackTargets("staging"))[0]?.devices).toBe(2);
      }),
    ));

  it("normalizes Expo update ids and clears stale served ids when the build changes", () =>
    run(
      Effect.gen(function* () {
        const store = yield* seed;
        const group = yield* store.publishGroup({ branch: "staging", updates: { ios: bundle() } });
        const updateId = group.updates[0]!.id;
        yield* store.recordCheck(check({ currentUpdateId: updateId.toUpperCase(), servedUpdateId: updateId }));
        expect((yield* store.metricsOverview()).updates).toEqual([
          { updateId, channel: "staging", running: 1, served: 1, faulty: 0 },
        ]);
        yield* store.recordCheck(check({ runtimeVersion: "rt-2" }));
        expect((yield* store.metricsOverview()).updates).toEqual([]);
      }),
    ));

  it("includes countries where every device failed to launch an update", () =>
    run(
      Effect.gen(function* () {
        const store = yield* seed;
        const group = yield* store.publishGroup({ branch: "staging", updates: { ios: bundle() } });
        const updateId = group.updates[0]!.id;
        yield* store.recordCheck(check({ country: "CA" }));
        yield* store.recordFailures({ clientId: "device", updateIds: [updateId], fatalError: "Launch failed" });
        expect((yield* store.metricsOverview()).segments).toEqual([{ updateId, country: "CA", running: 0, faulty: 1 }]);
      }),
    ));

  it("keeps the last answers a device got, newest first", () =>
    run(
      Effect.gen(function* () {
        const store = yield* UpdateStore;
        for (let index = 0; index < recentChecksKept + 5; index++) {
          yield* store.recordCheck(check({ fatalError: `crash-${index}` }));
        }
        const history = yield* store.recentChecks("device");
        expect(history).toHaveLength(recentChecksKept);
        expect(history.map((entry) => entry.fatalError)).toEqual(
          Array.from({ length: recentChecksKept }, (_, index) => `crash-${recentChecksKept + 4 - index}`),
        );
        expect(yield* store.recentChecks("never-seen")).toEqual([]);
      }),
    ));

  it("counts a run of identical answers instead of repeating it", () =>
    run(
      Effect.gen(function* () {
        const store = yield* UpdateStore;
        const first = DateTime.formatIso(yield* DateTime.now);
        for (let index = 0; index < 50; index++) {
          yield* store.recordCheck(check());
          yield* TestClock.adjust("1 minute");
        }
        yield* store.recordCheck(check({ decision: "manifest", reason: "manifest", servedUpdateId: "update" }));
        const history = yield* store.recentChecks("device");
        expect(history.map((entry) => [entry.reason, entry.checks])).toEqual([
          ["manifest", 1],
          ["no-update-for-runtime", 50],
        ]);
        expect(history[1]).toMatchObject({ firstCheckedAt: first });
        expect(history[1]!.lastCheckedAt > first).toBe(true);
      }),
    ));

  it("records the answer each check got beside the device it went to", () =>
    run(
      Effect.gen(function* () {
        const store = yield* seed;
        const group = yield* store.publishGroup({ branch: "staging", updates: { ios: bundle() } });
        const updateId = group.updates[0]!.id;
        yield* store.recordCheck(check({ decision: "manifest", reason: "manifest", servedUpdateId: updateId.toUpperCase(), country: "CA" }));
        const device = yield* store.deviceById("device");
        expect(device).toMatchObject({ clientId: "device", platform: "ios", channel: "staging", servedUpdateId: updateId, country: "CA" });
        expect(device!.firstSeenAt).toBe(device!.lastSeenAt);
        expect(yield* store.deviceById("never-seen")).toBeNull();
        expect((yield* store.recentChecks("device"))[0]).toMatchObject({
          decision: "manifest",
          reason: "manifest",
          servedUpdateId: updateId,
          currentUpdateId: null,
        });
      }),
    ));

  it("searches devices by any combination of what support is told", () =>
    run(
      Effect.gen(function* () {
        const store = yield* UpdateStore;
        const updateId = "abcdef00-0000-4000-8000-000000000001";
        yield* store.recordCheck(check({ clientId: "phone", country: "CA", currentUpdateId: updateId.toUpperCase() }));
        yield* store.recordCheck(check({ clientId: "tablet", platform: "android", channel: "production", runtimeVersion: "rt-2", country: "US" }));
        const ids = (query: Partial<DeviceQuery>) =>
          Effect.map(store.findDevices({ ...anyDevice, ...query }), (rows) => rows.map((row) => row.clientId));
        // Checks a tick apart share a timestamp, so the client id breaks the tie.
        expect(yield* ids({})).toEqual(["phone", "tablet"]);
        expect(yield* ids({ platform: "android" })).toEqual(["tablet"]);
        expect(yield* ids({ country: "ca" })).toEqual(["phone"]);
        expect(yield* ids({ runtimeVersion: "rt-2", channel: "production" })).toEqual(["tablet"]);
        expect(yield* ids({ platform: "ios", channel: "production" })).toEqual([]);
        expect(yield* ids({ currentUpdateId: updateId })).toEqual(["phone"]);
        expect(yield* ids({ limit: 1 })).toHaveLength(1);
        expect(yield* ids({ seenWithinMinutes: 10 })).toHaveLength(2);
        yield* TestClock.adjust("30 minutes");
        expect(yield* ids({ seenWithinMinutes: 10 })).toEqual([]);
        yield* store.recordCheck(check({ clientId: "phone" }));
        expect(yield* ids({ seenWithinMinutes: 10 })).toEqual(["phone"]);
      }),
    ));

  it("reads state when an effect runs and preserves immutable asset metadata", () =>
    run(
      Effect.gen(function* () {
        const store = yield* UpdateStore;
        const read = store.assetContentType("hash");
        yield* store.insertAsset({ hash: "hash", contentType: "first", size: 1, compressedSize: null });
        yield* store.insertAsset({ hash: "hash", contentType: "second", size: 1, compressedSize: null });
        expect(yield* read).toBe("first");
      }),
    ));
});
