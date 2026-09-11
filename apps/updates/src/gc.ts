import { Context, DateTime, Effect } from "effect";
import { AssetStore } from "./assets.ts";
import { UpdateStore } from "./store.ts";

// What a sweep keeps. Everything an update in the kept set references stays;
// bundles registered with native builds always stay.
export interface RetentionPolicy {
  // Newest published groups per branch that always keep their assets.
  readonly keepGroups: number;
  // Groups younger than this keep their assets whatever their position.
  readonly keepDays: number;
  // Updates a device reported running or receiving within this window keep
  // their assets, so a slow fleet is never cut off from what it runs. A device
  // is forgotten entirely well after this; see forgetDevicesAfterDays.
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
  readonly devices: number;
  readonly rounds: number;
}

// How long a silent install stays in the registry. Not only a storage bound:
// the devices table is the population adoption divides by, so this has to keep
// a dead install out of it without mistaking a seasonal app's quiet months for
// a lost fleet. A year clears any offseason and bounds the table by the live
// fleet rather than by every install ever seen. Forgetting is not destructive:
// the next check-in registers the device again.
const forgetDevicesAfterDays = 365;

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
  let deletedDevices = 0;
  let rounds = 0;
  // Its own round budget, so a backlog of forgotten devices cannot starve the
  // asset sweep below. Devices go first: the rows dropped here are the ones
  // the asset rules already ignore, so a partial run only leaves more to do.
  let deviceRounds = 0;
  const forgetSince = DateTime.formatIso(
    DateTime.subtract(now, { days: Math.max(forgetDevicesAfterDays, retention.deviceDays) }),
  );
  while (deviceRounds < maxRounds) {
    const clientIds = yield* store.unseenDevices(forgetSince, batch);
    if (clientIds.length === 0) break;
    deviceRounds++;
    yield* store.deleteDevices(clientIds);
    deletedDevices += clientIds.length;
    if (clientIds.length < batch) break;
  }
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
  const total = rounds + deviceRounds;
  yield* Effect.logInfo("Sweep finished", { assets: deletedAssets, patches: deletedPatches, devices: deletedDevices, rounds: total });
  return { assets: deletedAssets, patches: deletedPatches, devices: deletedDevices, rounds: total } satisfies SweepResult;
});
