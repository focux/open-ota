import { Schema } from "effect";

export const Platform = Schema.Literals(["ios", "android"]);
export type Platform = typeof Platform.Type;

export const BranchName = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9._-]{0,63}$/));
export const Percent = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 100 }));
const NonEmpty = Schema.String.check(Schema.isNonEmpty());

// One file of an export: `hash` addresses the bytes in R2, `key` is the id the
// client stores it under (Expo's md5 of the file).
export const StoredAsset = Schema.Struct({
  hash: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{43}$/)),
  key: NonEmpty,
  contentType: NonEmpty,
  fileExtension: Schema.optionalKey(Schema.String),
});
export type StoredAsset = typeof StoredAsset.Type;

export const ExpoConfig = Schema.Record(Schema.String, Schema.Unknown);

const updateFields = {
  id: Schema.String,
  groupId: Schema.String,
  branch: Schema.String,
  platform: Platform,
  runtimeVersion: Schema.String,
  rolloutPercent: Schema.Number,
  createdAt: Schema.String,
};

export const BundleUpdate = Schema.Struct({
  kind: Schema.Literals(["bundle"]),
  ...updateFields,
  launchAsset: StoredAsset,
  assets: Schema.Array(StoredAsset),
  expoConfig: ExpoConfig,
});
export type BundleUpdate = typeof BundleUpdate.Type;

export const RollbackUpdate = Schema.Struct({
  kind: Schema.Literals(["rollback"]),
  ...updateFields,
});
export type RollbackUpdate = typeof RollbackUpdate.Type;

export const Update = Schema.Union([BundleUpdate, RollbackUpdate]);
export type Update = typeof Update.Type;

export const PlatformUpdateInput = Schema.Union([
  Schema.Struct({
    runtimeVersion: NonEmpty,
    launchAsset: StoredAsset,
    assets: Schema.Array(StoredAsset),
  }),
  Schema.Struct({
    runtimeVersion: NonEmpty,
    rollbackToEmbedded: Schema.Literals([true]),
  }),
]);
export type PlatformUpdateInput = typeof PlatformUpdateInput.Type;

export const PublishGroupInput = Schema.Struct({
  branch: BranchName,
  message: Schema.optionalKey(Schema.String),
  gitCommit: Schema.optionalKey(Schema.String),
  // Who published: a dashboard user's email, or the commit author from CI.
  actor: Schema.optionalKey(Schema.String),
  rolloutPercent: Schema.optionalKey(Percent),
  expoConfig: Schema.optionalKey(ExpoConfig),
  updates: Schema.Struct({
    ios: Schema.optionalKey(PlatformUpdateInput),
    android: Schema.optionalKey(PlatformUpdateInput),
  }),
});
export type PublishGroupInput = typeof PublishGroupInput.Type;

export interface PublishedGroup {
  readonly groupId: string;
  readonly updates: ReadonlyArray<{
    readonly id: string;
    readonly platform: Platform;
    readonly runtimeVersion: string;
  }>;
}
