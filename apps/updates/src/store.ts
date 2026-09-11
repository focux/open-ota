import { Context, DateTime, Effect, Layer, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { BadRequest, Conflict, StorageError } from "./errors.ts";
import { DecisionKind, DecisionReason } from "./protocol.ts";
import {
  ExpoConfig,
  Percent,
  StoredAsset,
  type BundleUpdate,
  Distribution,
  Platform,
  type PlatformUpdateInput,
  type PublishGroupInput,
  type PublishedGroup,
  type Update,
} from "./model.ts";

export interface SelectionQuery {
  readonly branch: string;
  readonly platform: Platform;
  readonly runtimeVersion: string;
  readonly limit: number;
}

export interface LaunchAssetRef {
  readonly updateId: string;
  readonly hash: string;
}

export interface AssetInfo {
  readonly contentType: string;
  readonly size: number;
  // Gzip size measured at upload; null for assets stored before it was.
  readonly compressedSize: number | null;
}

export interface Build {
  readonly id: string;
  readonly embeddedUpdateId: string;
  readonly platform: Platform;
  readonly runtimeVersion: string;
  readonly profile: string;
  readonly distribution: Distribution;
  readonly channel: string | undefined;
  readonly launchAssetHash: string;
  // Whether CI may treat this build as proof that an OTA update is enough.
  // Deactivated builds keep their bundle for retention and patch bases.
  readonly active: boolean;
}

export interface BuildQuery {
  readonly platform: Platform;
  readonly runtimeVersion: string;
  readonly profile: string;
  readonly distribution: Distribution;
  readonly channel: string | undefined;
  readonly includeInactive: boolean;
}

export interface PatchBasesQuery extends SelectionQuery {
  // The bundle being published, which is never its own base.
  readonly exclude: string;
  // Devices that checked in since this count as the fleet.
  readonly fleetSince: string;
}

// A bundle worth diffing against, and why: devices run it, builds start from
// it, or it was published recently.
export interface PatchBase {
  readonly hash: string;
  readonly source: "fleet" | "embedded" | "recent";
  readonly updateId: string | null;
  readonly devices: number;
}

// A stored patch toward one bundle, with the updates whose devices can use it.
export interface PatchToward {
  readonly baseHash: string;
  readonly size: number;
  readonly createdAt: string;
  readonly bases: ReadonlyArray<{ readonly updateId: string; readonly embedded: boolean }>;
}

export interface PatchPair {
  readonly baseHash: string;
  readonly targetHash: string;
}

// The sweep's keep rules, resolved to timestamps by the caller.
export interface RetentionWindow {
  readonly keepGroups: number;
  readonly keepSince: string;
  readonly deviceSince: string;
  readonly uploadGrace: string;
}

export interface Channel {
  readonly name: string;
  readonly branch: string;
  readonly updatedAt: string;
}

export interface Group {
  readonly id: string;
  readonly branch: string;
  readonly message: string | null;
  readonly gitCommit: string | null;
  readonly actor: string | null;
  readonly createdAt: string;
  readonly updates: ReadonlyArray<Update>;
}

// One build in the field on a branch: what it is served now and what the
// last different bundle before that was.
export interface RollbackTarget {
  readonly platform: Platform;
  readonly runtimeVersion: string;
  readonly current: Update;
  readonly previous: BundleUpdate | null;
  readonly devices: number;
}

export interface DeviceCheck {
  readonly clientId: string;
  readonly platform: Platform;
  readonly runtimeVersion: string;
  readonly channel: string;
  readonly currentUpdateId: string | undefined;
  readonly embeddedUpdateId: string | undefined;
  // What this check answered with; a no-update answer keeps the previous value.
  readonly servedUpdateId: string | undefined;
  // From Cloudflare's request geolocation.
  readonly country: string | undefined;
  readonly city: string | undefined;
  // What the server answered and why: the thing support has to explain, so it
  // is kept per check and not only as the device's last state.
  readonly decision: DecisionKind;
  readonly reason: DecisionReason;
  // What the device reported crashing with on this check, if anything.
  readonly fatalError: string | undefined;
}

// The last-write-wins row: where a device is now.
export interface DeviceRecord {
  readonly clientId: string;
  readonly platform: Platform;
  readonly runtimeVersion: string;
  readonly channel: string;
  readonly currentUpdateId: string | null;
  readonly embeddedUpdateId: string | null;
  readonly servedUpdateId: string | null;
  readonly country: string | null;
  readonly city: string | null;
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
}

// One entry of the ring: an answer the device got, newest first when read. A
// run of identical answers is one entry, counted rather than repeated.
export interface DeviceCheckEntry {
  readonly firstCheckedAt: string;
  readonly lastCheckedAt: string;
  readonly checks: number;
  readonly platform: Platform;
  readonly runtimeVersion: string;
  readonly channel: string;
  readonly currentUpdateId: string | null;
  readonly embeddedUpdateId: string | null;
  readonly decision: DecisionKind;
  readonly reason: DecisionReason;
  readonly servedUpdateId: string | null;
  readonly fatalError: string | null;
}

// Every filter is optional: support searches with whatever the user could say.
export interface DeviceQuery {
  readonly platform: Platform | undefined;
  readonly runtimeVersion: string | undefined;
  readonly channel: string | undefined;
  readonly currentUpdateId: string | undefined;
  readonly country: string | undefined;
  // Only devices that checked in this recently.
  readonly seenWithinMinutes: number | undefined;
  // The client id the previous page ended on, for the keyset below.
  readonly before: string | undefined;
  readonly limit: number;
}

export interface UpdateFailure {
  readonly clientId: string;
  readonly updateIds: ReadonlyArray<string>;
  readonly fatalError: string | undefined;
}

export interface MetricsOverview {
  // Devices that checked in during the last 20 minutes.
  readonly online: number;
  // Per channel, so drift is judged against the branch that channel is linked to.
  readonly runtimes: ReadonlyArray<{
    readonly channel: string;
    readonly platform: Platform;
    readonly runtimeVersion: string;
    readonly devices: number;
  }>;
  readonly updates: ReadonlyArray<{
    readonly updateId: string;
    // The channel the devices checked in on. A view scoped to one channel has
    // to divide the same population it counts, and two channels can point at
    // the same branch, so these are never pre-summed.
    readonly channel: string;
    // Who is on this update: launching it for bundles, on their build's
    // embedded JS for rollback rows.
    readonly running: number;
    readonly served: number;
    readonly faulty: number;
  }>;
  // Crash messages reported for an update, most common first.
  readonly failures: ReadonlyArray<{ readonly updateId: string; readonly message: string; readonly devices: number }>;
  readonly countries: ReadonlyArray<{ readonly country: string; readonly devices: number }>;
  // Per update and country, for segmenting adoption and health.
  readonly segments: ReadonlyArray<{
    readonly updateId: string;
    readonly country: string;
    readonly running: number;
    readonly faulty: number;
  }>;
}

// What every view of an update shows, defined here once so a group page, a
// branch table, and an API client cannot disagree about it.
export interface UpdateFigures {
  readonly updateId: string;
  // Devices on this update, wherever they check in from: launching it for a
  // bundle, back on their build's embedded JS for a rollback.
  readonly running: number;
  // Devices the server last handed this update. Above running means
  // downloaded and awaiting a relaunch.
  readonly served: number;
  // Devices that crashed on it at launch and rolled back.
  readonly faulty: number;
  // Devices on this platform and runtime checking in on a channel linked to
  // the update's branch: the devices the update can reach.
  readonly population: number;
}

export interface UpdateStoreShape {
  // Writes the device's current state and appends to its ring of recent checks.
  readonly recordCheck: (check: DeviceCheck) => Effect.Effect<void, StorageError>;
  readonly recordFailures: (failure: UpdateFailure) => Effect.Effect<void, StorageError>;
  readonly deviceById: (clientId: string) => Effect.Effect<DeviceRecord | null, StorageError>;
  // Newest first, at most `recentChecksKept` of them.
  readonly recentChecks: (clientId: string) => Effect.Effect<ReadonlyArray<DeviceCheckEntry>, StorageError>;
  // Devices matching every filter given, most recently seen first.
  readonly findDevices: (query: DeviceQuery) => Effect.Effect<ReadonlyArray<DeviceRecord>, StorageError>;
  // Client ids of devices that stopped checking in before `since`, oldest first.
  readonly unseenDevices: (since: string, limit: number) => Effect.Effect<ReadonlyArray<string>, StorageError>;
  // Forgets these devices: their checks, their reported failures, and the rows
  // themselves. A device that comes back is registered again by its next check.
  readonly deleteDevices: (clientIds: ReadonlyArray<string>) => Effect.Effect<void, StorageError>;
  readonly metricsOverview: () => Effect.Effect<MetricsOverview, StorageError>;
  readonly updateFigures: (updates: ReadonlyArray<Update>) => Effect.Effect<ReadonlyArray<UpdateFigures>, StorageError>;
  readonly branchForChannel: (channel: string) => Effect.Effect<string | null, StorageError>;
  readonly listChannels: () => Effect.Effect<ReadonlyArray<Channel>, StorageError>;
  readonly listBranches: () => Effect.Effect<ReadonlyArray<string>, StorageError>;
  // Newest published update per branch, platform and runtime version.
  readonly latestPerRuntime: () => Effect.Effect<ReadonlyArray<Update>, StorageError>;
  readonly listGroups: (
    branch: string,
    page: { readonly limit: number; readonly before?: string },
  ) => Effect.Effect<ReadonlyArray<Group>, StorageError>;
  readonly groupById: (id: string) => Effect.Effect<Group | null, StorageError>;
  readonly rollbackTargets: (branch: string) => Effect.Effect<ReadonlyArray<RollbackTarget>, StorageError>;
  // False when the branch does not exist. Creates the channel when missing.
  readonly setChannelBranch: (channel: string, branch: string) => Effect.Effect<boolean, StorageError>;
  readonly setRollout: (groupId: string, percent: number) => Effect.Effect<boolean, Conflict | StorageError>;
  readonly latestUpdates: (query: SelectionQuery) => Effect.Effect<ReadonlyArray<Update>, StorageError>;
  readonly assetContentType: (hash: string) => Effect.Effect<string | null, StorageError>;
  readonly assetInfo: (hash: string) => Effect.Effect<AssetInfo | null, StorageError>;
  readonly missingAssets: (hashes: ReadonlyArray<string>) => Effect.Effect<ReadonlyArray<string>, StorageError>;
  // Marks assets a publish is about to reference, so a sweep leaves them alone.
  readonly touchAssets: (hashes: ReadonlyArray<string>) => Effect.Effect<void, StorageError>;
  readonly insertAsset: (asset: {
    readonly hash: string;
    readonly contentType: string;
    readonly size: number;
    readonly compressedSize: number | null;
  }) => Effect.Effect<void, StorageError>;
  readonly publishGroup: (input: PublishGroupInput, options?: { readonly revert?: boolean }) => Effect.Effect<PublishedGroup, BadRequest | Conflict | StorageError>;
  readonly insertPatch: (patch: {
    readonly baseHash: string;
    readonly targetHash: string;
    readonly size: number;
  }) => Effect.Effect<void, StorageError>;
  // The stored size of the patch between two bundles; null when there is none.
  readonly patchSize: (baseHash: string, targetHash: string) => Effect.Effect<number | null, StorageError>;
  // The launch asset hash of a published bundle update or a registered
  // embedded update; null for anything else.
  readonly launchAssetHash: (updateId: string) => Effect.Effect<string | null, StorageError>;
  readonly recentLaunchAssets: (
    query: SelectionQuery,
  ) => Effect.Effect<ReadonlyArray<LaunchAssetRef>, StorageError>;
  // Registering an embedded update id again updates and reactivates its build.
  readonly registerBuild: (build: Build) => Effect.Effect<Build, BadRequest | StorageError>;
  readonly findBuild: (query: BuildQuery) => Effect.Effect<Build | null, StorageError>;
  // Flips a build's eligibility; null when no build has that id.
  readonly setBuildActive: (id: string, active: boolean) => Effect.Effect<Build | null, StorageError>;
  readonly patchBases: (query: PatchBasesQuery) => Effect.Effect<ReadonlyArray<PatchBase>, StorageError>;
  readonly patchesToward: (targetHash: string) => Effect.Effect<ReadonlyArray<PatchToward>, StorageError>;
  readonly updateById: (id: string) => Effect.Effect<Update | null, StorageError>;
  // Assets nothing in the retention window references, oldest first.
  readonly unreferencedAssets: (window: RetentionWindow, limit: number) => Effect.Effect<ReadonlyArray<string>, StorageError>;
  readonly patchesInvolving: (hashes: ReadonlyArray<string>) => Effect.Effect<ReadonlyArray<PatchPair>, StorageError>;
  // Removes the rows for these assets and every patch touching them, and
  // marks the updates whose bundle is gone.
  readonly deleteAssets: (hashes: ReadonlyArray<string>) => Effect.Effect<void, StorageError>;
}

export class UpdateStore extends Context.Service<UpdateStore, UpdateStoreShape>()("expo-ota/UpdateStore") {
  static readonly layer = Layer.effect(UpdateStore, makeSqlStore());
  static readonly memory = () => Layer.sync(UpdateStore, makeMemoryStore);
}

const updateRowFields = {
  id: Schema.String,
  group_id: Schema.String,
  branch_name: Schema.String,
  platform: Platform,
  runtime_version: Schema.String,
  rollout_percent: Percent,
  created_at: Schema.String,
};

const UpdateRow = Schema.Union([
  Schema.Struct({
    ...updateRowFields,
    rollback_to_embedded: Schema.Literals([0]),
    launch_asset: Schema.fromJsonString(StoredAsset),
    assets: Schema.fromJsonString(Schema.Array(StoredAsset)),
    expo_config: Schema.fromJsonString(ExpoConfig),
  }),
  Schema.Struct({ ...updateRowFields, rollback_to_embedded: Schema.Literals([1]) }),
]);

const toUpdate = (row: typeof UpdateRow.Type): Update => {
  const base = {
    id: row.id,
    groupId: row.group_id,
    branch: row.branch_name,
    platform: row.platform,
    runtimeVersion: row.runtime_version,
    rolloutPercent: row.rollout_percent,
    createdAt: row.created_at,
  };
  if (row.rollback_to_embedded === 1) {
    return { kind: "rollback", ...base };
  }
  return {
    kind: "bundle",
    ...base,
    launchAsset: row.launch_asset,
    assets: row.assets,
    expoConfig: row.expo_config,
  };
};

const storageFail = (message: string) => (cause: unknown) => new StorageError({ message, cause });

// How many answers each device keeps: enough to see the transitions that
// explain it, short of being a request log.
export const recentChecksKept = 20;

// D1 rejects a statement with more than 100 bound parameters, so an `IN (...)`
// over a caller-sized list is asked one batch at a time. The margin under 100
// leaves room for the other bindings a query may carry.
const inBatchSize = 90;

const inBatches = <A>(values: ReadonlyArray<A>): ReadonlyArray<ReadonlyArray<A>> => {
  const batches: Array<ReadonlyArray<A>> = [];
  for (let index = 0; index < values.length; index += inBatchSize) {
    batches.push(values.slice(index, index + inBatchSize));
  }
  return batches;
};

const storedRows = <A, I>(schema: Schema.ConstraintCodec<A, I, never, unknown>) =>
  <E, R>(query: Effect.Effect<ReadonlyArray<unknown>, E, R>) => query.pipe(
    Effect.flatMap((rows) => Schema.decodeUnknownEffect(Schema.Array(schema))(rows).pipe(
      Effect.mapError(storageFail("A stored row is invalid.")),
    )),
  );

const decodeRows = Schema.decodeUnknownEffect(Schema.Array(UpdateRow));

const GroupRow = Schema.Struct({
  id: Schema.String,
  branch_name: Schema.String,
  message: Schema.NullOr(Schema.String),
  git_commit: Schema.NullOr(Schema.String),
  actor: Schema.NullOr(Schema.String),
  created_at: Schema.String,
});

// The previous good state of a build: the newest older bundle whose content
// differs from what is served now. A republish of the same bundle is skipped.
export const previousBundle = (history: ReadonlyArray<Update>): BundleUpdate | null => {
  const current = history[0];
  if (current === undefined) return null;
  const currentHash = current.kind === "bundle" ? current.launchAsset.hash : null;
  return history.slice(1).find((u): u is BundleUpdate => u.kind === "bundle" && u.launchAsset.hash !== currentHash) ?? null;
};
const decodeGroupRows = Schema.decodeUnknownEffect(Schema.Array(GroupRow));

const buildColumns = "id, embedded_update_id, platform, runtime_version, profile, distribution, channel, launch_asset_hash, active";
const BuildRow = Schema.Struct({
  id: Schema.String,
  embedded_update_id: Schema.String,
  platform: Platform,
  runtime_version: Schema.String,
  profile: Schema.String,
  distribution: Distribution,
  channel: Schema.NullOr(Schema.String),
  launch_asset_hash: Schema.String,
  active: Schema.Int,
});
const buildRows = <E, R>(query: Effect.Effect<ReadonlyArray<unknown>, E, R>): Effect.Effect<ReadonlyArray<Build>, E | StorageError, R> =>
  query.pipe(
    storedRows(BuildRow),
    Effect.map((rows) => rows.map((row) => ({
      id: row.id,
      embeddedUpdateId: row.embedded_update_id,
      platform: row.platform,
      runtimeVersion: row.runtime_version,
      profile: row.profile,
      distribution: row.distribution,
      channel: row.channel ?? undefined,
      launchAssetHash: row.launch_asset_hash,
      active: row.active === 1,
    }))),
  );

const updateColumns = `u.id, u.group_id, g.branch_name, u.platform, u.runtime_version, u.launch_asset, u.assets,
               u.expo_config, u.rollout_percent, u.rollback_to_embedded, u.created_at`;

// Promote and roll back are the same write: the group's rows published again
// on a branch, under new ids, sharing the assets.
export const republishInput = (group: Group, branch: string, message: string): PublishGroupInput => {
  const updates: { ios?: PlatformUpdateInput; android?: PlatformUpdateInput } = {};
  for (const update of group.updates) {
    updates[update.platform] =
      update.kind === "rollback"
        ? { runtimeVersion: update.runtimeVersion, rollbackToEmbedded: true }
        : bundleInput(update);
  }
  return { branch, message, updates, ...(group.gitCommit === null ? {} : { gitCommit: group.gitCommit }) };
};

export const bundleInput = (update: BundleUpdate): PlatformUpdateInput => ({
  runtimeVersion: update.runtimeVersion,
  launchAsset: update.launchAsset,
  assets: update.assets,
  expoConfig: update.expoConfig,
});

const platformUpdates = (input: PublishGroupInput) =>
  (["ios", "android"] as const).flatMap((platform) => {
    const update = input.updates[platform];
    return update === undefined ? [] : [{ platform, update }];
  });

const validatePublish = Effect.fn("UpdateStore.validatePublish")(function* (
  input: PublishGroupInput,
  missingAssets: UpdateStoreShape["missingAssets"],
) {
  const updates = platformUpdates(input);
  if (updates.length === 0) {
    return yield* Effect.fail(new BadRequest({ message: "At least one platform update is required." }));
  }
  const hashes = updates.flatMap(({ update }) =>
    "rollbackToEmbedded" in update ? [] : [update.launchAsset.hash, ...update.assets.map((asset) => asset.hash)],
  );
  const missing = yield* missingAssets([...new Set(hashes)]);
  if (missing.length > 0) {
    return yield* Effect.fail(new BadRequest({ message: `Assets not uploaded: ${missing.join(", ")}` }));
  }
});

const rolloutConflict = () => new Conflict({ message: "An active rollout already exists for this branch and build. Complete it at 100% or use Roll back before publishing another update." });
const isRevert = (input: PublishGroupInput, options?: { readonly revert?: boolean }) =>
  (input.rolloutPercent ?? 100) === 100 && (options?.revert === true || platformUpdates(input).every(({ update }) => "rollbackToEmbedded" in update));

function makeSqlStore() {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    const branchForChannel = Effect.fn("UpdateStore.branchForChannel")(function* (channel: string) {
      const rows = yield* sql`
        SELECT branch_name FROM channels WHERE name = ${channel}
      `.pipe(Effect.mapError(storageFail("Could not read the channel.")), storedRows(Schema.Struct({ branch_name: Schema.String })));
      return rows[0]?.branch_name ?? null;
    });

    const latestUpdates = Effect.fn("UpdateStore.latestUpdates")(function* (query: SelectionQuery) {
      const rows = yield* sql`
        SELECT u.id, u.group_id, g.branch_name, u.platform, u.runtime_version, u.launch_asset, u.assets,
               u.expo_config, u.rollout_percent, u.rollback_to_embedded, u.created_at
        FROM updates u
        JOIN update_groups g ON g.id = u.group_id
        WHERE g.branch_name = ${query.branch}
          AND g.published_at IS NOT NULL
          AND u.platform = ${query.platform}
          AND u.runtime_version = ${query.runtimeVersion}
        ORDER BY u.created_at DESC, u.rowid DESC
        LIMIT ${query.limit}
      `.pipe(Effect.mapError(storageFail("Could not read updates.")));
      const decoded = yield* decodeRows(rows).pipe(Effect.mapError(storageFail("A stored update is invalid.")));
      return decoded.map(toUpdate);
    });

    const assetInfo = Effect.fn("UpdateStore.assetInfo")(function* (hash: string) {
      const rows = yield* sql`
        SELECT content_type, size, compressed_size FROM assets WHERE hash = ${hash}
      `.pipe(Effect.mapError(storageFail("Could not read the asset.")), storedRows(AssetRow));
      const row = rows[0];
      return row === undefined ? null : { contentType: row.content_type, size: row.size, compressedSize: row.compressed_size };
    });

    const assetContentType = Effect.fn("UpdateStore.assetContentType")(function* (hash: string) {
      return (yield* assetInfo(hash))?.contentType ?? null;
    });

    const touchAssets = Effect.fn("UpdateStore.touchAssets")(function* (hashes: ReadonlyArray<string>) {
      const now = DateTime.formatIso(yield* DateTime.now);
      for (const batch of inBatches(hashes)) {
        yield* sql`
          UPDATE assets SET touched_at = ${now} WHERE ${sql.in("hash", batch)}
        `.pipe(Effect.mapError(storageFail("Could not touch assets.")));
      }
    });

    const missingAssets = Effect.fn("UpdateStore.missingAssets")(function* (hashes: ReadonlyArray<string>) {
      const present = new Set<string>();
      for (const batch of inBatches(hashes)) {
        const rows = yield* sql`
          SELECT hash FROM assets WHERE ${sql.in("hash", batch)}
        `.pipe(Effect.mapError(storageFail("Could not read assets.")), storedRows(Schema.Struct({ hash: Schema.String })));
        for (const row of rows) present.add(row.hash);
      }
      return hashes.filter((hash) => !present.has(hash));
    });

    const insertAsset = Effect.fn("UpdateStore.insertAsset")(function* (asset: {
      readonly hash: string;
      readonly contentType: string;
      readonly size: number;
      readonly compressedSize: number | null;
    }) {
      const now = DateTime.formatIso(yield* DateTime.now);
      yield* sql`
        INSERT OR IGNORE INTO assets (hash, content_type, size, compressed_size, created_at)
        VALUES (${asset.hash}, ${asset.contentType}, ${asset.size}, ${asset.compressedSize}, ${now})
      `.pipe(Effect.mapError(storageFail("Could not record the asset.")));
    });

    // D1 has no transactions. Rows are written first and become visible only
    // when published_at lands, so a failure half way leaves an invisible group.
    const publishGroup = Effect.fn("UpdateStore.publishGroup")(function* (input: PublishGroupInput, options?: { readonly revert?: boolean }) {
      yield* validatePublish(input, missingAssets);
      const now = DateTime.formatIso(yield* DateTime.now);
      const groupId = crypto.randomUUID();
      const fail = storageFail("Could not publish the update group.");
      yield* sql`INSERT OR IGNORE INTO branches (name, created_at) VALUES (${input.branch}, ${now})`.pipe(
        Effect.mapError(fail),
      );
      yield* sql`
        INSERT INTO update_groups (id, branch_name, message, git_commit, actor, created_at)
        VALUES (${groupId}, ${input.branch}, ${input.message ?? null}, ${input.gitCommit ?? null}, ${input.actor ?? null}, ${now})
      `.pipe(Effect.mapError(fail));
      const published: Array<PublishedGroup["updates"][number]> = [];
      for (const { platform, update } of platformUpdates(input)) {
        const id = crypto.randomUUID();
        const rollback = "rollbackToEmbedded" in update;
        yield* sql`
          INSERT INTO updates (id, group_id, platform, runtime_version, launch_asset, assets, expo_config,
                               rollout_percent, rollback_to_embedded, created_at)
          VALUES (${id}, ${groupId}, ${platform}, ${update.runtimeVersion},
                  ${rollback ? null : JSON.stringify(update.launchAsset)},
                  ${rollback ? null : JSON.stringify(update.assets)},
                  ${rollback ? null : JSON.stringify(update.expoConfig ?? input.expoConfig ?? {})},
                  ${input.rolloutPercent ?? 100}, ${rollback ? 1 : 0}, ${now})
        `.pipe(Effect.mapError(fail));
        published.push({ id, platform, runtimeVersion: update.runtimeVersion });
      }
      // One conditional statement is the visibility boundary, including concurrent publishers.
      const visible = yield* sql`
        UPDATE update_groups SET published_at = ${now}
        WHERE id = ${groupId} AND (${isRevert(input, options) ? 1 : 0} = 1 OR NOT EXISTS (
          SELECT 1 FROM updates incoming
          JOIN updates current ON current.platform = incoming.platform AND current.runtime_version = incoming.runtime_version
          JOIN update_groups current_group ON current_group.id = current.group_id
          WHERE incoming.group_id = ${groupId} AND current_group.branch_name = ${input.branch}
            AND current_group.published_at IS NOT NULL AND current.rollout_percent < 100
            AND NOT EXISTS (
              SELECT 1 FROM updates newer JOIN update_groups newer_group ON newer_group.id = newer.group_id
              WHERE newer_group.branch_name = current_group.branch_name AND newer_group.published_at IS NOT NULL
                AND newer.platform = current.platform AND newer.runtime_version = current.runtime_version
                AND (newer.created_at > current.created_at OR (newer.created_at = current.created_at AND newer.rowid > current.rowid))
            )
        )) RETURNING id
      `.pipe(Effect.mapError(fail), storedRows(Schema.Struct({ id: Schema.String })));
      if (visible.length === 0) return yield* rolloutConflict();
      return { groupId, updates: published };
    });

    const insertPatch = Effect.fn("UpdateStore.insertPatch")(function* (patch: {
      readonly baseHash: string;
      readonly targetHash: string;
      readonly size: number;
    }) {
      const now = DateTime.formatIso(yield* DateTime.now);
      yield* sql`
        INSERT OR IGNORE INTO patches (base_hash, target_hash, size, created_at)
        VALUES (${patch.baseHash}, ${patch.targetHash}, ${patch.size}, ${now})
      `.pipe(Effect.mapError(storageFail("Could not record the patch.")));
    });

    const patchSize = Effect.fn("UpdateStore.patchSize")(function* (baseHash: string, targetHash: string) {
      const rows = yield* sql`
        SELECT size FROM patches WHERE base_hash = ${baseHash} AND target_hash = ${targetHash}
      `.pipe(Effect.mapError(storageFail("Could not read the patch.")), storedRows(Schema.Struct({ size: Schema.Int })));
      return rows[0]?.size ?? null;
    });

    const launchAssetHash = Effect.fn("UpdateStore.launchAssetHash")(function* (updateId: string) {
      const rows = yield* sql`
        SELECT hash FROM (
          SELECT json_extract(u.launch_asset, '$.hash') AS hash
          FROM updates u
          JOIN update_groups g ON g.id = u.group_id
          WHERE u.id = ${updateId}
            AND g.published_at IS NOT NULL
            AND u.rollback_to_embedded = 0
            AND u.launch_asset IS NOT NULL
          UNION ALL
          SELECT launch_asset_hash AS hash FROM builds WHERE embedded_update_id = ${updateId}
        ) LIMIT 1
      `.pipe(Effect.mapError(storageFail("Could not read the update.")), storedRows(Schema.Struct({ hash: Schema.String })));
      return rows[0]?.hash ?? null;
    });

    const registerBuild = Effect.fn("UpdateStore.registerBuild")(function* (build: Build) {
      const missing = yield* missingAssets([build.launchAssetHash]);
      if (missing.length > 0) {
        return yield* Effect.fail(new BadRequest({ message: `Assets not uploaded: ${missing.join(", ")}` }));
      }
      const now = DateTime.formatIso(yield* DateTime.now);
      const registered = yield* sql`
        INSERT INTO builds (id, embedded_update_id, platform, runtime_version, launch_asset_hash, created_at, profile, distribution, channel, active)
        VALUES (${build.id}, ${build.embeddedUpdateId}, ${build.platform}, ${build.runtimeVersion}, ${build.launchAssetHash}, ${now}, ${build.profile}, ${build.distribution}, ${build.channel ?? null}, 1)
        ON CONFLICT (embedded_update_id) DO UPDATE SET
          platform = excluded.platform,
          runtime_version = excluded.runtime_version,
          launch_asset_hash = excluded.launch_asset_hash,
          profile = excluded.profile,
          distribution = excluded.distribution,
          channel = excluded.channel,
          active = 1
        RETURNING ${sql.literal(buildColumns)}
      `.pipe(Effect.mapError(storageFail("Could not register the build.")), buildRows);
      return registered[0]!;
    });

    const findBuild = Effect.fn("UpdateStore.findBuild")(function* (query: BuildQuery) {
      const channel = query.channel ?? null;
      const rows = yield* sql`
        SELECT ${sql.literal(buildColumns)}
        FROM builds
        WHERE platform = ${query.platform}
          AND runtime_version = ${query.runtimeVersion}
          AND profile = ${query.profile}
          AND distribution = ${query.distribution}
          AND (${channel} IS NULL OR channel = ${channel})
          AND (${query.includeInactive ? 1 : 0} = 1 OR active = 1)
        ORDER BY created_at DESC, id DESC
        LIMIT 1
      `.pipe(Effect.mapError(storageFail("Could not find the build.")), buildRows);
      return rows[0] ?? null;
    });

    const setBuildActive = Effect.fn("UpdateStore.setBuildActive")(function* (id: string, active: boolean) {
      const rows = yield* sql`
        UPDATE builds SET active = ${active ? 1 : 0} WHERE id = ${id}
        RETURNING ${sql.literal(buildColumns)}
      `.pipe(Effect.mapError(storageFail("Could not update the build.")), buildRows);
      return rows[0] ?? null;
    });

    // Fleet first, by how many devices on this platform and runtime run each
    // bundle, whatever branch serves them: patches are keyed by bundle, and a
    // bundle published here may be promoted to another branch, so its patches
    // should be ready for that branch's devices too. The branch's own devices
    // break ties. Then the embedded bundles of matching builds, then whatever
    // was published last on the branch. A bundle counts once even when it is
    // published under several update ids, as a promotion does.
    const patchBases = Effect.fn("UpdateStore.patchBases")(function* (query: PatchBasesQuery) {
      const fail = storageFail("Could not read the patch bases.");
      const fleet = yield* sql`
        SELECT h.hash, MAX(d.current_update_id) AS update_id, COUNT(*) AS devices,
          SUM(CASE WHEN c.branch_name = ${query.branch} THEN 1 ELSE 0 END) AS own
        FROM devices d
        JOIN channels c ON c.name = d.channel
        JOIN (
          SELECT u.id, json_extract(u.launch_asset, '$.hash') AS hash FROM updates u
          WHERE u.rollback_to_embedded = 0 AND u.launch_asset IS NOT NULL
          UNION ALL
          SELECT embedded_update_id AS id, launch_asset_hash AS hash FROM builds
        ) h ON h.id = d.current_update_id
        WHERE d.platform = ${query.platform}
          AND d.runtime_version = ${query.runtimeVersion} AND d.last_seen_at >= ${query.fleetSince}
        GROUP BY h.hash ORDER BY devices DESC, own DESC, h.hash LIMIT ${query.limit}
      `.pipe(Effect.mapError(fail), storedRows(Schema.Struct({ hash: Schema.String, update_id: Schema.String, devices: Schema.Int, own: Schema.Int })));
      const embedded = yield* sql`
        SELECT embedded_update_id AS update_id, launch_asset_hash AS hash FROM builds
        WHERE platform = ${query.platform} AND runtime_version = ${query.runtimeVersion}
        ORDER BY created_at DESC, update_id LIMIT ${query.limit}
      `.pipe(Effect.mapError(fail), storedRows(Schema.Struct({ update_id: Schema.String, hash: Schema.String })));
      const recent = yield* recentLaunchAssets({ ...query, limit: query.limit + 1 });
      return mergeBases(query, [
        ...fleet.map((row) => ({ hash: row.hash, source: "fleet" as const, updateId: row.update_id, devices: row.devices })),
        ...embedded.map((row) => ({ hash: row.hash, source: "embedded" as const, updateId: row.update_id, devices: 0 })),
        ...recent.map((row) => ({ hash: row.hash, source: "recent" as const, updateId: row.updateId, devices: 0 })),
      ]);
    });

    const patchesToward = Effect.fn("UpdateStore.patchesToward")(function* (targetHash: string) {
      const fail = storageFail("Could not read the patches.");
      const rows = yield* sql`
        SELECT base_hash, size, created_at FROM patches WHERE target_hash = ${targetHash}
        ORDER BY created_at DESC, base_hash
      `.pipe(Effect.mapError(fail), storedRows(Schema.Struct({ base_hash: Schema.String, size: Schema.Int, created_at: Schema.String })));
      const owners = new Map<string, Array<{ updateId: string; embedded: boolean }>>();
      for (const batch of inBatches(rows.map((row) => row.base_hash))) {
        const found = yield* sql`
          SELECT u.id, json_extract(u.launch_asset, '$.hash') AS hash, 0 AS embedded
          FROM updates u JOIN update_groups g ON g.id = u.group_id
          WHERE g.published_at IS NOT NULL AND u.rollback_to_embedded = 0
            AND json_extract(u.launch_asset, '$.hash') IN ${sql.in(batch)}
          UNION ALL
          SELECT embedded_update_id AS id, launch_asset_hash AS hash, 1 AS embedded FROM builds
          WHERE launch_asset_hash IN ${sql.in(batch)}
          ORDER BY embedded, id
        `.pipe(Effect.mapError(fail), storedRows(Schema.Struct({ id: Schema.String, hash: Schema.String, embedded: Schema.Int })));
        for (const row of found) {
          const list = owners.get(row.hash) ?? [];
          list.push({ updateId: row.id, embedded: row.embedded === 1 });
          owners.set(row.hash, list);
        }
      }
      return rows.map((row) => ({
        baseHash: row.base_hash,
        size: row.size,
        createdAt: row.created_at,
        bases: owners.get(row.base_hash) ?? [],
      }));
    });

    const updateById = Effect.fn("UpdateStore.updateById")(function* (id: string) {
      const rows = yield* sql`
        SELECT ${sql.literal(updateColumns)}
        FROM updates u JOIN update_groups g ON g.id = u.group_id
        WHERE u.id = ${id} AND g.published_at IS NOT NULL
      `.pipe(Effect.mapError(storageFail("Could not read the update.")));
      const decoded = yield* decodeRows(rows).pipe(Effect.mapError(storageFail("A stored update is invalid.")));
      return decoded.map(toUpdate)[0] ?? null;
    });

    const unreferencedAssets = Effect.fn("UpdateStore.unreferencedAssets")(function* (window: RetentionWindow, limit: number) {
      const rows = yield* sql`
        WITH kept_groups AS (
          SELECT id FROM (
            SELECT id, ROW_NUMBER() OVER (PARTITION BY branch_name ORDER BY created_at DESC, rowid DESC) AS position
            FROM update_groups WHERE published_at IS NOT NULL
          ) WHERE position <= ${window.keepGroups}
        ),
        retained AS (
          SELECT u.launch_asset, u.assets FROM updates u JOIN update_groups g ON g.id = u.group_id
          WHERE u.rollback_to_embedded = 0 AND (
            g.published_at IS NULL OR g.created_at >= ${window.keepSince} OR u.rollout_percent < 100
            OR g.id IN (SELECT id FROM kept_groups)
            OR u.id IN (SELECT current_update_id FROM devices WHERE current_update_id IS NOT NULL AND last_seen_at >= ${window.deviceSince})
            OR u.id IN (SELECT served_update_id FROM devices WHERE served_update_id IS NOT NULL AND last_seen_at >= ${window.deviceSince})
          )
        ),
        referenced AS (
          SELECT json_extract(launch_asset, '$.hash') AS hash FROM retained WHERE launch_asset IS NOT NULL
          UNION
          SELECT json_extract(item.value, '$.hash') AS hash FROM retained, json_each(retained.assets) AS item
          WHERE retained.assets IS NOT NULL
          UNION
          SELECT launch_asset_hash AS hash FROM builds
        )
        SELECT hash FROM assets
        WHERE created_at < ${window.uploadGrace}
          AND COALESCE(touched_at, created_at) < ${window.uploadGrace}
          AND hash NOT IN (SELECT hash FROM referenced)
        ORDER BY created_at, hash LIMIT ${limit}
      `.pipe(Effect.mapError(storageFail("Could not find unreferenced assets.")), storedRows(Schema.Struct({ hash: Schema.String })));
      return rows.map((row) => row.hash);
    });

    const patchesInvolving = Effect.fn("UpdateStore.patchesInvolving")(function* (hashes: ReadonlyArray<string>) {
      const fail = storageFail("Could not read the patches.");
      const pairs = new Map<string, PatchPair>();
      for (const batch of inBatches(hashes)) {
        for (const column of ["base_hash", "target_hash"] as const) {
          const rows = yield* sql`
            SELECT base_hash, target_hash FROM patches WHERE ${sql.in(column, batch)}
          `.pipe(Effect.mapError(fail), storedRows(Schema.Struct({ base_hash: Schema.String, target_hash: Schema.String })));
          for (const row of rows) {
            pairs.set(`${row.base_hash}/${row.target_hash}`, { baseHash: row.base_hash, targetHash: row.target_hash });
          }
        }
      }
      return [...pairs.values()];
    });

    const deleteAssets = Effect.fn("UpdateStore.deleteAssets")(function* (hashes: ReadonlyArray<string>) {
      const fail = storageFail("Could not delete assets.");
      const now = DateTime.formatIso(yield* DateTime.now);
      for (const batch of inBatches(hashes)) {
        yield* sql`DELETE FROM patches WHERE ${sql.in("base_hash", batch)}`.pipe(Effect.mapError(fail));
        yield* sql`DELETE FROM patches WHERE ${sql.in("target_hash", batch)}`.pipe(Effect.mapError(fail));
        yield* sql`
          UPDATE updates SET pruned_at = ${now}
          WHERE pruned_at IS NULL AND rollback_to_embedded = 0
            AND json_extract(launch_asset, '$.hash') IN ${sql.in(batch)}
        `.pipe(Effect.mapError(fail));
        yield* sql`DELETE FROM assets WHERE ${sql.in("hash", batch)}`.pipe(Effect.mapError(fail));
      }
    });

    const recentLaunchAssets = Effect.fn("UpdateStore.recentLaunchAssets")(function* (query: SelectionQuery) {
      const rows = yield* sql`
        SELECT u.id, u.launch_asset
        FROM updates u
        JOIN update_groups g ON g.id = u.group_id
        WHERE g.branch_name = ${query.branch}
          AND g.published_at IS NOT NULL
          AND u.platform = ${query.platform}
          AND u.runtime_version = ${query.runtimeVersion}
          AND u.rollback_to_embedded = 0
          AND u.launch_asset IS NOT NULL
        ORDER BY u.created_at DESC, u.rowid DESC
        LIMIT ${query.limit}
      `.pipe(Effect.mapError(storageFail("Could not read the branch bundles.")), storedRows(Schema.Struct({ id: Schema.String, launch_asset: Schema.fromJsonString(StoredAsset) })));
      return rows.map((row) => ({ updateId: row.id, hash: row.launch_asset.hash }));
    });

    const recordCheck = Effect.fn("UpdateStore.recordCheck")(function* (check: DeviceCheck) {
      const now = DateTime.formatIso(yield* DateTime.now);
      const fail = storageFail("Could not record the device check.");
      const current = check.currentUpdateId?.toLowerCase() ?? null;
      const embedded = check.embeddedUpdateId?.toLowerCase() ?? null;
      const served = check.servedUpdateId?.toLowerCase() ?? null;
      const fatalError = check.fatalError ?? null;
      // The common poll: the same answer as last time, absorbed by the newest
      // entry. `IS` rather than `=` so null columns compare.
      const repeated = yield* sql`
        UPDATE device_checks SET last_checked_at = ${now}, checks = checks + 1
        WHERE rowid = (
            SELECT rowid FROM device_checks WHERE client_id = ${check.clientId}
            ORDER BY last_checked_at DESC, rowid DESC LIMIT 1
          )
          AND platform = ${check.platform} AND runtime_version = ${check.runtimeVersion} AND channel = ${check.channel}
          AND current_update_id IS ${current} AND embedded_update_id IS ${embedded}
          AND decision = ${check.decision} AND reason = ${check.reason}
          AND served_update_id IS ${served} AND fatal_error IS ${fatalError}
        RETURNING rowid
      `.pipe(Effect.mapError(fail));
      if (repeated.length === 0) {
        yield* sql`
          INSERT INTO device_checks (client_id, first_checked_at, last_checked_at, checks, platform, runtime_version,
                                     channel, current_update_id, embedded_update_id, decision, reason,
                                     served_update_id, fatal_error)
          VALUES (${check.clientId}, ${now}, ${now}, 1, ${check.platform}, ${check.runtimeVersion},
                  ${check.channel}, ${current}, ${embedded}, ${check.decision}, ${check.reason}, ${served},
                  ${fatalError})
        `.pipe(Effect.mapError(fail));
        // Pruned on write, so the ring is only ever as long as its own writes
        // make it. Entries within one second keep their order by rowid.
        yield* sql`
          DELETE FROM device_checks WHERE client_id = ${check.clientId} AND rowid NOT IN (
            SELECT rowid FROM device_checks WHERE client_id = ${check.clientId}
            ORDER BY last_checked_at DESC, rowid DESC LIMIT ${recentChecksKept}
          )
        `.pipe(Effect.mapError(storageFail("Could not prune the device checks.")));
      }
      yield* sql`
        INSERT INTO devices (client_id, platform, runtime_version, channel, current_update_id, embedded_update_id,
                             served_update_id, country, city, first_seen_at, last_seen_at)
        VALUES (${check.clientId}, ${check.platform}, ${check.runtimeVersion}, ${check.channel},
                ${check.currentUpdateId?.toLowerCase() ?? null}, ${check.embeddedUpdateId?.toLowerCase() ?? null}, ${check.servedUpdateId?.toLowerCase() ?? null},
                ${check.country ?? null}, ${check.city ?? null}, ${now}, ${now})
        ON CONFLICT (client_id) DO UPDATE SET
          platform = excluded.platform,
          runtime_version = excluded.runtime_version,
          channel = excluded.channel,
          current_update_id = excluded.current_update_id,
          embedded_update_id = excluded.embedded_update_id,
          served_update_id = CASE
            WHEN excluded.platform = devices.platform AND excluded.runtime_version = devices.runtime_version
              AND excluded.channel = devices.channel
            THEN COALESCE(excluded.served_update_id, devices.served_update_id)
            ELSE excluded.served_update_id END,
          country = COALESCE(excluded.country, devices.country),
          city = COALESCE(excluded.city, devices.city),
          last_seen_at = excluded.last_seen_at
      `.pipe(Effect.mapError(storageFail("Could not record the device check.")));
    });

    const recordFailures = Effect.fn("UpdateStore.recordFailures")(function* (failure: UpdateFailure) {
      const now = DateTime.formatIso(yield* DateTime.now);
      for (const updateId of failure.updateIds) {
        yield* sql`
          INSERT INTO device_update_failures (client_id, update_id, fatal_error, first_seen_at, last_seen_at)
          VALUES (${failure.clientId}, ${updateId}, ${failure.fatalError ?? null}, ${now}, ${now})
          ON CONFLICT (client_id, update_id) DO UPDATE SET
            fatal_error = COALESCE(excluded.fatal_error, device_update_failures.fatal_error),
            last_seen_at = excluded.last_seen_at
        `.pipe(Effect.mapError(storageFail("Could not record the update failure.")));
      }
    });

    const deviceById = Effect.fn("UpdateStore.deviceById")(function* (clientId: string) {
      const rows = yield* sql`
        SELECT ${sql.literal(deviceColumns)} FROM devices WHERE client_id = ${clientId}
      `.pipe(Effect.mapError(storageFail("Could not read the device.")), storedRows(DeviceRow));
      const row = rows[0];
      return row === undefined ? null : toDeviceRecord(row);
    });

    const recentChecks = Effect.fn("UpdateStore.recentChecks")(function* (clientId: string) {
      const rows = yield* sql`
        SELECT first_checked_at, last_checked_at, checks, platform, runtime_version, channel, current_update_id,
               embedded_update_id, decision, reason, served_update_id, fatal_error
        FROM device_checks WHERE client_id = ${clientId}
        ORDER BY last_checked_at DESC, rowid DESC LIMIT ${recentChecksKept}
      `.pipe(Effect.mapError(storageFail("Could not read the device checks.")), storedRows(DeviceCheckRow));
      return rows.map((row) => ({
        firstCheckedAt: row.first_checked_at,
        lastCheckedAt: row.last_checked_at,
        checks: row.checks,
        platform: row.platform,
        runtimeVersion: row.runtime_version,
        channel: row.channel,
        currentUpdateId: row.current_update_id,
        embeddedUpdateId: row.embedded_update_id,
        decision: row.decision,
        reason: row.reason,
        servedUpdateId: row.served_update_id,
        fatalError: row.fatal_error,
      }));
    });

    const findDevices = Effect.fn("UpdateStore.findDevices")(function* (query: DeviceQuery) {
      const since =
        query.seenWithinMinutes === undefined
          ? undefined
          : DateTime.formatIso(DateTime.subtract(yield* DateTime.now, { minutes: query.seenWithinMinutes }));
      // Only the filters given become predicates: `(? IS NULL OR col = ?)`
      // reads better but leaves the planner unable to use any index, which on
      // this table means scanning the whole fleet.
      const clauses = [
        ...(query.platform === undefined ? [] : [sql`platform = ${query.platform}`]),
        ...(query.runtimeVersion === undefined ? [] : [sql`runtime_version = ${query.runtimeVersion}`]),
        ...(query.channel === undefined ? [] : [sql`channel = ${query.channel}`]),
        // Ids arrive in whatever case the client stored them; country is
        // Cloudflare's uppercase ISO code and support types either.
        ...(query.currentUpdateId === undefined ? [] : [sql`current_update_id = ${query.currentUpdateId.toLowerCase()}`]),
        ...(query.country === undefined ? [] : [sql`country = ${query.country.toUpperCase()}`]),
        ...(since === undefined ? [] : [sql`last_seen_at >= ${since}`]),
        // The keyset: rows ordered after the last device of the previous page.
        // An unknown cursor selects nothing, ending the paging.
        ...(query.before === undefined
          ? []
          : [sql`(last_seen_at, client_id) < (SELECT last_seen_at, client_id FROM devices WHERE client_id = ${query.before})`]),
      ];
      const rows = yield* sql`
        SELECT ${sql.literal(deviceColumns)} FROM devices
        ${clauses.length === 0 ? sql.literal("") : sql`WHERE ${sql.and(clauses)}`}
        ORDER BY last_seen_at DESC, client_id DESC
        LIMIT ${query.limit}
      `.pipe(Effect.mapError(storageFail("Could not search devices.")), storedRows(DeviceRow));
      return rows.map(toDeviceRecord);
    });

    const unseenDevices = Effect.fn("UpdateStore.unseenDevices")(function* (since: string, limit: number) {
      const rows = yield* sql`
        SELECT client_id FROM devices WHERE last_seen_at < ${since}
        ORDER BY last_seen_at, client_id LIMIT ${limit}
      `.pipe(Effect.mapError(storageFail("Could not find forgotten devices.")), storedRows(Schema.Struct({ client_id: Schema.String })));
      return rows.map((row) => row.client_id);
    });

    // Children first: a sweep that stops half way leaves a device row to find
    // again, never an unreachable check.
    const deleteDevices = Effect.fn("UpdateStore.deleteDevices")(function* (clientIds: ReadonlyArray<string>) {
      const fail = storageFail("Could not delete devices.");
      for (const batch of inBatches(clientIds)) {
        yield* sql`DELETE FROM device_checks WHERE ${sql.in("client_id", batch)}`.pipe(Effect.mapError(fail));
        yield* sql`DELETE FROM device_update_failures WHERE ${sql.in("client_id", batch)}`.pipe(Effect.mapError(fail));
        yield* sql`DELETE FROM devices WHERE ${sql.in("client_id", batch)}`.pipe(Effect.mapError(fail));
      }
    });

    const updateFigures = Effect.fn("UpdateStore.updateFigures")(function* (list: ReadonlyArray<Update>) {
      if (list.length === 0) return [];
      const fail = storageFail("Could not read the update figures.");
      const Count = Schema.Struct({ update_id: Schema.String, count: Schema.Int });
      const ids = [...new Set(list.map((update) => update.id))];
      const rollbackIds = list.filter((update) => update.kind === "rollback").map((update) => update.id);
      const running = new Map<string, number>();
      const served = new Map<string, number>();
      const faulty = new Map<string, number>();
      for (const batch of inBatches(ids)) {
        for (const row of yield* sql`
          SELECT current_update_id AS update_id, COUNT(*) AS count FROM devices
          WHERE current_update_id IN ${sql.in(batch)} GROUP BY current_update_id
        `.pipe(Effect.mapError(fail), storedRows(Count))) running.set(row.update_id, row.count);
        for (const row of yield* sql`
          SELECT served_update_id AS update_id, COUNT(*) AS count FROM devices
          WHERE served_update_id IN ${sql.in(batch)} GROUP BY served_update_id
        `.pipe(Effect.mapError(fail), storedRows(Count))) served.set(row.update_id, row.count);
        for (const row of yield* sql`
          SELECT update_id, COUNT(*) AS count FROM device_update_failures
          WHERE update_id IN ${sql.in(batch)} GROUP BY update_id
        `.pipe(Effect.mapError(fail), storedRows(Count))) faulty.set(row.update_id, row.count);
      }
      // No device launches a rollback row; the ones it sent back to their
      // embedded JS are the ones running it.
      for (const batch of inBatches(rollbackIds)) {
        for (const row of yield* sql`
          SELECT served_update_id AS update_id, COUNT(*) AS count FROM devices
          WHERE served_update_id IN ${sql.in(batch)} AND current_update_id = embedded_update_id
          GROUP BY served_update_id
        `.pipe(Effect.mapError(fail), storedRows(Count))) running.set(row.update_id, (running.get(row.update_id) ?? 0) + row.count);
      }
      const platforms = [...new Set(list.map((update) => update.platform))];
      const population = new Map<string, number>();
      for (const batch of inBatches([...new Set(list.map((update) => update.runtimeVersion))])) {
        const rows = yield* sql`
          SELECT c.branch_name AS branch, d.platform, d.runtime_version, COUNT(*) AS count
          FROM devices d JOIN channels c ON c.name = d.channel
          WHERE d.platform IN ${sql.in(platforms)} AND d.runtime_version IN ${sql.in(batch)}
          GROUP BY c.branch_name, d.platform, d.runtime_version
        `.pipe(Effect.mapError(fail), storedRows(Schema.Struct({
          branch: Schema.String, platform: Platform, runtime_version: Schema.String, count: Schema.Int,
        })));
        for (const row of rows) population.set(`${row.branch}\n${row.platform}\n${row.runtime_version}`, row.count);
      }
      return list.map((update) => ({
        updateId: update.id,
        running: running.get(update.id) ?? 0,
        served: served.get(update.id) ?? 0,
        faulty: faulty.get(update.id) ?? 0,
        population: population.get(`${update.branch}\n${update.platform}\n${update.runtimeVersion}`) ?? 0,
      }));
    });

    const metricsOverview = Effect.fn("UpdateStore.metricsOverview")(function* () {
      const fail = storageFail("Could not read metrics.");
      const since = DateTime.formatIso(DateTime.subtract(yield* DateTime.now, { minutes: 20 }));
      const online = yield* sql`
        SELECT COUNT(*) AS count FROM devices WHERE last_seen_at >= ${since}
      `.pipe(Effect.mapError(fail), storedRows(Schema.Struct({ count: Schema.Int })));
      const runtimes = yield* sql`
        SELECT channel, platform, runtime_version, COUNT(*) AS devices FROM devices
        GROUP BY channel, platform, runtime_version ORDER BY channel, runtime_version DESC, platform
      `.pipe(Effect.mapError(fail), storedRows(Schema.Struct({ channel: Schema.String, platform: Platform, runtime_version: Schema.String, devices: Schema.Int })));
      const running = yield* sql`
        SELECT current_update_id AS update_id, channel, COUNT(*) AS count FROM devices
        WHERE current_update_id IS NOT NULL GROUP BY current_update_id, channel
      `.pipe(Effect.mapError(fail), storedRows(CountRow));
      const served = yield* sql`
        SELECT served_update_id AS update_id, channel, COUNT(*) AS count FROM devices
        WHERE served_update_id IS NOT NULL GROUP BY served_update_id, channel
      `.pipe(Effect.mapError(fail), storedRows(CountRow));
      const faulty = yield* sql`
        SELECT f.update_id, d.channel, COUNT(*) AS count FROM device_update_failures f
        JOIN devices d ON d.client_id = f.client_id
        GROUP BY f.update_id, d.channel
      `.pipe(Effect.mapError(fail), storedRows(CountRow));
      // No device launches a rollback row, so its running count would always
      // be zero. Count the devices it sent back to embedded instead.
      const rollbackEmbedded = yield* sql`
        SELECT d.served_update_id AS update_id, d.channel, COUNT(*) AS count FROM devices d
        JOIN updates u ON u.id = d.served_update_id
        WHERE u.rollback_to_embedded = 1 AND d.current_update_id = d.embedded_update_id
        GROUP BY d.served_update_id, d.channel
      `.pipe(Effect.mapError(fail), storedRows(CountRow));
      const failures = yield* sql`
        SELECT update_id, fatal_error AS message, COUNT(*) AS devices FROM device_update_failures
        WHERE fatal_error IS NOT NULL GROUP BY update_id, fatal_error ORDER BY devices DESC, update_id LIMIT 50
      `.pipe(Effect.mapError(fail), storedRows(Schema.Struct({ update_id: Schema.String, message: Schema.String, devices: Schema.Int })));
      const countries = yield* sql`
        SELECT country, COUNT(*) AS devices FROM devices WHERE country IS NOT NULL
        GROUP BY country ORDER BY devices DESC, country LIMIT 100
      `.pipe(Effect.mapError(fail), storedRows(Schema.Struct({ country: Schema.String, devices: Schema.Int })));
      const segments = yield* sql`
        SELECT update_id, country, SUM(running) AS running, SUM(faulty) AS faulty FROM (
          SELECT current_update_id AS update_id, country, COUNT(*) AS running, 0 AS faulty
          FROM devices WHERE current_update_id IS NOT NULL AND country IS NOT NULL
          GROUP BY current_update_id, country
          UNION ALL
          SELECT f.update_id, d.country, 0 AS running, COUNT(*) AS faulty
          FROM device_update_failures f JOIN devices d ON d.client_id = f.client_id
          WHERE d.country IS NOT NULL GROUP BY f.update_id, d.country
        ) GROUP BY update_id, country ORDER BY update_id, running DESC, country
      `.pipe(Effect.mapError(fail), storedRows(Schema.Struct({ update_id: Schema.String, country: Schema.String, running: Schema.Int, faulty: Schema.Int })));
      return {
        online: online[0]?.count ?? 0,
        runtimes: runtimes.map((row) => ({
          channel: row.channel,
          platform: row.platform,
          runtimeVersion: row.runtime_version,
          devices: row.devices,
        })),
        updates: mergeCounts(sumCounts(running, rollbackEmbedded), served, faulty),
        failures: failures.map((row) => ({ updateId: row.update_id, message: row.message, devices: row.devices })),
        countries: countries.map((row) => ({ country: row.country, devices: row.devices })),
        segments: segments.map((row) => ({
          updateId: row.update_id,
          country: row.country,
          running: row.running,
          faulty: row.faulty,
        })),
      };
    });

    const listChannels = Effect.fn("UpdateStore.listChannels")(function* () {
      const rows = yield* sql`
        SELECT name, branch_name, updated_at FROM channels ORDER BY name
      `.pipe(Effect.mapError(storageFail("Could not read channels.")), storedRows(Schema.Struct({ name: Schema.String, branch_name: Schema.String, updated_at: Schema.String })));
      return rows.map((row) => ({ name: row.name, branch: row.branch_name, updatedAt: row.updated_at }));
    });

    const listBranches = Effect.fn("UpdateStore.listBranches")(function* () {
      const rows = yield* sql`SELECT name FROM branches ORDER BY name`.pipe(
        Effect.mapError(storageFail("Could not read branches.")),
        storedRows(Schema.Struct({ name: Schema.String })),
      );
      return rows.map((row) => row.name);
    });

    const latestPerRuntime = Effect.fn("UpdateStore.latestPerRuntime")(function* () {
      const rows = yield* sql`
        SELECT * FROM (
          SELECT ${sql.literal(updateColumns)},
                 ROW_NUMBER() OVER (
                   PARTITION BY g.branch_name, u.platform, u.runtime_version
                   ORDER BY u.created_at DESC, u.rowid DESC
                 ) AS position
          FROM updates u
          JOIN update_groups g ON g.id = u.group_id
          WHERE g.published_at IS NOT NULL
        ) WHERE position = 1
        ORDER BY branch_name, runtime_version DESC, platform
      `.pipe(Effect.mapError(storageFail("Could not read the latest updates.")));
      const decoded = yield* decodeRows(rows).pipe(Effect.mapError(storageFail("A stored update is invalid.")));
      return decoded.map(toUpdate);
    });

    const groupsFromRows = Effect.fn("UpdateStore.groupsFromRows")(function* (rows: ReadonlyArray<unknown>) {
      const groups = yield* decodeGroupRows(rows).pipe(Effect.mapError(storageFail("A stored group is invalid.")));
      if (groups.length === 0) return [];
      const updateRows: Array<unknown> = [];
      for (const batch of inBatches(groups.map((group) => group.id))) {
        const rows = yield* sql`
          SELECT ${sql.literal(updateColumns)}
          FROM updates u
          JOIN update_groups g ON g.id = u.group_id
          WHERE ${sql.in("u.group_id", batch)}
          ORDER BY u.platform
        `.pipe(Effect.mapError(storageFail("Could not read updates.")));
        updateRows.push(...rows);
      }
      const updates = (yield* decodeRows(updateRows).pipe(Effect.mapError(storageFail("A stored update is invalid.")))).map(toUpdate);
      return groups.map((group) => ({
        id: group.id,
        branch: group.branch_name,
        message: group.message,
        gitCommit: group.git_commit,
        actor: group.actor,
        createdAt: group.created_at,
        updates: updates.filter((update) => update.groupId === group.id),
      }));
    });

    const listGroups = Effect.fn("UpdateStore.listGroups")(function* (
      branch: string,
      page: { readonly limit: number; readonly before?: string },
    ) {
      const rows = yield* sql`
        SELECT id, branch_name, message, git_commit, actor, created_at FROM update_groups
        WHERE branch_name = ${branch} AND published_at IS NOT NULL
          ${page.before === undefined ? sql.literal("") : page.before.includes("T")
            ? sql`AND created_at < ${page.before}`
            : sql`AND (created_at, rowid) < (
                SELECT created_at, rowid FROM update_groups
                WHERE id = ${page.before} AND branch_name = ${branch} AND published_at IS NOT NULL
              )`}
        ORDER BY created_at DESC, rowid DESC
        LIMIT ${page.limit}
      `.pipe(Effect.mapError(storageFail("Could not read groups.")));
      return yield* groupsFromRows(rows);
    });

    const groupById = Effect.fn("UpdateStore.groupById")(function* (id: string) {
      const rows = yield* sql`
        SELECT id, branch_name, message, git_commit, actor, created_at FROM update_groups
        WHERE id = ${id} AND published_at IS NOT NULL
      `.pipe(Effect.mapError(storageFail("Could not read the group.")));
      return (yield* groupsFromRows(rows))[0] ?? null;
    });

    const rollbackTargets = Effect.fn("UpdateStore.rollbackTargets")(function* (branch: string) {
      const rows = yield* sql`
        WITH history AS (
          SELECT ${sql.literal(updateColumns)}, u.pruned_at,
                 ROW_NUMBER() OVER (
                   PARTITION BY u.platform, u.runtime_version
                   ORDER BY u.created_at DESC, u.rowid DESC
                 ) AS position
          FROM updates u
          JOIN update_groups g ON g.id = u.group_id
          WHERE g.branch_name = ${branch} AND g.published_at IS NOT NULL
        )
        SELECT * FROM history
        WHERE position = 1 OR id IN (
          SELECT (
            SELECT previous.id FROM history previous
            WHERE previous.platform = current.platform AND previous.runtime_version = current.runtime_version
              AND previous.position > 1 AND previous.rollback_to_embedded = 0 AND previous.pruned_at IS NULL
              AND (current.rollback_to_embedded = 1 OR
                json_extract(previous.launch_asset, '$.hash') != json_extract(current.launch_asset, '$.hash'))
            ORDER BY previous.position LIMIT 1
          ) FROM history current WHERE current.position = 1
        )
        ORDER BY runtime_version DESC, platform, position
      `.pipe(Effect.mapError(storageFail("Could not read the branch history.")));
      const history = (yield* decodeRows(rows).pipe(Effect.mapError(storageFail("A stored update is invalid.")))).map(toUpdate);
      const counts = yield* sql`
        SELECT d.platform, d.runtime_version, COUNT(*) AS devices FROM devices d
        JOIN channels c ON c.name = d.channel WHERE c.branch_name = ${branch}
        GROUP BY d.platform, d.runtime_version
      `.pipe(Effect.mapError(storageFail("Could not count devices.")), storedRows(Schema.Struct({ platform: Platform, runtime_version: Schema.String, devices: Schema.Int })));
      return rollbackTargetsFrom(history, counts.map((row) => ({ platform: row.platform, runtimeVersion: row.runtime_version, devices: row.devices })));
    });

    const setChannelBranch = Effect.fn("UpdateStore.setChannelBranch")(function* (channel: string, branch: string) {
      const fail = storageFail("Could not update the channel.");
      const exists = yield* sql`SELECT 1 AS one FROM branches WHERE name = ${branch}`.pipe(Effect.mapError(fail));
      if (exists.length === 0) return false;
      const now = DateTime.formatIso(yield* DateTime.now);
      yield* sql`
        INSERT INTO channels (name, branch_name, updated_at) VALUES (${channel}, ${branch}, ${now})
        ON CONFLICT (name) DO UPDATE SET branch_name = excluded.branch_name, updated_at = excluded.updated_at
      `.pipe(Effect.mapError(fail));
      return true;
    });

    const setRollout = Effect.fn("UpdateStore.setRollout")(function* (groupId: string, percent: number) {
      const fail = storageFail("Could not update the rollout.");
      const exists = yield* sql`SELECT 1 AS one FROM update_groups WHERE id = ${groupId} AND published_at IS NOT NULL`.pipe(Effect.mapError(fail));
      if (exists.length === 0) return false;
      const changed = yield* sql`
        UPDATE updates SET rollout_percent = ${percent}
        WHERE group_id = ${groupId} AND NOT EXISTS (
          SELECT 1 FROM updates other WHERE other.group_id = ${groupId} AND other.rollout_percent > ${percent}
        ) RETURNING id
      `.pipe(Effect.mapError(fail), storedRows(Schema.Struct({ id: Schema.String })));
      if (changed.length === 0) return yield* new Conflict({ message: "Rollouts can only increase. Use Roll back to revert an update." });
      return true;
    });

    return {
      recordCheck,
      recordFailures,
      deviceById,
      recentChecks,
      findDevices,
      unseenDevices,
      deleteDevices,
      metricsOverview,
      updateFigures,
      branchForChannel,
      listChannels,
      listBranches,
      latestPerRuntime,
      listGroups,
      groupById,
      rollbackTargets,
      setChannelBranch,
      setRollout,
      latestUpdates,
      assetContentType,
      assetInfo,
      missingAssets,
      touchAssets,
      insertAsset,
      publishGroup,
      insertPatch,
      patchSize,
      launchAssetHash,
      recentLaunchAssets,
      registerBuild,
      findBuild,
      setBuildActive,
      patchBases,
      patchesToward,
      updateById,
      unreferencedAssets,
      patchesInvolving,
      deleteAssets,
    };
  });
}

