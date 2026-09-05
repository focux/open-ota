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

  const commit = yield* gitCommit(projectDir);
  const who = yield* actor(projectDir);
  const published = yield* submit({
    branch: options.branch,
    ...(options.message !== undefined && { message: options.message }),
    ...(commit !== undefined && { gitCommit: commit }),
    ...(who !== undefined && { actor: who }),
    ...(options.rolloutPercent !== undefined && { rolloutPercent: options.rolloutPercent }),
    expoConfig,
    updates,
  });
  if (!options.noPatches) {
    yield* generatePatches({ branch: options.branch, targets });
  }
  return published;
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
