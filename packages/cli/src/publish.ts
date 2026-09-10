import { createHash } from "node:crypto";
import { Effect, FileSystem, Ref, Schema } from "effect";
import { CliFailure } from "./errors.ts";
import path from "node:path";
import { actor, exportProject, gitCommit, publicConfig, resolveRuntimeVersion, type Platform } from "./expo.ts";
import { Progress } from "./output.ts";
import { generatePatches, type PatchTarget } from "./patches.ts";
import { Server } from "./server.ts";

const contentTypes: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  ttf: "font/ttf",
  otf: "font/otf",
  woff: "font/woff",
  woff2: "font/woff2",
  json: "application/json",
  mp3: "audio/mpeg",
  mp4: "video/mp4",
  wav: "audio/wav",
  txt: "text/plain",
};

interface StoredAsset {
  hash: string;
  key: string;
  contentType: string;
  fileExtension: string;
}

const PlatformFiles = Schema.Struct({
  bundle: Schema.String,
  assets: Schema.Array(Schema.Struct({ path: Schema.String, ext: Schema.String })),
});
const Metadata = Schema.fromJsonString(
  Schema.Struct({
    fileMetadata: Schema.Struct({ ios: Schema.optionalKey(PlatformFiles), android: Schema.optionalKey(PlatformFiles) }),
  }),
);

interface Upload {
  bytes: Uint8Array;
  contentType: string;
}

interface CommonOptions {
  branch: string;
  message: string | undefined;
  platforms: ReadonlyArray<Platform>;
  projectDir: string;
}

export interface PublishOptions extends CommonOptions {
  rolloutPercent: number | undefined;
  distDir: string;
  skipExport: boolean;
  noPatches: boolean;
}

export type RollbackOptions = CommonOptions;

export interface BuildRegisterOptions {
  projectDir: string;
  platform: Platform;
  // The `app.manifest` expo-updates generated for the build, and its bundle.
  manifestPath: string;
  bundlePath: string;
  runtimeVersion: string | undefined;
  profile: string;
  distribution: "store" | "internal" | "simulator";
  channel: string | undefined;
}

export interface BuildGetOptions {
  projectDir: string;
  platform: Platform;
  runtimeVersion: string | undefined;
  profile: string;
  distribution: "store" | "internal" | "simulator";
  channel: string | undefined;
  // Deactivated builds are hidden unless asked for.
  includeInactive: boolean;
}

export interface BuildActivationOptions {
  id: string;
  active: boolean;
}

export interface BackfillOptions {
  branch: string;
  platforms: ReadonlyArray<Platform>;
  projectDir: string;
}

const EmbeddedManifest = Schema.fromJsonString(
  Schema.Struct({
    id: Schema.String.check(Schema.isPattern(/^[a-f0-9-]{36}$/i)),
    runtimeVersion: Schema.optionalKey(Schema.String),
  }),
);

// Matches Expo's reference server: base64url sha256 addresses the bytes, md5 hex is the client-side key.
const storeAsset = Effect.fn("publish.storeAsset")(function* (
  file: string,
  contentType: string,
  fileExtension: string,
  uploads: Map<string, Upload>,
) {
  const fs = yield* FileSystem.FileSystem;
  const bytes = yield* fs.readFile(file);
  const hash = createHash("sha256").update(bytes).digest("base64url");
  uploads.set(hash, { bytes, contentType });
  return { hash, key: createHash("md5").update(bytes).digest("hex"), contentType, fileExtension } satisfies StoredAsset;
});

const uploadMissing = Effect.fn("publish.uploadMissing")(function* (
  hashes: ReadonlyArray<string>,
  uploads: Map<string, Upload>,
) {
  const server = yield* Server;
  const progress = yield* Progress;
  const completed = yield* Ref.make(0);
  yield* Effect.forEach(
    hashes,
    Effect.fn("publish.uploadOne")(function* (hash) {
      const upload = uploads.get(hash);
      if (!upload)
        return yield* new CliFailure({
          message: `The server asked for an asset this export does not contain: ${hash}`,
        });
      yield* server.uploadAsset(hash, upload.bytes, upload.contentType);
      const count = yield* Ref.updateAndGet(completed, (n) => n + 1);
      yield* progress.report({
        type: "progress",
        message: `Uploaded ${count}/${hashes.length} asset${hashes.length === 1 ? "" : "s"}`,
      });
    }),
    { concurrency: 4, discard: true },
  );
});

const submit = Effect.fn("publish.submit")(function* (group: unknown) {
  const server = yield* Server;
  const progress = yield* Progress;
  yield* progress.report({ type: "start", message: "Publishing update group" });
  const published = yield* server.publishGroup(group);
  yield* progress.report({ type: "published", message: `Published group ${published.groupId}` });
  return published;
});