const AssetRow = Schema.Struct({
  content_type: Schema.String,
  size: Schema.Int,
  compressed_size: Schema.NullOr(Schema.Int),
});

const deviceColumns = `client_id, platform, runtime_version, channel, current_update_id, embedded_update_id,
               served_update_id, country, city, first_seen_at, last_seen_at`;

const DeviceRow = Schema.Struct({
  client_id: Schema.String,
  platform: Platform,
  runtime_version: Schema.String,
  channel: Schema.String,
  current_update_id: Schema.NullOr(Schema.String),
  embedded_update_id: Schema.NullOr(Schema.String),
  served_update_id: Schema.NullOr(Schema.String),
  country: Schema.NullOr(Schema.String),
  city: Schema.NullOr(Schema.String),
  first_seen_at: Schema.String,
  last_seen_at: Schema.String,
});

const toDeviceRecord = (row: typeof DeviceRow.Type): DeviceRecord => ({
  clientId: row.client_id,
  platform: row.platform,
  runtimeVersion: row.runtime_version,
  channel: row.channel,
  currentUpdateId: row.current_update_id,
  embeddedUpdateId: row.embedded_update_id,
  servedUpdateId: row.served_update_id,
  country: row.country,
  city: row.city,
  firstSeenAt: row.first_seen_at,
  lastSeenAt: row.last_seen_at,
});

