import path from "node:path";
import { X509Certificate, verify } from "node:crypto";
import { DateTime, Effect, FileSystem, Schema } from "effect";
import { CliFailure } from "./errors.ts";
import { Processes, resolveRuntimeVersion, type Platform } from "./expo.ts";
import { Progress } from "./output.ts";
import { Server } from "./server.ts";

export const ProjectConfig = Schema.Struct({
  runtimeVersion: Schema.optionalKey(Schema.Unknown),
  updates: Schema.optionalKey(
    Schema.Struct({
      enabled: Schema.optionalKey(Schema.Boolean),
      url: Schema.optionalKey(Schema.String),
      codeSigningCertificate: Schema.optionalKey(Schema.String),
      codeSigningMetadata: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
      requestHeaders: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
    }),
  ),
});
export type ProjectConfig = typeof ProjectConfig.Type;

export const readProjectConfig = Effect.fn("doctor.readProjectConfig")(function* (projectDir: string) {
  const processes = yield* Processes;
  const stdout = yield* processes.run(
    "npx",
    ["--no-install", "expo", "config", "--type", "prebuild", "--json"],
    projectDir,
  );
  return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ProjectConfig))(
    stdout.slice(stdout.indexOf("{"), stdout.lastIndexOf("}") + 1),
  ).pipe(
    Effect.mapError(
      (cause) =>
        new CliFailure({
          message:
            "Could not read Expo configuration. Run npx expo config --type prebuild --json from the app directory.",
          cause,
        }),
    ),
  );
});

export const readCertificate = Effect.fn("doctor.readCertificate")(function* (
  projectDir: string,
  certificatePath: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const pem = yield* fs.readFileString(path.resolve(projectDir, certificatePath)).pipe(
    Effect.mapError(
      (cause) =>
        new CliFailure({
          message: `Could not read ${certificatePath}. Copy the public signing certificate from your server project into the app. Never copy the private key.`,
          cause,
        }),
    ),
  );
  const now = yield* DateTime.now;
  return yield* Effect.try({
    try: () => {
      const certificate = new X509Certificate(pem);
      if (certificate.publicKey.asymmetricKeyType !== "rsa")
        throw new Error("Certificate must contain an RSA public key");
      const timestamp = DateTime.toEpochMillis(now);
      if (
        timestamp < DateTime.toEpochMillis(DateTime.makeUnsafe(certificate.validFrom)) ||
        timestamp > DateTime.toEpochMillis(DateTime.makeUnsafe(certificate.validTo))
      )
        throw new Error("Certificate is not currently valid");
      return certificate;
    },
    catch: (cause) => new CliFailure({ message: `Signing certificate is invalid: ${String(cause)}`, cause }),
  });
});

export const verifyManifest = (response: { body: string; contentType: string }, certificate: X509Certificate) =>
  Effect.try({
    try: () => {
      const boundary = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(response.contentType);
      if (!boundary || !/^multipart\/mixed/i.test(response.contentType))
        throw new Error("Expected a multipart Expo response");
      const parts = response.body.split(`--${boundary[1] ?? boundary[2]}`);
      const part = parts.find((part) => /content-disposition:[^\r\n]*name="(?:manifest|directive)"/i.test(part));
      if (!part) throw new Error("Manifest or directive part is missing");
      const split = part.indexOf("\r\n\r\n");
      if (split < 0 || !part.endsWith("\r\n")) throw new Error("Malformed multipart response");
      const headers = part.slice(0, split);
      const body = part.slice(split + 4, -2);
      const signature = /expo-signature:[^\r\n]*sig="([A-Za-z0-9+/=]+)"/i.exec(headers);
      if (!signature || !/expo-signature:[^\r\n]*keyid="main"/i.test(headers))
        throw new Error("Expected a signature with keyid main");
      if (!verify("RSA-SHA256", Buffer.from(body), certificate.publicKey, Buffer.from(signature[1]!, "base64")))
        throw new Error("Server signature does not match the app certificate");
      const payload = JSON.parse(body) as { id?: unknown; type?: unknown };
      if (
        typeof payload.id !== "string" &&
        payload.type !== "noUpdateAvailable" &&
        payload.type !== "rollBackToEmbedded"
      )
        throw new Error("Invalid Expo manifest or directive");
      return payload.type === "noUpdateAvailable" ? ("no-update" as const) : ("available" as const);
    },
    catch: (cause) => new CliFailure({ message: `Manifest verification failed: ${String(cause)}`, cause }),
  });

export interface DoctorOptions {
  projectDir: string;
  url: string;
  channel?: string | undefined;
  platforms: ReadonlyArray<Platform>;
  branch?: string;
}