export const publish = Effect.fn("publish.publish")(function* (options: PublishOptions) {
  const { projectDir, distDir, platforms } = options;
  const server = yield* Server;
  const progress = yield* Progress;
  const fs = yield* FileSystem.FileSystem;

  if (!options.skipExport) {
    yield* progress.report({ type: "start", message: `Exporting ${platforms.join(" and ")}` });
    yield* exportProject(projectDir, distDir, platforms);
    yield* progress.report({ type: "success", message: "Exported project" });
  }

  yield* progress.report({ type: "start", message: "Reading export and project configuration" });
  const metadata = yield* fs.readFileString(path.join(distDir, "metadata.json")).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Metadata)),
    Effect.mapError(
      (cause) =>
        new CliFailure({
          message: `Could not read Expo export metadata at ${path.join(distDir, "metadata.json")}. Run publish without --skip-export to regenerate it, or check --dist.`,
          cause,
        }),
    ),
  );
  const expoConfig = yield* publicConfig(projectDir);
  yield* progress.report({ type: "success", message: "Read export and project configuration" });

  const uploads = new Map<string, Upload>();
  const updates: Record<string, unknown> = {};
  const targets: Array<PatchTarget> = [];
  for (const platform of platforms) {
    const files = metadata.fileMetadata[platform];
    if (files === undefined) {
      return yield* new CliFailure({
        message: `${path.join(distDir, "metadata.json")} has no ${platform} export. Run publish without --skip-export to regenerate it.`,
      });
    }
    yield* progress.report({ type: "start", message: `Resolving ${platform} runtime and hashing assets` });
    const runtimeVersion = yield* resolveRuntimeVersion(projectDir, platform);
    const launchAsset = yield* storeAsset(
      path.join(distDir, files.bundle),
      "application/javascript",
      ".bundle",
      uploads,
    );
    const assets: Array<StoredAsset> = [];
    for (const asset of files.assets) {
      assets.push(
        yield* storeAsset(
          path.join(distDir, asset.path),
          contentTypes[asset.ext.toLowerCase()] ?? "application/octet-stream",
          `.${asset.ext}`,
          uploads,
        ),
      );
    }
    updates[platform] = { runtimeVersion, launchAsset, assets };
    targets.push({ platform, runtimeVersion, hash: launchAsset.hash, bytes: uploads.get(launchAsset.hash)!.bytes });
    yield* progress.report({
      type: "success",
      message: `${platform}: runtime ${runtimeVersion}, ${assets.length} asset${assets.length === 1 ? "" : "s"}`,
    });
  }

  const hashes = [...uploads.keys()];
  yield* progress.report({ type: "start", message: "Checking assets on the server" });
  const missing = yield* server.missingAssets(hashes);
  yield* progress.report({
    type: "success",
    message: `Reusing ${hashes.length - missing.length} asset${hashes.length - missing.length === 1 ? "" : "s"}`,
  });
  if (missing.length > 0) {
    yield* progress.report({
      type: "start",
      message: `Uploading ${missing.length} asset${missing.length === 1 ? "" : "s"}`,
    });
    yield* uploadMissing(missing, uploads);
    yield* progress.report({
      type: "success",
      message: `Uploaded ${missing.length} asset${missing.length === 1 ? "" : "s"}`,
    });
  }

  // Patches go up before the group is published. Full bundles are cached at the
  // edge per base update, so a device that fetched the bundle before its patch
  // existed would pin the full download for every later device on that base.
  if (!options.noPatches) {
    yield* generatePatches({ branch: options.branch, targets });
  }

  const commit = yield* gitCommit(projectDir);
  const who = yield* actor(projectDir);
  return yield* submit({
    branch: options.branch,
    ...(options.message !== undefined && { message: options.message }),
    ...(commit !== undefined && { gitCommit: commit }),
    ...(who !== undefined && { actor: who }),
    ...(options.rolloutPercent !== undefined && { rolloutPercent: options.rolloutPercent }),
    expoConfig,
    updates,
  });
});