const DeviceCheckRow = Schema.Struct({
  first_checked_at: Schema.String,
  last_checked_at: Schema.String,
  checks: Schema.Int,
  platform: Platform,
  runtime_version: Schema.String,
  channel: Schema.String,
  current_update_id: Schema.NullOr(Schema.String),
  embedded_update_id: Schema.NullOr(Schema.String),
  decision: DecisionKind,
  reason: DecisionReason,
  served_update_id: Schema.NullOr(Schema.String),
  fatal_error: Schema.NullOr(Schema.String),
});

// Keeps the first reason seen for each bundle, drops the target, caps the list.
const mergeBases = (query: PatchBasesQuery, candidates: ReadonlyArray<PatchBase>): ReadonlyArray<PatchBase> => {
  const seen = new Set<string>([query.exclude]);
  const bases: Array<PatchBase> = [];
  for (const candidate of candidates) {
    if (seen.has(candidate.hash)) continue;
    seen.add(candidate.hash);
    bases.push(candidate);
    if (bases.length === query.limit) break;
  }
  return bases;
};

// `history` is newest first, already limited to one branch.
const rollbackTargetsFrom = (
  history: ReadonlyArray<Update>,
  counts: ReadonlyArray<{ platform: Platform; runtimeVersion: string; devices: number }>,
  pruned: ReadonlySet<string> = new Set(),
): ReadonlyArray<RollbackTarget> => {
  const byTarget = new Map<string, Array<Update>>();
  for (const update of history) {
    const key = `${update.platform}/${update.runtimeVersion}`;
    const target = byTarget.get(key);
    if (target === undefined) byTarget.set(key, [update]);
    else target.push(update);
  }
  return [...byTarget.values()].map((updates) => {
    const current = updates[0]!;
    return {
      platform: current.platform,
      runtimeVersion: current.runtimeVersion,
      current,
      // A bundle the sweep deleted cannot be gone back to.
      previous: previousBundle(updates.filter((update, index) => index === 0 || !pruned.has(update.id))),
      devices:
        counts.find((row) => row.platform === current.platform && row.runtimeVersion === current.runtimeVersion)?.devices ?? 0,
    };
  });
};