export const doctor = Effect.fn("doctor.check")(
  function* (options: DoctorOptions) {
    const progress = yield* Progress;
    const server = yield* Server;
    yield* progress.report({ type: "start", message: "Checking Expo configuration and signing" });
    const config = yield* readProjectConfig(options.projectDir);
    const updates = config.updates;
    if (!updates || updates.enabled === false || updates.url !== `${options.url}/manifest`)
      return yield* new CliFailure({
        message: `Set updates.url to ${options.url}/manifest and enable updates. Run open-ota init to configure this app.`,
      });
    const configuredChannel = updates.requestHeaders?.["expo-channel-name"];
    const channel = options.channel ?? configuredChannel;
    if (!channel || channel !== configuredChannel)
      return yield* new CliFailure({
        message:
          "The requested channel must match updates.requestHeaders['expo-channel-name']. Select the correct app configuration or rebuild with the intended channel.",
      });
    if (
      !updates.codeSigningCertificate ||
      updates.codeSigningMetadata?.keyid !== "main" ||
      updates.codeSigningMetadata.alg !== "rsa-v1_5-sha256"
    )
      return yield* new CliFailure({
        message:
          "Configure codeSigningCertificate and codeSigningMetadata with keyid main and alg rsa-v1_5-sha256. Run open-ota init.",
      });
    const certificate = yield* readCertificate(options.projectDir, updates.codeSigningCertificate);
    yield* progress.report({ type: "success", message: "Expo configuration and certificate are valid" });
    yield* progress.report({ type: "start", message: "Checking server credentials and channel mapping" });
    const overview = yield* server.overview();
    const linked = overview.channels.find((entry) => entry.name === channel);
    if (!linked)
      return yield* new CliFailure({
        message: `Channel ${channel} does not exist. Create and link it in the dashboard before publishing.`,
      });
    yield* progress.report({
      type: "success",
      message: `${channel} serves branch ${linked.branch}; credentials accepted`,
    });
    if (options.branch && linked.branch !== options.branch)
      yield* progress.report({
        type: "warning",
        message: `This app checks ${linked.branch}, but you are publishing to ${options.branch}. Link a channel to that branch when you want devices to receive it.`,
      });
    const fleet = yield* server.fleet();
    const runtimes: Array<{ platform: Platform; runtimeVersion: string; devices: number; outcome: string }> = [];
    for (const platform of options.platforms) {
      yield* progress.report({ type: "start", message: `Checking ${platform} runtime and signed delivery` });
      const runtimeVersion = yield* resolveRuntimeVersion(options.projectDir, platform);
      const active = overview.latest.find(
        (update) =>
          update.branch === (options.branch ?? linked.branch) &&
          update.platform === platform &&
          update.runtimeVersion === runtimeVersion &&
          update.rolloutPercent < 100,
      );
      if (options.branch && active)
        return yield* new CliFailure({
          message: `An active rollout exists on ${options.branch} for ${platform} ${runtimeVersion}. Complete it or roll it back before publishing.`,
        });
      const outcome = yield* server
        .probe(platform, runtimeVersion, channel)
        .pipe(Effect.flatMap((response) => verifyManifest(response, certificate)));
      const devices = fleet.runtimes
        .filter(
          (entry) =>
            entry.channel === channel && entry.platform === platform && entry.runtimeVersion === runtimeVersion,
        )
        .reduce((sum, entry) => sum + entry.devices, 0);
      yield* progress.report({ type: "success", message: `${platform}: ${runtimeVersion}; server signature verified` });
      if (devices === 0)
        yield* progress.report({
          type: "warning",
          message: `No ${platform} devices observed for this runtime yet. A new app is expected to have none; this does not prove a mismatch. Validate with a native build.`,
        });
      if (outcome === "no-update")
        yield* progress.report({
          type: "info",
          message: `${platform}: no update selected for this client probe. Connectivity and signing passed; this is not evidence of delivery to a device.`,
        });
      runtimes.push({ platform, runtimeVersion, devices, outcome });
    }
    yield* progress.report({
      type: "info",
      message:
        "Checks passed. Configuration changes require a new native build; an OTA update cannot change the installed URL, channel, or certificate.",
    });
    return { channel, branch: linked.branch, runtimes };
  },
  (effect) =>
    effect.pipe(
      Effect.timeout("60 seconds"),
      Effect.catchTag("TimeoutError", () =>
        Effect.fail(
          new CliFailure({
            message: "Doctor timed out. Check the server connection and local Expo commands, then retry.",
          }),
        ),
      ),
    ),
);
