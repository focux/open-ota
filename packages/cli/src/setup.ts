import path from "node:path";
import { Effect, FileSystem, Schema } from "effect";
import { doctor, readCertificate, readProjectConfig, verifyManifest } from "./doctor.ts";
import { CliFailure } from "./errors.ts";
import { Progress } from "./output.ts";
import { Server } from "./server.ts";
import type { Platform } from "./expo.ts";

const JsonObject = Schema.Record(Schema.String, Schema.Unknown);
const asObject = Schema.decodeUnknownEffect(JsonObject);

export const initialize = Effect.fn("setup.initialize")(function* (options: {
  projectDir: string;
  url: string;
  channel: string;
  certificate: string;
  platforms: ReadonlyArray<Platform>;
}) {
  const fs = yield* FileSystem.FileSystem;
  const server = yield* Server;
  const progress = yield* Progress;
  yield* progress.report({ type: "start", message: "Checking the app, certificate and server before setup" });
  yield* readProjectConfig(options.projectDir);
  const certificate = yield* readCertificate(options.projectDir, options.certificate);
  const overview = yield* server.overview();
  if (!overview.channels.some((entry) => entry.name === options.channel))
    return yield* new CliFailure({
      message: `Create and link channel ${options.channel} in the dashboard, then run init again.`,
    });
  yield* server
    .probe("ios", "open-ota-init-probe", options.channel)
    .pipe(Effect.flatMap((response) => verifyManifest(response, certificate)));
  yield* progress.report({ type: "success", message: "Server credentials and signing certificate match" });
  const snippet = {
    runtimeVersion: { policy: "fingerprint" },
    updates: {
      enabled: true,
      url: `${options.url}/manifest`,
      checkAutomatically: "ON_LOAD",
      codeSigningCertificate: options.certificate,
      codeSigningMetadata: { keyid: "main", alg: "rsa-v1_5-sha256" },
      requestHeaders: { "expo-channel-name": options.channel },
    },
  };
  for (const name of ["app.config.ts", "app.config.js", "app.config.mjs", "app.config.cjs"]) {
    if (yield* fs.exists(path.join(options.projectDir, name))) {
      yield* progress.report({
        type: "warning",
        message: `Dynamic config found: ${name}. Merge the generated fields into its returned Expo config, preserving your environment-specific channel selection.`,
      });
      yield* progress.report({
        type: "info",
        message:
          "Then run open-ota doctor with the same server and channel. Ship a new native build before publishing an OTA update.",
      });
      return { mode: "snippet" as const, file: name, config: snippet };
    }
  }
  const file = path.join(options.projectDir, "app.json");
  const original = yield* fs
    .readFileString(file)
    .pipe(
      Effect.mapError(
        (cause) =>
          new CliFailure({ message: "No static app.json found. Create an Expo app first, then run init.", cause }),
      ),
    );
  const root = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(JsonObject))(original);
  const expo = yield* asObject(root.expo);
  const updates = yield* asObject(expo.updates ?? {});
  const headers = yield* asObject(updates.requestHeaders ?? {});
  const next = {
    ...root,
    expo: {
      ...expo,
      ...snippet,
      updates: { ...updates, ...snippet.updates, requestHeaders: { ...headers, ...snippet.updates.requestHeaders } },
    },
  };
  if (JSON.stringify(root) !== JSON.stringify(next)) {
    yield* fs
      .writeFileString(`${file}.open-ota.bak`, original, { flag: "wx" })
      .pipe(
        Effect.mapError(
          (cause) =>
            new CliFailure({
              message:
                "Could not create app.json.open-ota.bak. Keep or rename an existing backup before running init again.",
              cause,
            }),
        ),
      );
    yield* fs.writeFileString(file, `${JSON.stringify(next, null, 2)}\n`);
    yield* progress.report({
      type: "info",
      message: "Updated app.json. Original saved as app.json.open-ota.bak; review the diff before building.",
    });
  } else {
    yield* progress.report({ type: "info", message: "app.json already contains this configuration." });
  }
  const checks = yield* doctor({ ...options });
  return { mode: "configured" as const, file, checks };
});
