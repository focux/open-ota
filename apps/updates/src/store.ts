import { Context, DateTime, Effect, Layer, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { BadRequest, Conflict, StorageError } from "./errors.ts";
import {
  ExpoConfig,
  Percent,
  StoredAsset,
  type BundleUpdate,
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
  readonly setRollout: (groupId: string, percent: number) => Effect.Effect<boolean, Conflict | StorageError>;
  readonly latestUpdates: (query: SelectionQuery) => Effect.Effect<ReadonlyArray<Update>, StorageError>;
  readonly assetContentType: (hash: string) => Effect.Effect<string | null, StorageError>;
  readonly missingAssets: (hashes: ReadonlyArray<string>) => Effect.Effect<ReadonlyArray<string>, StorageError>;
  readonly insertAsset: (asset: {
    readonly hash: string;
    readonly contentType: string;
    readonly size: number;
  }) => Effect.Effect<void, StorageError>;
  readonly publishGroup: (input: PublishGroupInput, options?: { readonly revert?: boolean }) => Effect.Effect<PublishedGroup, BadRequest | Conflict | StorageError>;
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

    const assetContentType = Effect.fn("UpdateStore.assetContentType")(function* (hash: string) {
      const rows = yield* sql`
        SELECT content_type FROM assets WHERE hash = ${hash}
      `.pipe(Effect.mapError(storageFail("Could not read the asset.")), storedRows(Schema.Struct({ content_type: Schema.String })));
      return rows[0]?.content_type ?? null;
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
    }) {
      const now = DateTime.formatIso(yield* DateTime.now);
      yield* sql`
        INSERT OR IGNORE INTO assets (hash, content_type, size, created_at)
        VALUES (${asset.hash}, ${asset.contentType}, ${asset.size}, ${now})
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

    const hasPatch = Effect.fn("UpdateStore.hasPatch")(function* (baseHash: string, targetHash: string) {
      const rows = yield* sql`
        SELECT 1 AS one FROM patches WHERE base_hash = ${baseHash} AND target_hash = ${targetHash}
      `.pipe(Effect.mapError(storageFail("Could not read the patch.")));
      return rows.length > 0;
    });

    const launchAssetHash = Effect.fn("UpdateStore.launchAssetHash")(function* (updateId: string) {
      const rows = yield* sql`
        SELECT u.launch_asset
        FROM updates u
        JOIN update_groups g ON g.id = u.group_id
        WHERE u.id = ${updateId}
          AND g.published_at IS NOT NULL
          AND u.rollback_to_embedded = 0
          AND u.launch_asset IS NOT NULL
      `.pipe(Effect.mapError(storageFail("Could not read the update.")), storedRows(Schema.Struct({ launch_asset: Schema.fromJsonString(StoredAsset) })));
      return rows[0]?.launch_asset.hash ?? null;
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
          SELECT ${sql.literal(updateColumns)},
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
              AND previous.position > 1 AND previous.rollback_to_embedded = 0
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
      previous: previousBundle(updates),
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
          currentUpdateId: check.currentUpdateId?.toLowerCase(),
          embeddedUpdateId: check.embeddedUpdateId?.toLowerCase(),
          servedUpdateId: check.servedUpdateId?.toLowerCase() ?? (
            previous?.platform === check.platform && previous.runtimeVersion === check.runtimeVersion && previous.channel === check.channel
              ? previous.servedUpdateId : undefined
          ),
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
        return rollbackTargetsFrom(history, [...counts.values()]);
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
    assetContentType: (hash) => Effect.sync(() => assets.get(hash) ?? null),
    insertPatch: (patch) => Effect.sync(() => void patches.add(`${patch.baseHash}/${patch.targetHash}`)),
    hasPatch: (baseHash, targetHash) => Effect.sync(() => patches.has(`${baseHash}/${targetHash}`)),
    launchAssetHash: (updateId) =>
      Effect.sync(() => {
        const update = updates().find((candidate) => candidate.id === updateId);
        return update === undefined || update.kind === "rollback" ? null : update.launchAsset.hash;
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
    insertAsset: (asset) => Effect.sync(() => {
      if (!assets.has(asset.hash)) assets.set(asset.hash, asset.contentType);
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