// The memory store counts with one string key; these put the channel in it and
// take it back out, the same way the segment rows carry a country.
const keyed = (updateId: string | undefined, channel: string | undefined) =>
  updateId === undefined || channel === undefined ? undefined : `${updateId}\n${channel}`;

const perChannel = (rows: ReadonlyArray<{ update_id: string; count: number }>): Counts =>
  rows.map((row) => {
    const [update_id, channel] = row.update_id.split("\n") as [string, string];
    return { update_id, channel, count: row.count };
  });

const CountRow = Schema.Struct({ update_id: Schema.String, channel: Schema.String, count: Schema.Int });
type CountRow = typeof CountRow.Type;

type Counts = ReadonlyArray<CountRow>;

// Counts are per update *and* channel, so the key is both.
const countKey = (row: { readonly update_id: string; readonly channel: string }) => `${row.update_id}\n${row.channel}`;

const sumCounts = (...lists: ReadonlyArray<Counts>): Counts => {
  const byKey = new Map<string, CountRow>();
  for (const list of lists) {
    for (const row of list) {
      const current = byKey.get(countKey(row))?.count ?? 0;
      byKey.set(countKey(row), { update_id: row.update_id, channel: row.channel, count: current + row.count });
    }
  }
  return [...byKey.values()];
};