// A store build's JS is an update like any other to the devices running it.
// Registering it lets the server patch fresh installs to the latest update.
export const registerBuild = Effect.fn("build.register")(function* (options: BuildRegisterOptions) {
  const server = yield* Server;
  const progress = yield* Progress;
  const fs = yield* FileSystem.FileSystem;
  yield* progress.report({ type: "start", message: `Reading the ${options.platform} embedded manifest` });
  const manifest = yield* fs.readFileString(options.manifestPath).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(EmbeddedManifest)),
    Effect.mapError(
      (cause) =>
        new CliFailure({
          message: `Could not read an embedded update manifest at ${options.manifestPath}. Point --manifest at the app.manifest expo-updates generated for the build.`,
          cause,
        }),
    ),
  );
  const runtimeVersion =
    options.runtimeVersion ?? manifest.runtimeVersion ?? (yield* resolveRuntimeVersion(options.projectDir, options.platform));
  const uploads = new Map<string, Upload>();
  const launchAsset = yield* storeAsset(options.bundlePath, "application/javascript", ".bundle", uploads);
  yield* progress.report({ type: "success", message: `${options.platform}: update ${manifest.id}, runtime ${runtimeVersion}` });
  const missing = yield* server.missingAssets([launchAsset.hash]);
  if (missing.length > 0) {
    yield* progress.report({ type: "start", message: "Uploading the embedded bundle" });
    yield* uploadMissing(missing, uploads);
    yield* progress.report({ type: "success", message: "Uploaded the embedded bundle" });
  }
  yield* progress.report({ type: "start", message: "Registering the build" });
  const registered = yield* server.registerBuild({
    updateId: manifest.id,
    platform: options.platform,
    runtimeVersion,
    profile: options.profile,
    distribution: options.distribution,
    ...(options.channel === undefined ? {} : { channel: options.channel }),
    launchAsset,
  });
  yield* progress.report({ type: "success", message: `Registered build ${registered.id}` });
  return registered;
});

export const getBuild = Effect.fn("build.get")(function* (options: BuildGetOptions) {
  const server = yield* Server;
  const runtimeVersion =
    options.runtimeVersion ?? (yield* resolveRuntimeVersion(options.projectDir, options.platform));
  return yield* server.findBuild({
    platform: options.platform,
    runtimeVersion,
    profile: options.profile,
    distribution: options.distribution,
    channel: options.channel,
    includeInactive: options.includeInactive,
  });
});

// A pulled or rejected build stays registered, with its bundle, but stops
// counting as proof that an OTA update is the right release path.
export const setBuildActive = Effect.fn("build.setActive")(function* (options: BuildActivationOptions) {
  const server = yield* Server;
  const progress = yield* Progress;
  const verb = options.active ? "Activating" : "Deactivating";
  yield* progress.report({ type: "start", message: `${verb} build ${options.id}` });
  const build = yield* server.setBuildActive(options.id, options.active);
  yield* progress.report({ type: "success", message: `${options.active ? "Activated" : "Deactivated"} build ${build.id}` });
  return build;
});

// Computes the patches the newest bundle on a branch is missing: after a build
// was registered, after the fleet moved, or after a publish ran with --no-patches.
export const backfillPatches = Effect.fn("publish.backfillPatches")(function* (options: BackfillOptions) {
  const server = yield* Server;
  const progress = yield* Progress;
  const targets: Array<PatchTarget> = [];
  const skip = new Set<string>();
  for (const platform of options.platforms) {
    yield* progress.report({ type: "start", message: `Resolving the ${platform} runtime and newest bundle` });
    const runtimeVersion = yield* resolveRuntimeVersion(options.projectDir, platform);
    const newest = (yield* server.branchBundles(options.branch, platform, runtimeVersion, 1))[0];
    if (newest === undefined) {
      yield* progress.report({ type: "info", message: `${platform}: nothing published on ${options.branch} for runtime ${runtimeVersion}` });
      continue;
    }
    for (const covered of yield* server.updatePatches(newest.updateId)) skip.add(covered);
    const bytes = yield* server.downloadAsset(newest.hash);
    targets.push({ platform, runtimeVersion, hash: newest.hash, bytes });
    yield* progress.report({ type: "success", message: `${platform}: runtime ${runtimeVersion}, bundle ${newest.hash.slice(0, 7)}` });
  }
  const summary = yield* generatePatches({ branch: options.branch, targets, skip });
  return { ...summary, targets: targets.map(({ platform, runtimeVersion, hash }) => ({ platform, runtimeVersion, hash })) };
});

export const rollbackToEmbedded = Effect.fn("publish.rollbackToEmbedded")(function* (options: RollbackOptions) {
  const progress = yield* Progress;
  const updates: Record<string, unknown> = {};
  for (const platform of options.platforms) {
    yield* progress.report({ type: "start", message: `Resolving ${platform} runtime for rollback` });
    const runtimeVersion = yield* resolveRuntimeVersion(options.projectDir, platform);
    yield* progress.report({ type: "success", message: `${platform}: runtime ${runtimeVersion}` });
    updates[platform] = { runtimeVersion, rollbackToEmbedded: true };
  }
  const commit = yield* gitCommit(options.projectDir);
  const who = yield* actor(options.projectDir);
  return yield* submit({
    branch: options.branch,
    ...(options.message !== undefined && { message: options.message }),
    ...(commit !== undefined && { gitCommit: commit }),
    ...(who !== undefined && { actor: who }),
    updates,
  });
});
