import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  actor,
  exportProject,
  gitCommit,
  publicConfig,
  resolveRuntimeVersion,
  type Platform,
  type Run,
} from "./expo.ts";
import { generatePatches, type PatchTarget } from "./patches.ts";
import { missingAssets, publishGroup, uploadAsset, type PublishedGroup, type Server } from "./server.ts";

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

interface PlatformFiles {
  bundle: string;
  assets: ReadonlyArray<{ path: string; ext: string }>;
}

interface Metadata {
  fileMetadata: Partial<Record<Platform, PlatformFiles>>;
}

interface Upload {
  bytes: Uint8Array;
  contentType: string;
}

interface CommonOptions {
  branch: string;
  message: string | undefined;
  platforms: ReadonlyArray<Platform>;
  projectDir: string;
  server: Server;
  run: Run;
  log: (message: string) => void;
}

export interface PublishOptions extends CommonOptions {
  rolloutPercent: number | undefined;
  distDir: string;
  skipExport: boolean;
  noPatches: boolean;
}

export type RollbackOptions = CommonOptions;

// Matches Expo's reference server: base64url sha256 addresses the bytes, md5 hex is the client-side key.
const storeAsset = async (file: string, contentType: string, fileExtension: string, uploads: Map<string, Upload>) => {
  const bytes = await readFile(file);
  const hash = createHash("sha256").update(bytes).digest("base64url");
  uploads.set(hash, { bytes, contentType });
  return { hash, key: createHash("md5").update(bytes).digest("hex"), contentType, fileExtension } satisfies StoredAsset;
};

const uploadMissing = async (server: Server, hashes: ReadonlyArray<string>, uploads: Map<string, Upload>) => {
  let next = 0;
  const worker = async () => {
    for (let index = next++; index < hashes.length; index = next++) {
      const hash = hashes[index]!;
      const upload = uploads.get(hash);
      if (upload === undefined) {
        throw new Error(`The server asked for an asset this export does not contain: ${hash}`);
      }
      await uploadAsset(server, hash, upload.bytes, upload.contentType);
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, hashes.length) }, worker));
};

const submit = async (server: Server, group: unknown, log: (message: string) => void) => {
  const published = await publishGroup(server, group);
  log(`Published group ${published.groupId}`);
  for (const update of published.updates) {
    log(`  ${update.platform} ${update.runtimeVersion} -> ${update.id}`);
  }
  return published;
};

export const publish = async (options: PublishOptions): Promise<PublishedGroup> => {
  const { run, projectDir, distDir, platforms, server, log } = options;

  if (!options.skipExport) {
    log(`Exporting ${platforms.join(" and ")} to ${distDir}`);
    await exportProject(run, projectDir, distDir, platforms);
  }

  const metadata = JSON.parse(await readFile(path.join(distDir, "metadata.json"), "utf8")) as Metadata;
  const expoConfig = await publicConfig(run, projectDir);

  const uploads = new Map<string, Upload>();
  const updates: Record<string, unknown> = {};
  const targets: Array<PatchTarget> = [];
  for (const platform of platforms) {
    const files = metadata.fileMetadata[platform];
    if (files === undefined) {
      throw new Error(`${path.join(distDir, "metadata.json")} has no ${platform} export.`);
    }
    const runtimeVersion = await resolveRuntimeVersion(run, projectDir, platform);
    const launchAsset = await storeAsset(
      path.join(distDir, files.bundle),
      "application/javascript",
      ".bundle",
      uploads,
    );
    const assets: Array<StoredAsset> = [];
    for (const asset of files.assets) {
      assets.push(
        await storeAsset(
          path.join(distDir, asset.path),
          contentTypes[asset.ext.toLowerCase()] ?? "application/octet-stream",
          `.${asset.ext}`,
          uploads,
        ),
      );
    }
    updates[platform] = { runtimeVersion, launchAsset, assets };
    targets.push({ platform, runtimeVersion, hash: launchAsset.hash, bytes: uploads.get(launchAsset.hash)!.bytes });
    log(`${platform}: runtime ${runtimeVersion}, ${assets.length} assets`);
  }

  const hashes = [...uploads.keys()];
  const missing = await missingAssets(server, hashes);
  log(`Uploading ${missing.length} of ${hashes.length} assets`);
  await uploadMissing(server, missing, uploads);

  const commit = await gitCommit(run, projectDir);
  const who = await actor(run, projectDir);
  const published = await submit(
    server,
    {
      branch: options.branch,
      ...(options.message !== undefined && { message: options.message }),
      ...(commit !== undefined && { gitCommit: commit }),
      ...(who !== undefined && { actor: who }),
      ...(options.rolloutPercent !== undefined && { rolloutPercent: options.rolloutPercent }),
      expoConfig,
      updates,
    },
    log,
  );
  if (!options.noPatches) {
    await generatePatches({ branch: options.branch, targets, server, run, log });
  }
  return published;
};

export const rollbackToEmbedded = async (options: RollbackOptions): Promise<PublishedGroup> => {
  const updates: Record<string, unknown> = {};
  for (const platform of options.platforms) {
    const runtimeVersion = await resolveRuntimeVersion(options.run, options.projectDir, platform);
    updates[platform] = { runtimeVersion, rollbackToEmbedded: true };
  }
  const commit = await gitCommit(options.run, options.projectDir);
  const who = await actor(options.run, options.projectDir);
  return submit(
    options.server,
    {
      branch: options.branch,
      ...(options.message !== undefined && { message: options.message }),
      ...(commit !== undefined && { gitCommit: commit }),
      ...(who !== undefined && { actor: who }),
      updates,
    },
    options.log,
  );
};