const mergeCounts = (running: Counts, served: Counts, faulty: Counts): MetricsOverview["updates"] => {
  const byKey = new Map<string, { updateId: string; channel: string; running: number; served: number; faulty: number }>();
  const entry = (row: CountRow) => {
    const key = countKey(row);
    let value = byKey.get(key);
    if (value === undefined) {
      value = { updateId: row.update_id, channel: row.channel, running: 0, served: 0, faulty: 0 };
      byKey.set(key, value);
    }
    return value;
  };
  for (const row of running) entry(row).running = row.count;
  for (const row of served) entry(row).served = row.count;
  for (const row of faulty) entry(row).faulty = row.count;
  return [...byKey.values()].sort(
    (a, b) => a.updateId.localeCompare(b.updateId) || a.channel.localeCompare(b.channel),
  );
};

// Newest check-in first, client id breaking a tie, both descending so one
// keyset covers them.
const newestSeenFirst = (
  a: { readonly lastSeenAt: string; readonly clientId: string },
  b: { readonly lastSeenAt: string; readonly clientId: string },
) => b.lastSeenAt.localeCompare(a.lastSeenAt) || b.clientId.localeCompare(a.clientId);

// Two entries the ring should hold as one: everything but when and how often.
const sameAnswer = (a: DeviceCheckEntry, b: DeviceCheckEntry) =>
  a.platform === b.platform &&
  a.runtimeVersion === b.runtimeVersion &&
  a.channel === b.channel &&
  a.currentUpdateId === b.currentUpdateId &&
  a.embeddedUpdateId === b.embeddedUpdateId &&
  a.decision === b.decision &&
  a.reason === b.reason &&
  a.servedUpdateId === b.servedUpdateId &&
  a.fatalError === b.fatalError;

