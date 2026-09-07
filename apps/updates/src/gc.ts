import { Context, DateTime, Effect } from "effect";
import { AssetStore } from "./assets.ts";
import { UpdateStore } from "./store.ts";

// What a sweep keeps. Everything an update in the kept set references stays;
// registered embedded bundles always stay.
export interface RetentionPolicy {
  // Newest published groups per branch that always keep their assets.
  readonly keepGroups: number;
  // Groups younger than this keep their assets whatever their position.
  readonly keepDays: number;
  // Updates a device reported running or receiving within this window keep
  // their assets, so a slow fleet is never cut off from what it runs.
  readonly deviceDays: number;
  // Assets uploaded or checked for presence this recently may belong to a
  // publish whose group has not landed yet.
  readonly uploadGraceHours: number;
}

export class Retention extends Context.Service<Retention, RetentionPolicy>()("expo-ota/Retention") {
  static readonly defaults: RetentionPolicy = { keepGroups: 20, keepDays: 30, deviceDays: 90, uploadGraceHours: 24 };
}

export interface SweepResult {
  readonly assets: number;
  readonly patches: number;
  readonly rounds: number;
}

// Objects go first, rows second: a row without an object is found again by
// the next sweep, an object without a row is unreachable and harmless.
export const sweep = Effect.fn("Gc.sweep")(function* (options: { readonly batch?: number; readonly maxRounds?: number } = {}) {
  const store = yield* UpdateStore;
  const assets = yield* AssetStore;
  const retention = yield* Retention;
  const batch = options.batch ?? 200;
  const maxRounds = options.maxRounds ?? 10;
  const now = yield* DateTime.now;
  const window = {
    keepGroups: retention.keepGroups,
    keepSince: DateTime.formatIso(DateTime.subtract(now, { days: retention.keepDays })),
    deviceSince: DateTime.formatIso(DateTime.subtract(now, { days: retention.deviceDays })),
    uploadGrace: DateTime.formatIso(DateTime.subtract(now, { hours: retention.uploadGraceHours })),
  };
  let deletedAssets = 0;
  let deletedPatches = 0;
  let rounds = 0;
  while (rounds < maxRounds) {
    const hashes = yield* store.unreferencedAssets(window, batch);
    if (hashes.length === 0) break;
    rounds++;
    const pairs = yield* store.patchesInvolving(hashes);
    yield* assets.delete([
      ...pairs.map((pair) => `patches/${pair.baseHash}/${pair.targetHash}`),
      ...hashes.map((hash) => `assets/${hash}`),
    ]);
    yield* store.deleteAssets(hashes);
    deletedAssets += hashes.length;
    deletedPatches += pairs.length;
    if (hashes.length < batch) break;
  }
  yield* Effect.logInfo("Sweep finished", { assets: deletedAssets, patches: deletedPatches, rounds });
  return { assets: deletedAssets, patches: deletedPatches, rounds } satisfies SweepResult;
});
