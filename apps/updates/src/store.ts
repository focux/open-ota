import { Context, DateTime, Effect, Layer, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { StorageError } from "./errors.ts";
import {
  ExpoConfig,
  StoredAsset,
  type BundleUpdate,
  type Platform,
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

export interface UpdateStoreShape {
  readonly recordCheck: (check: DeviceCheck) => Effect.Effect<void, StorageError>;
  readonly recordFailures: (failure: UpdateFailure) => Effect.Effect<void, StorageError>;
  readonly metricsOverview: () => Effect.Effect<MetricsOverview, StorageError>;
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
  readonly setRollout: (groupId: string, percent: number) => Effect.Effect<boolean, StorageError>;
  readonly latestUpdates: (query: SelectionQuery) => Effect.Effect<ReadonlyArray<Update>, StorageError>;
  readonly assetContentType: (hash: string) => Effect.Effect<string | null, StorageError>;
  readonly missingAssets: (hashes: ReadonlyArray<string>) => Effect.Effect<ReadonlyArray<string>, StorageError>;
  readonly insertAsset: (asset: {
    readonly hash: string;
    readonly contentType: string;
    readonly size: number;
  }) => Effect.Effect<void, StorageError>;
  readonly publishGroup: (input: PublishGroupInput) => Effect.Effect<PublishedGroup, StorageError>;
  readonly insertPatch: (patch: {
    readonly baseHash: string;
    readonly targetHash: string;
    readonly size: number;
  }) => Effect.Effect<void, StorageError>;
  readonly hasPatch: (baseHash: string, targetHash: string) => Effect.Effect<boolean, StorageError>;
  // The launch asset hash of a published bundle update; null for anything else.
  readonly launchAssetHash: (updateId: string) => Effect.Effect<string | null, StorageError>;
  readonly recentLaunchAssets: (
    query: SelectionQuery,
  ) => Effect.Effect<ReadonlyArray<LaunchAssetRef>, StorageError>;
}

export class UpdateStore extends Context.Service<UpdateStore, UpdateStoreShape>()("expo-ota/UpdateStore") {
  static readonly layer = Layer.effect(UpdateStore, makeSqlStore());
  static readonly memory = () => Layer.sync(UpdateStore, makeMemoryStore);
}

const UpdateRow = Schema.Struct({
  id: Schema.String,
  group_id: Schema.String,
  branch_name: Schema.String,
  platform: Schema.Literals(["ios", "android"]),
  runtime_version: Schema.String,
  launch_asset: Schema.NullOr(Schema.fromJsonString(StoredAsset)),
  assets: Schema.NullOr(Schema.fromJsonString(Schema.Array(StoredAsset))),
  expo_config: Schema.NullOr(Schema.fromJsonString(ExpoConfig)),
  rollout_percent: Schema.Number,
  rollback_to_embedded: Schema.Number,
  created_at: Schema.String,
});

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
  if (row.rollback_to_embedded === 1 || row.launch_asset === null) {
    return { kind: "rollback", ...base };
  }
  return {
    kind: "bundle",
    ...base,
    launchAsset: row.launch_asset,
    assets: row.assets ?? [],
    expoConfig: row.expo_config ?? {},
  };
};

const storageFail = (message: string) => (cause: unknown) => new StorageError({ message, cause });

const decodeRows = Schema.decodeUnknownEffect(Schema.Array(UpdateRow));
const decodeLaunchAsset = Schema.decodeUnknownEffect(Schema.fromJsonString(StoredAsset));

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

const updateColumns = `u.id, u.group_id, g.branch_name, u.platform, u.runtime_version, u.launch_asset, u.assets,
               u.expo_config, u.rollout_percent, u.rollback_to_embedded, u.created_at`;

// Promote and roll back are the same write: the group's rows published again
// on a branch, under new ids, sharing the assets.
export const republishInput = (group: Group, branch: string, message: string): PublishGroupInput => {
  const bundle = group.updates.find((update) => update.kind === "bundle");
  const updates: { ios?: PlatformUpdateInput; android?: PlatformUpdateInput } = {};
  for (const update of group.updates) {
    updates[update.platform] =
      update.kind === "rollback"
        ? { runtimeVersion: update.runtimeVersion, rollbackToEmbedded: true }
        : { runtimeVersion: update.runtimeVersion, launchAsset: update.launchAsset, assets: update.assets };
  }
  return { branch, message, updates, ...(bundle === undefined ? {} : { expoConfig: bundle.expoConfig }) };
};

export const bundleInput = (update: BundleUpdate): PlatformUpdateInput => ({
  runtimeVersion: update.runtimeVersion,
  launchAsset: update.launchAsset,
  assets: update.assets,
});

const platformUpdates = (input: PublishGroupInput) =>
  (["ios", "android"] as const).flatMap((platform) => {
    const update = input.updates[platform];
    return update === undefined ? [] : [{ platform, update }];
  });

function makeSqlStore() {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    const branchForChannel = Effect.fn("UpdateStore.branchForChannel")(function* (channel: string) {
      const rows = yield* sql<{ branch_name: string }>`
        SELECT branch_name FROM channels WHERE name = ${channel}
      `.pipe(Effect.mapError(storageFail("Could not read the channel.")));
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

    const assetContentType = Effect.fn("UpdateStore.assetContentType")(function* (hash: string) {
      const rows = yield* sql<{ content_type: string }>`
        SELECT content_type FROM assets WHERE hash = ${hash}
      `.pipe(Effect.mapError(storageFail("Could not read the asset.")));
      return rows[0]?.content_type ?? null;
    });

    const missingAssets = Effect.fn("UpdateStore.missingAssets")(function* (hashes: ReadonlyArray<string>) {
      if (hashes.length === 0) return [];
      const rows = yield* sql<{ hash: string }>`
        SELECT hash FROM assets WHERE ${sql.in("hash", hashes)}
      `.pipe(Effect.mapError(storageFail("Could not read assets.")));
      const present = new Set(rows.map((row) => row.hash));
      return hashes.filter((hash) => !present.has(hash));
    });

    const insertAsset = Effect.fn("UpdateStore.insertAsset")(function* (asset: {
      readonly hash: string;
      readonly contentType: string;
      readonly size: number;
    }) {
      const now = DateTime.formatIso(yield* DateTime.now);
      yield* sql`
        INSERT OR IGNORE INTO assets (hash, content_type, size, created_at)
        VALUES (${asset.hash}, ${asset.contentType}, ${asset.size}, ${now})
      `.pipe(Effect.mapError(storageFail("Could not record the asset.")));
    });

    // D1 has no transactions. Rows are written first and become visible only
    // when published_at lands, so a failure half way leaves an invisible group.
    const publishGroup = Effect.fn("UpdateStore.publishGroup")(function* (input: PublishGroupInput) {
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
                  ${rollback ? null : JSON.stringify(input.expoConfig ?? {})},
                  ${input.rolloutPercent ?? 100}, ${rollback ? 1 : 0}, ${now})
        `.pipe(Effect.mapError(fail));
        published.push({ id, platform, runtimeVersion: update.runtimeVersion });
      }
      yield* sql`UPDATE update_groups SET published_at = ${now} WHERE id = ${groupId}`.pipe(Effect.mapError(fail));
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

    const hasPatch = Effect.fn("UpdateStore.hasPatch")(function* (baseHash: string, targetHash: string) {
      const rows = yield* sql`
        SELECT 1 AS one FROM patches WHERE base_hash = ${baseHash} AND target_hash = ${targetHash}
      `.pipe(Effect.mapError(storageFail("Could not read the patch.")));
      return rows.length > 0;
    });

    const launchAssetHash = Effect.fn("UpdateStore.launchAssetHash")(function* (updateId: string) {
      const rows = yield* sql<{ launch_asset: string }>`
        SELECT u.launch_asset
        FROM updates u
        JOIN update_groups g ON g.id = u.group_id
        WHERE u.id = ${updateId}
          AND g.published_at IS NOT NULL
          AND u.rollback_to_embedded = 0
          AND u.launch_asset IS NOT NULL
      `.pipe(Effect.mapError(storageFail("Could not read the update.")));
      const stored = rows[0]?.launch_asset;
      if (stored === undefined) return null;
      const asset = yield* decodeLaunchAsset(stored).pipe(
        Effect.mapError(storageFail("A stored launch asset is invalid.")),
      );
      return asset.hash;
    });

    const recentLaunchAssets = Effect.fn("UpdateStore.recentLaunchAssets")(function* (query: SelectionQuery) {
      const rows = yield* sql<{ id: string; launch_asset: string }>`
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
      `.pipe(Effect.mapError(storageFail("Could not read the branch bundles.")));
      return yield* Effect.forEach(rows, (row) =>
        decodeLaunchAsset(row.launch_asset).pipe(Effect.map((asset) => ({ updateId: row.id, hash: asset.hash }))),
      ).pipe(Effect.mapError(storageFail("A stored launch asset is invalid.")));
    });

    const recordCheck = Effect.fn("UpdateStore.recordCheck")(function* (check: DeviceCheck) {
      const now = DateTime.formatIso(yield* DateTime.now);
      yield* sql`
        INSERT INTO devices (client_id, platform, runtime_version, channel, current_update_id, embedded_update_id,
                             served_update_id, country, city, first_seen_at, last_seen_at)
        VALUES (${check.clientId}, ${check.platform}, ${check.runtimeVersion}, ${check.channel},
                ${check.currentUpdateId ?? null}, ${check.embeddedUpdateId ?? null}, ${check.servedUpdateId ?? null},
                ${check.country ?? null}, ${check.city ?? null}, ${now}, ${now})
        ON CONFLICT (client_id) DO UPDATE SET
          platform = excluded.platform,
          runtime_version = excluded.runtime_version,
          channel = excluded.channel,
          current_update_id = excluded.current_update_id,
          embedded_update_id = excluded.embedded_update_id,
          served_update_id = COALESCE(excluded.served_update_id, devices.served_update_id),
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

    const metricsOverview = Effect.fn("UpdateStore.metricsOverview")(function* () {
      const fail = storageFail("Could not read metrics.");
      const since = DateTime.formatIso(DateTime.subtract(yield* DateTime.now, { minutes: 20 }));
      const online = yield* sql<{ count: number }>`
        SELECT COUNT(*) AS count FROM devices WHERE last_seen_at >= ${since}
      `.pipe(Effect.mapError(fail));
      const runtimes = yield* sql<{ channel: string; platform: Platform; runtime_version: string; devices: number }>`
        SELECT channel, platform, runtime_version, COUNT(*) AS devices FROM devices
        GROUP BY channel, platform, runtime_version ORDER BY channel, runtime_version DESC, platform
      `.pipe(Effect.mapError(fail));
      const running = yield* sql<{ update_id: string; count: number }>`
        SELECT current_update_id AS update_id, COUNT(*) AS count FROM devices
        WHERE current_update_id IS NOT NULL GROUP BY current_update_id
      `.pipe(Effect.mapError(fail));
      const served = yield* sql<{ update_id: string; count: number }>`
        SELECT served_update_id AS update_id, COUNT(*) AS count FROM devices
        WHERE served_update_id IS NOT NULL GROUP BY served_update_id
      `.pipe(Effect.mapError(fail));
      const faulty = yield* sql<{ update_id: string; count: number }>`
        SELECT update_id, COUNT(*) AS count FROM device_update_failures GROUP BY update_id
      `.pipe(Effect.mapError(fail));
      const failures = yield* sql<{ update_id: string; message: string; devices: number }>`
        SELECT update_id, fatal_error AS message, COUNT(*) AS devices FROM device_update_failures
        WHERE fatal_error IS NOT NULL GROUP BY update_id, fatal_error ORDER BY devices DESC, update_id LIMIT 50
      `.pipe(Effect.mapError(fail));
      const countries = yield* sql<{ country: string; devices: number }>`
        SELECT country, COUNT(*) AS devices FROM devices WHERE country IS NOT NULL
        GROUP BY country ORDER BY devices DESC, country LIMIT 100
      `.pipe(Effect.mapError(fail));
      const segments = yield* sql<{ update_id: string; country: string; running: number; faulty: number }>`
        SELECT d.current_update_id AS update_id, d.country,
               COUNT(*) AS running,
               (SELECT COUNT(*) FROM device_update_failures f JOIN devices fd ON fd.client_id = f.client_id
                 WHERE f.update_id = d.current_update_id AND fd.country = d.country) AS faulty
        FROM devices d
        WHERE d.current_update_id IS NOT NULL AND d.country IS NOT NULL
        GROUP BY d.current_update_id, d.country
        ORDER BY d.current_update_id, running DESC, d.country
      `.pipe(Effect.mapError(fail));
      return {
        online: online[0]?.count ?? 0,
        runtimes: runtimes.map((row) => ({
          channel: row.channel,
          platform: row.platform,
          runtimeVersion: row.runtime_version,
          devices: row.devices,
        })),
        updates: mergeCounts(running, served, faulty),
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
      const rows = yield* sql<{ name: string; branch_name: string; updated_at: string }>`
        SELECT name, branch_name, updated_at FROM channels ORDER BY name
      `.pipe(Effect.mapError(storageFail("Could not read channels.")));
      return rows.map((row) => ({ name: row.name, branch: row.branch_name, updatedAt: row.updated_at }));
    });

    const listBranches = Effect.fn("UpdateStore.listBranches")(function* () {
      const rows = yield* sql<{ name: string }>`SELECT name FROM branches ORDER BY name`.pipe(
        Effect.mapError(storageFail("Could not read branches.")),
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
      const updateRows = yield* sql`
        SELECT ${sql.literal(updateColumns)}
        FROM updates u
        JOIN update_groups g ON g.id = u.group_id
        WHERE ${sql.in(
          "u.group_id",
          groups.map((group) => group.id),
        )}
        ORDER BY u.platform
      `.pipe(Effect.mapError(storageFail("Could not read updates.")));
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
          ${page.before === undefined ? sql.literal("") : sql`AND created_at < ${page.before}`}
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
        SELECT * FROM (
          SELECT ${sql.literal(updateColumns)},
                 ROW_NUMBER() OVER (
                   PARTITION BY u.platform, u.runtime_version
                   ORDER BY u.created_at DESC, u.rowid DESC
                 ) AS position
          FROM updates u
          JOIN update_groups g ON g.id = u.group_id
          WHERE g.branch_name = ${branch} AND g.published_at IS NOT NULL
        ) WHERE position <= 10
        ORDER BY runtime_version DESC, platform, position
      `.pipe(Effect.mapError(storageFail("Could not read the branch history.")));
      const history = (yield* decodeRows(rows).pipe(Effect.mapError(storageFail("A stored update is invalid.")))).map(toUpdate);
      const counts = yield* sql<{ platform: Platform; runtime_version: string; devices: number }>`
        SELECT platform, runtime_version, COUNT(*) AS devices FROM devices GROUP BY platform, runtime_version
      `.pipe(Effect.mapError(storageFail("Could not count devices.")));
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
      const exists = yield* sql`SELECT 1 AS one FROM update_groups WHERE id = ${groupId}`.pipe(Effect.mapError(fail));
      if (exists.length === 0) return false;
      yield* sql`UPDATE updates SET rollout_percent = ${percent} WHERE group_id = ${groupId}`.pipe(Effect.mapError(fail));
      return true;
    });

    return {
      recordCheck,
      recordFailures,
      metricsOverview,
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
      missingAssets,
      insertAsset,
      publishGroup,
      insertPatch,
      hasPatch,
      launchAssetHash,
      recentLaunchAssets,
    };
  });
}

// `history` is newest first, already limited to one branch.
const rollbackTargetsFrom = (
  history: ReadonlyArray<Update>,
  counts: ReadonlyArray<{ platform: Platform; runtimeVersion: string; devices: number }>,
): ReadonlyArray<RollbackTarget> => {
  const byTarget = new Map<string, Array<Update>>();
  for (const update of history) {
    const key = `${update.platform}/${update.runtimeVersion}`;
    byTarget.set(key, [...(byTarget.get(key) ?? []), update]);
  }
  return [...byTarget.values()].map((updates) => {
    const current = updates[0]!;
    return {
      platform: current.platform,
      runtimeVersion: current.runtimeVersion,
      current,
      previous: previousBundle(updates),
      devices:
        counts.find((row) => row.platform === current.platform && row.runtimeVersion === current.runtimeVersion)?.devices ?? 0,
    };
  });
};

type Counts = ReadonlyArray<{ update_id: string; count: number }>;

const mergeCounts = (running: Counts, served: Counts, faulty: Counts): MetricsOverview["updates"] => {
  const byId = new Map<string, { updateId: string; running: number; served: number; faulty: number }>();
  const entry = (id: string) =>
    byId.get(id) ?? byId.set(id, { updateId: id, running: 0, served: 0, faulty: 0 }).get(id)!;
  for (const row of running) entry(row.update_id).running = row.count;
  for (const row of served) entry(row.update_id).served = row.count;
  for (const row of faulty) entry(row.update_id).faulty = row.count;
  return [...byId.values()].sort((a, b) => a.updateId.localeCompare(b.updateId));
};

// The test double: same contract, arrays in a closure.
function makeMemoryStore(): UpdateStoreShape {
  const seeded = "2026-09-02T00:00:00.000Z";
  const branches = new Set(["staging", "production"]);
  const channels = new Map<string, Channel>([
    ["staging", { name: "staging", branch: "staging", updatedAt: seeded }],
    ["production", { name: "production", branch: "production", updatedAt: seeded }],
  ]);
  const assets = new Map<string, string>();
  const patches = new Set<string>();
  const groups: Array<Group> = [];
  const devices = new Map<string, DeviceCheck & { lastSeenAt: string }>();
  const failures = new Map<string, { clientId: string; updateId: string; fatalError: string | undefined }>();
  const updates = () => groups.flatMap((group) => group.updates);
  const newestFirst = (list: ReadonlyArray<Update>) => [...list].reverse();
  return {
    recordCheck: (check) =>
      Effect.gen(function* () {
        const previous = devices.get(check.clientId);
        devices.set(check.clientId, {
          ...check,
          servedUpdateId: check.servedUpdateId ?? previous?.servedUpdateId,
          country: check.country ?? previous?.country,
          city: check.city ?? previous?.city,
          lastSeenAt: DateTime.formatIso(yield* DateTime.now),
        });
      }),
    recordFailures: (failure) =>
      Effect.sync(() => {
        for (const updateId of failure.updateIds) {
          const key = `${failure.clientId}/${updateId}`;
          const fatalError = failure.fatalError ?? failures.get(key)?.fatalError;
          failures.set(key, { clientId: failure.clientId, updateId, fatalError });
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
        return {
          online: [...devices.values()].filter((row) => row.lastSeenAt >= since).length,
          runtimes: [...runtimes.values()].sort(
            (a, b) =>
              a.channel.localeCompare(b.channel) ||
              b.runtimeVersion.localeCompare(a.runtimeVersion) ||
              a.platform.localeCompare(b.platform),
          ),
          updates: mergeCounts(
            count(devices.values(), (row) => row.currentUpdateId),
            count(devices.values(), (row) => row.servedUpdateId),
            count(failures.values(), (row) => row.updateId),
          ),
          failures: [...messages.values()].sort((a, b) => b.devices - a.devices || a.updateId.localeCompare(b.updateId)),
          countries: count(devices.values(), (row) => row.country)
            .map(({ update_id, count }) => ({ country: update_id, devices: count }))
            .sort((a, b) => b.devices - a.devices || a.country.localeCompare(b.country)),
          segments: count(devices.values(), (row) =>
            row.currentUpdateId === undefined || row.country === undefined ? undefined : `${row.currentUpdateId}\n${row.country}`,
          )
            .map(({ update_id, count }) => {
              const [updateId, country] = update_id.split("\n") as [string, string];
              const faulty = [...failures.values()].filter(
                (failure) => failure.updateId === updateId && devices.get(failure.clientId)?.country === country,
              ).length;
              return { updateId, country, running: count, faulty };
            })
            .sort((a, b) => a.updateId.localeCompare(b.updateId) || b.running - a.running || a.country.localeCompare(b.country)),
        };
      }),
    branchForChannel: (channel) => Effect.succeed(channels.get(channel)?.branch ?? null),
    listChannels: () => Effect.succeed([...channels.values()].sort((a, b) => a.name.localeCompare(b.name))),
    listBranches: () => Effect.succeed([...branches].sort()),
    latestPerRuntime: () =>
      Effect.succeed(
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
      Effect.succeed(
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
      Effect.succeed(
        [...groups]
          .reverse()
          .filter((group) => group.branch === branch && (page.before === undefined || group.createdAt < page.before))
          .slice(0, page.limit),
      ),
    groupById: (id) => Effect.succeed(groups.find((group) => group.id === id) ?? null),
    rollbackTargets: (branch) =>
      Effect.sync(() => {
        const counts = new Map<string, { platform: Platform; runtimeVersion: string; devices: number }>();
        for (const row of devices.values()) {
          const key = `${row.platform}/${row.runtimeVersion}`;
          const current = counts.get(key) ?? { platform: row.platform, runtimeVersion: row.runtimeVersion, devices: 0 };
          counts.set(key, { ...current, devices: current.devices + 1 });
        }
        const history = newestFirst(updates().filter((update) => update.branch === branch)).sort(
          (a, b) => b.runtimeVersion.localeCompare(a.runtimeVersion) || a.platform.localeCompare(b.platform),
        );
        return rollbackTargetsFrom(history, [...counts.values()]);
      }),
    setChannelBranch: (channel, branch) =>
      Effect.gen(function* () {
        if (!branches.has(branch)) return false;
        channels.set(channel, { name: channel, branch, updatedAt: DateTime.formatIso(yield* DateTime.now) });
        return true;
      }),
    setRollout: (groupId, percent) =>
      Effect.sync(() => {
        const index = groups.findIndex((group) => group.id === groupId);
        if (index === -1) return false;
        const group = groups[index]!;
        groups[index] = { ...group, updates: group.updates.map((update) => ({ ...update, rolloutPercent: percent })) };
        return true;
      }),
    assetContentType: (hash) => Effect.succeed(assets.get(hash) ?? null),
    insertPatch: (patch) => Effect.sync(() => void patches.add(`${patch.baseHash}/${patch.targetHash}`)),
    hasPatch: (baseHash, targetHash) => Effect.succeed(patches.has(`${baseHash}/${targetHash}`)),
    launchAssetHash: (updateId) =>
      Effect.sync(() => {
        const update = updates().find((candidate) => candidate.id === updateId);
        return update === undefined || update.kind === "rollback" ? null : update.launchAsset.hash;
      }),
    recentLaunchAssets: (query) =>
      Effect.succeed(
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
    missingAssets: (hashes) => Effect.succeed(hashes.filter((hash) => !assets.has(hash))),
    insertAsset: (asset) => Effect.sync(() => void assets.set(asset.hash, asset.contentType)),
    publishGroup: (input) =>
      Effect.gen(function* () {
        const createdAt = DateTime.formatIso(yield* DateTime.now);
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
                  expoConfig: input.expoConfig ?? {},
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