// The memory rows keep absent values as undefined; a device row reads them as
// null, the way a stored row comes back.
const memoryDeviceRecord = (
  clientId: string,
  row: DeviceCheck & { firstSeenAt: string; lastSeenAt: string },
): DeviceRecord => ({
  clientId,
  platform: row.platform,
  runtimeVersion: row.runtimeVersion,
  channel: row.channel,
  currentUpdateId: row.currentUpdateId ?? null,
  embeddedUpdateId: row.embeddedUpdateId ?? null,
  servedUpdateId: row.servedUpdateId ?? null,
  country: row.country ?? null,
  city: row.city ?? null,
  firstSeenAt: row.firstSeenAt,
  lastSeenAt: row.lastSeenAt,
});

// The test double: same contract, arrays in a closure.
function makeMemoryStore(): UpdateStoreShape {
  const seeded = "2026-09-02T00:00:00.000Z";
  const branches = new Set(["staging", "production"]);
  const channels = new Map<string, Channel>([
    ["staging", { name: "staging", branch: "staging", updatedAt: seeded }],
    ["production", { name: "production", branch: "production", updatedAt: seeded }],
  ]);
  const assets = new Map<string, AssetInfo & { createdAt: string; touchedAt: string | undefined }>();
  const patches = new Map<string, number>();
  const builds = new Map<string, Build>();
  const pruned = new Set<string>();
  const groups: Array<Group> = [];
  const devices = new Map<string, DeviceCheck & { firstSeenAt: string; lastSeenAt: string }>();
  const deviceChecks = new Map<string, Array<DeviceCheckEntry>>();
  const failures = new Map<string, { clientId: string; updateId: string; fatalError: string | undefined }>();
  const updates = () => groups.flatMap((group) => group.updates);
  const newestFirst = (list: ReadonlyArray<Update>) => [...list].reverse();
  return {
    recordCheck: (check) =>
      Effect.gen(function* () {
        const previous = devices.get(check.clientId);
        const now = DateTime.formatIso(yield* DateTime.now);
        devices.set(check.clientId, {
          ...check,
          currentUpdateId: check.currentUpdateId?.toLowerCase(),
          embeddedUpdateId: check.embeddedUpdateId?.toLowerCase(),
          servedUpdateId: check.servedUpdateId?.toLowerCase() ?? (
            previous?.platform === check.platform && previous.runtimeVersion === check.runtimeVersion && previous.channel === check.channel
              ? previous.servedUpdateId : undefined
          ),
          country: check.country ?? previous?.country,
          city: check.city ?? previous?.city,
          firstSeenAt: previous?.firstSeenAt ?? now,
          lastSeenAt: now,
        });
        const ring = deviceChecks.get(check.clientId) ?? [];
        const entry: DeviceCheckEntry = {
          firstCheckedAt: now,
          lastCheckedAt: now,
          checks: 1,
          platform: check.platform,
          runtimeVersion: check.runtimeVersion,
          channel: check.channel,
          currentUpdateId: check.currentUpdateId?.toLowerCase() ?? null,
          embeddedUpdateId: check.embeddedUpdateId?.toLowerCase() ?? null,
          decision: check.decision,
          reason: check.reason,
          servedUpdateId: check.servedUpdateId?.toLowerCase() ?? null,
          fatalError: check.fatalError ?? null,
        };
        const newest = ring[0];
        deviceChecks.set(
          check.clientId,
          newest !== undefined && sameAnswer(newest, entry)
            ? [{ ...newest, lastCheckedAt: now, checks: newest.checks + 1 }, ...ring.slice(1)]
            : [entry, ...ring].slice(0, recentChecksKept),
        );
      }),
    recordFailures: (failure) =>
      Effect.sync(() => {
        for (const updateId of failure.updateIds) {
          const key = `${failure.clientId}/${updateId}`;
          const fatalError = failure.fatalError ?? failures.get(key)?.fatalError;
          failures.set(key, { clientId: failure.clientId, updateId, fatalError });
        }
      }),
    deviceById: (clientId) => Effect.sync(() => {
      const row = devices.get(clientId);
      return row === undefined ? null : memoryDeviceRecord(clientId, row);
    }),
    recentChecks: (clientId) => Effect.sync(() => deviceChecks.get(clientId) ?? []),
    findDevices: (query) =>
      Effect.gen(function* () {
        const since =
          query.seenWithinMinutes === undefined
            ? undefined
            : DateTime.formatIso(DateTime.subtract(yield* DateTime.now, { minutes: query.seenWithinMinutes }));
        const currentUpdateId = query.currentUpdateId?.toLowerCase();
        const country = query.country?.toUpperCase();
        const ordered = [...devices]
          .map(([clientId, row]) => memoryDeviceRecord(clientId, row))
          .filter(
            (row) =>
              (query.platform === undefined || row.platform === query.platform) &&
              (query.runtimeVersion === undefined || row.runtimeVersion === query.runtimeVersion) &&
              (query.channel === undefined || row.channel === query.channel) &&
              (currentUpdateId === undefined || row.currentUpdateId === currentUpdateId) &&
              (country === undefined || row.country === country) &&
              (since === undefined || row.lastSeenAt >= since),
          )
          .sort(newestSeenFirst);
        if (query.before === undefined) return ordered.slice(0, query.limit);
        // A cursor naming a device that is gone ends the paging, which is what
        // the row comparison against an empty subquery does in SQL.
        const cursor = devices.get(query.before);
        if (cursor === undefined) return [];
        const key = { lastSeenAt: cursor.lastSeenAt, clientId: query.before };
        return ordered.filter((row) => newestSeenFirst(row, key) > 0).slice(0, query.limit);
      }),
    unseenDevices: (since, limit) =>
      Effect.sync(() =>
        [...devices]
          .map(([clientId, row]) => ({ clientId, lastSeenAt: row.lastSeenAt }))
          .filter((row) => row.lastSeenAt < since)
          .sort((a, b) => a.lastSeenAt.localeCompare(b.lastSeenAt) || a.clientId.localeCompare(b.clientId))
          .slice(0, limit)
          .map((row) => row.clientId),
      ),
    deleteDevices: (clientIds) =>
      Effect.sync(() => {
        for (const clientId of clientIds) {
          devices.delete(clientId);
          deviceChecks.delete(clientId);
          for (const [key, failure] of failures) {
            if (failure.clientId === clientId) failures.delete(key);
          }
        }
      }),
    metricsOverview: () =>
      Effect.gen(function* () {
        const since = DateTime.formatIso(DateTime.subtract(yield* DateTime.now, { minutes: 20 }));
        const count = <Row>(rows: Iterable<Row>, key: (row: Row) => string | undefined) => {
          const counts = new Map<string, number>();
          for (const row of rows) {
            const id = key(row);
            if (id !== undefined) counts.set(id, (counts.get(id) ?? 0) + 1);
          }
          return [...counts].map(([update_id, count]) => ({ update_id, count }));
        };
        const runtimes = new Map<string, { channel: string; platform: Platform; runtimeVersion: string; devices: number }>();
        const rollbackIds = new Set(
          groups.flatMap((group) => group.updates).flatMap((update) => (update.kind === "rollback" ? [update.id] : [])),
        );
        for (const row of devices.values()) {
          const key = `${row.channel}/${row.platform}/${row.runtimeVersion}`;
          const current = runtimes.get(key) ?? {
            channel: row.channel,
            platform: row.platform,
            runtimeVersion: row.runtimeVersion,
            devices: 0,
          };
          runtimes.set(key, { ...current, devices: current.devices + 1 });
        }
        const messages = new Map<string, { updateId: string; message: string; devices: number }>();
        for (const failure of failures.values()) {
          if (failure.fatalError === undefined) continue;
          const key = `${failure.updateId}\n${failure.fatalError}`;
          const current = messages.get(key) ?? { updateId: failure.updateId, message: failure.fatalError, devices: 0 };
          messages.set(key, { ...current, devices: current.devices + 1 });
        }
        const segments = new Map<string, { updateId: string; country: string; running: number; faulty: number }>();
        const segment = (updateId: string, country: string) => {
          const key = `${updateId}\n${country}`;
          let value = segments.get(key);
          if (value === undefined) {
            value = { updateId, country, running: 0, faulty: 0 };
            segments.set(key, value);
          }
          return value;
        };
        for (const row of devices.values()) {
          if (row.currentUpdateId !== undefined && row.country !== undefined) {
            segment(row.currentUpdateId, row.country).running++;
          }
        }
        for (const failure of failures.values()) {
          const country = devices.get(failure.clientId)?.country;
          if (country !== undefined) segment(failure.updateId, country).faulty++;
        }
        return {
          online: [...devices.values()].filter((row) => row.lastSeenAt >= since).length,
          runtimes: [...runtimes.values()].sort(
            (a, b) =>
              a.channel.localeCompare(b.channel) ||
              b.runtimeVersion.localeCompare(a.runtimeVersion) ||
              a.platform.localeCompare(b.platform),
          ),
          updates: mergeCounts(
            sumCounts(
              perChannel(count(devices.values(), (row) => keyed(row.currentUpdateId, row.channel))),
              perChannel(
                count(devices.values(), (row) =>
                  row.servedUpdateId === undefined ||
                  !rollbackIds.has(row.servedUpdateId) ||
                  row.currentUpdateId === undefined ||
                  row.currentUpdateId !== row.embeddedUpdateId
                    ? undefined
                    : keyed(row.servedUpdateId, row.channel),
                ),
              ),
            ),
            perChannel(count(devices.values(), (row) => keyed(row.servedUpdateId, row.channel))),
            perChannel(
              count(failures.values(), (row) => keyed(row.updateId, devices.get(row.clientId)?.channel)),
            ),
          ),
          failures: [...messages.values()].sort((a, b) => b.devices - a.devices || a.updateId.localeCompare(b.updateId)),
          countries: count(devices.values(), (row) => row.country)
            .map(({ update_id, count }) => ({ country: update_id, devices: count }))
            .sort((a, b) => b.devices - a.devices || a.country.localeCompare(b.country)),
          segments: [...segments.values()].sort(
            (a, b) => a.updateId.localeCompare(b.updateId) || b.running - a.running || a.country.localeCompare(b.country),
          ),
        };
      }),
    updateFigures: (list) =>
      Effect.sync(() =>
        list.map((update) => {
          const branchOf = (channel: string) => channels.get(channel)?.branch;
          const rows = [...devices.values()];
          const onUpdate = rows.filter((row) =>
            update.kind === "rollback"
              ? row.servedUpdateId === update.id && row.currentUpdateId !== undefined && row.currentUpdateId === row.embeddedUpdateId
              : row.currentUpdateId === update.id,
          );
          return {
            updateId: update.id,
            running: onUpdate.length,
            served: rows.filter((row) => row.servedUpdateId === update.id).length,
            faulty: [...failures.values()].filter((row) => row.updateId === update.id).length,
            population: rows.filter(
              (row) =>
                row.platform === update.platform && row.runtimeVersion === update.runtimeVersion && branchOf(row.channel) === update.branch,
            ).length,
          };
        }),
      ),
    branchForChannel: (channel) => Effect.sync(() => channels.get(channel)?.branch ?? null),
    listChannels: () => Effect.sync(() => [...channels.values()].sort((a, b) => a.name.localeCompare(b.name))),
    listBranches: () => Effect.sync(() => [...branches].sort()),
    latestPerRuntime: () =>
      Effect.sync(() =>
        newestFirst(updates())
          .filter(
            (update, index, list) =>
              list.findIndex(
                (other) =>
                  other.branch === update.branch &&
                  other.platform === update.platform &&
                  other.runtimeVersion === update.runtimeVersion,
              ) === index,
          )
          .sort(
            (a, b) =>
              a.branch.localeCompare(b.branch) ||
              b.runtimeVersion.localeCompare(a.runtimeVersion) ||
              a.platform.localeCompare(b.platform),
          ),
      ),
    latestUpdates: (query) =>
      Effect.sync(() =>
        newestFirst(updates())
          .filter(
            (update) =>
              update.branch === query.branch &&
              update.platform === query.platform &&
              update.runtimeVersion === query.runtimeVersion,
          )
          .slice(0, query.limit),
      ),
    listGroups: (branch, page) =>
      Effect.sync(() =>
        [...groups]
          .reverse()
          .filter((group) => group.branch === branch && (page.before === undefined || (page.before.includes("T")
            ? group.createdAt < page.before
            : groups.indexOf(group) < groups.findIndex((cursor) => cursor.id === page.before && cursor.branch === branch))))
          .slice(0, page.limit),
      ),
    groupById: (id) => Effect.sync(() => groups.find((group) => group.id === id) ?? null),
    rollbackTargets: (branch) =>
      Effect.sync(() => {
        const counts = new Map<string, { platform: Platform; runtimeVersion: string; devices: number }>();
        for (const row of devices.values()) {
          if (channels.get(row.channel)?.branch !== branch) continue;
          const key = `${row.platform}/${row.runtimeVersion}`;
          const current = counts.get(key) ?? { platform: row.platform, runtimeVersion: row.runtimeVersion, devices: 0 };
          counts.set(key, { ...current, devices: current.devices + 1 });
        }
        const history = newestFirst(updates().filter((update) => update.branch === branch)).sort(
          (a, b) => b.runtimeVersion.localeCompare(a.runtimeVersion) || a.platform.localeCompare(b.platform),
        );
        return rollbackTargetsFrom(history, [...counts.values()], pruned);
      }),
    setChannelBranch: (channel, branch) =>
      Effect.gen(function* () {
        if (!branches.has(branch)) return false;
        channels.set(channel, { name: channel, branch, updatedAt: DateTime.formatIso(yield* DateTime.now) });
        return true;
      }),
    setRollout: Effect.fn("UpdateStore.setRollout")(function* (groupId, percent) {
        const index = groups.findIndex((group) => group.id === groupId);
        if (index === -1) return false;
        const group = groups[index]!;
        if (group.updates.some((update) => update.rolloutPercent > percent)) return yield* new Conflict({ message: "Rollouts can only increase. Use Roll back to revert an update." });
        groups[index] = { ...group, updates: group.updates.map((update) => ({ ...update, rolloutPercent: percent })) };
        return true;
      }),
    assetContentType: (hash) => Effect.sync(() => assets.get(hash)?.contentType ?? null),
    assetInfo: (hash) =>
      Effect.sync(() => {
        const info = assets.get(hash);
        return info === undefined ? null : { contentType: info.contentType, size: info.size, compressedSize: info.compressedSize };
      }),
    touchAssets: (hashes) =>
      Effect.gen(function* () {
        const now = DateTime.formatIso(yield* DateTime.now);
        for (const hash of hashes) {
          const info = assets.get(hash);
          if (info !== undefined) info.touchedAt = now;
        }
      }),
    insertPatch: (patch) => Effect.sync(() => {
      const key = `${patch.baseHash}/${patch.targetHash}`;
      if (!patches.has(key)) patches.set(key, patch.size);
    }),
    patchSize: (baseHash, targetHash) => Effect.sync(() => patches.get(`${baseHash}/${targetHash}`) ?? null),
    launchAssetHash: (updateId) =>
      Effect.sync(() => {
        const update = updates().find((candidate) => candidate.id === updateId);
        if (update !== undefined) return update.kind === "rollback" ? null : update.launchAsset.hash;
        return [...builds.values()].find((build) => build.embeddedUpdateId === updateId)?.launchAssetHash ?? null;
      }),
    registerBuild: (input) =>
      Effect.gen(function* () {
        if (!assets.has(input.launchAssetHash)) {
          return yield* Effect.fail(new BadRequest({ message: `Assets not uploaded: ${input.launchAssetHash}` }));
        }
        const existing = [...builds.values()].find((build) => build.embeddedUpdateId === input.embeddedUpdateId);
        const build = { ...input, id: existing?.id ?? input.id, active: true };
        builds.set(build.id, build);
        return build;
      }),
    findBuild: (query) =>
      Effect.sync(() => [...builds.values()].reverse().find((build) =>
        build.platform === query.platform &&
        build.runtimeVersion === query.runtimeVersion &&
        build.profile === query.profile &&
        build.distribution === query.distribution &&
        (query.channel === undefined || build.channel === query.channel) &&
        (query.includeInactive || build.active)
      ) ?? null),
    setBuildActive: (id, active) =>
      Effect.sync(() => {
        const existing = builds.get(id);
        if (existing === undefined) return null;
        const build = { ...existing, active };
        builds.set(id, build);
        return build;
      }),
    patchBases: (query) =>
      Effect.sync(() => {
        const hashOf = (updateId: string | undefined) => {
          if (updateId === undefined) return undefined;
          const update = updates().find((candidate) => candidate.id === updateId);
          if (update !== undefined) return update.kind === "bundle" ? update.launchAsset.hash : undefined;
          return [...builds.values()].find((build) => build.embeddedUpdateId === updateId)?.launchAssetHash;
        };
        // Same rule as the SQL store: every branch's devices on this platform
        // and runtime, one row per bundle, the branch's own devices as tiebreak.
        const fleet = new Map<string, { hash: string; updateId: string; devices: number; own: number }>();
        for (const device of devices.values()) {
          const branch = channels.get(device.channel)?.branch;
          if (
            branch === undefined ||
            device.platform !== query.platform ||
            device.runtimeVersion !== query.runtimeVersion ||
            device.lastSeenAt < query.fleetSince ||
            device.currentUpdateId === undefined
          ) continue;
          const hash = hashOf(device.currentUpdateId);
          if (hash === undefined) continue;
          const current = fleet.get(hash) ?? { hash, updateId: device.currentUpdateId, devices: 0, own: 0 };
          fleet.set(hash, {
            hash,
            updateId: device.currentUpdateId > current.updateId ? device.currentUpdateId : current.updateId,
            devices: current.devices + 1,
            own: current.own + (branch === query.branch ? 1 : 0),
          });
        }
        const embeddedBases = [...builds.values()]
          .filter((row) => row.platform === query.platform && row.runtimeVersion === query.runtimeVersion)
          .reverse()
          .map((row) => ({ hash: row.launchAssetHash, source: "embedded" as const, updateId: row.embeddedUpdateId, devices: 0 }));
        const recent = newestFirst(updates())
          .flatMap((update) =>
            update.kind === "bundle" && update.branch === query.branch && update.platform === query.platform && update.runtimeVersion === query.runtimeVersion
              ? [{ hash: update.launchAsset.hash, source: "recent" as const, updateId: update.id, devices: 0 }]
              : [],
          );
        return mergeBases(query, [
          ...[...fleet.values()]
            .sort((a, b) => b.devices - a.devices || b.own - a.own || a.hash.localeCompare(b.hash))
            .map((row) => ({ hash: row.hash, source: "fleet" as const, updateId: row.updateId, devices: row.devices })),
          ...embeddedBases,
          ...recent,
        ]);
      }),
    patchesToward: (targetHash) =>
      Effect.sync(() =>
        [...patches]
          .filter(([key]) => key.endsWith(`/${targetHash}`))
          .map(([key, size]) => {
            const baseHash = key.slice(0, key.indexOf("/"));
            return {
              baseHash,
              size,
              createdAt: seeded,
              bases: [
                ...updates().flatMap((update) => (update.kind === "bundle" && update.launchAsset.hash === baseHash ? [{ updateId: update.id, embedded: false }] : [])),
                ...[...builds.values()].flatMap((row) => (row.launchAssetHash === baseHash ? [{ updateId: row.embeddedUpdateId, embedded: true }] : [])),
              ],
            };
          }),
      ),
    updateById: (id) => Effect.sync(() => updates().find((update) => update.id === id) ?? null),
    unreferencedAssets: (window, limit) =>
      Effect.sync(() => {
        const kept = new Set<string>();
        const perBranch = new Map<string, number>();
        for (const group of [...groups].reverse()) {
          const count = perBranch.get(group.branch) ?? 0;
          if (count < window.keepGroups) kept.add(group.id);
          perBranch.set(group.branch, count + 1);
        }
        const deviceIds = new Set<string>();
        for (const device of devices.values()) {
          if (device.lastSeenAt < window.deviceSince) continue;
          if (device.currentUpdateId !== undefined) deviceIds.add(device.currentUpdateId);
          if (device.servedUpdateId !== undefined) deviceIds.add(device.servedUpdateId);
        }
        const referenced = new Set([...builds.values()].map((row) => row.launchAssetHash));
        for (const group of groups) {
          for (const update of group.updates) {
            if (update.kind !== "bundle") continue;
            if (group.createdAt >= window.keepSince || update.rolloutPercent < 100 || kept.has(group.id) || deviceIds.has(update.id)) {
              referenced.add(update.launchAsset.hash);
              for (const asset of update.assets) referenced.add(asset.hash);
            }
          }
        }
        return [...assets]
          .filter(([hash, info]) => info.createdAt < window.uploadGrace && (info.touchedAt ?? info.createdAt) < window.uploadGrace && !referenced.has(hash))
          .sort((a, b) => a[1].createdAt.localeCompare(b[1].createdAt) || a[0].localeCompare(b[0]))
          .slice(0, limit)
          .map(([hash]) => hash);
      }),
    patchesInvolving: (hashes) =>
      Effect.sync(() => {
        const wanted = new Set(hashes);
        return [...patches.keys()].flatMap((key) => {
          const [baseHash, targetHash] = key.split("/") as [string, string];
          return wanted.has(baseHash) || wanted.has(targetHash) ? [{ baseHash, targetHash }] : [];
        });
      }),
    deleteAssets: (hashes) =>
      Effect.sync(() => {
        const wanted = new Set(hashes);
        for (const key of [...patches.keys()]) {
          const [baseHash, targetHash] = key.split("/") as [string, string];
          if (wanted.has(baseHash) || wanted.has(targetHash)) patches.delete(key);
        }
        for (const update of updates()) {
          if (update.kind === "bundle" && wanted.has(update.launchAsset.hash)) pruned.add(update.id);
        }
        for (const hash of hashes) assets.delete(hash);
      }),
    recentLaunchAssets: (query) =>
      Effect.sync(() =>
        newestFirst(updates())
          .flatMap((update) =>
            update.kind === "bundle" &&
            update.branch === query.branch &&
            update.platform === query.platform &&
            update.runtimeVersion === query.runtimeVersion
              ? [{ updateId: update.id, hash: update.launchAsset.hash }]
              : [],
          )
          .slice(0, query.limit),
      ),
    missingAssets: (hashes) => Effect.sync(() => hashes.filter((hash) => !assets.has(hash))),
    insertAsset: (asset) =>
      Effect.gen(function* () {
        if (assets.has(asset.hash)) return;
        assets.set(asset.hash, {
          contentType: asset.contentType,
          size: asset.size,
          compressedSize: asset.compressedSize,
          createdAt: DateTime.formatIso(yield* DateTime.now),
          touchedAt: undefined,
        });
      }),
    publishGroup: Effect.fn("UpdateStore.publishGroup")(function* (input, options) {
        yield* validatePublish(input, (hashes) => Effect.sync(() => hashes.filter((hash) => !assets.has(hash))));
        const createdAt = DateTime.formatIso(yield* DateTime.now);
        if (!isRevert(input, options)) {
          for (const { platform, update } of platformUpdates(input)) {
            const current = newestFirst(updates()).find((candidate) => candidate.branch === input.branch && candidate.platform === platform && candidate.runtimeVersion === update.runtimeVersion);
            if (current && current.rolloutPercent < 100) return yield* rolloutConflict();
          }
        }
        const groupId = crypto.randomUUID();
        branches.add(input.branch);
        const published: Array<Update> = [];
        for (const { platform, update } of platformUpdates(input)) {
          const base = {
            id: crypto.randomUUID(),
            groupId,
            branch: input.branch,
            platform,
            runtimeVersion: update.runtimeVersion,
            rolloutPercent: input.rolloutPercent ?? 100,
            createdAt,
          };
          published.push(
            "rollbackToEmbedded" in update
              ? { kind: "rollback", ...base }
              : {
                  kind: "bundle",
                  ...base,
                  launchAsset: update.launchAsset,
                  assets: update.assets,
                  expoConfig: update.expoConfig ?? input.expoConfig ?? {},
                },
          );
        }
        groups.push({
          id: groupId,
          branch: input.branch,
          message: input.message ?? null,
          gitCommit: input.gitCommit ?? null,
          actor: input.actor ?? null,
          createdAt,
          updates: published,
        });
        return {
          groupId,
          updates: published.map((update) => ({
            id: update.id,
            platform: update.platform,
            runtimeVersion: update.runtimeVersion,
          })),
        };
      }),
  };
}
