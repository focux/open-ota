import { Context, Effect, Layer, Redacted, Schema } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import { CliFailure } from "./errors.ts";

const PublishedGroup = Schema.Struct({
  groupId: Schema.String,
  updates: Schema.Array(Schema.Struct({ id: Schema.String, platform: Schema.String, runtimeVersion: Schema.String })),
});
export type PublishedGroup = typeof PublishedGroup.Type;
const AssetHash = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{43}$/));
const Bundles = Schema.Struct({
  bundles: Schema.Array(Schema.Struct({ updateId: Schema.String, hash: AssetHash })),
});
const PatchBases = Schema.Struct({
  bases: Schema.Array(
    Schema.Struct({
      hash: AssetHash,
      source: Schema.Literals(["fleet", "embedded", "recent"]),
      updateId: Schema.NullOr(Schema.String),
      devices: Schema.Number,
    }),
  ),
  maxRatio: Schema.Number,
  maxBundleBytes: Schema.Number,
});
export type PatchBases = typeof PatchBases.Type;
const PatchUpload = Schema.Union([
  Schema.Struct({ stored: Schema.Literals([true]), size: Schema.Number, wireSize: Schema.Number, ratio: Schema.Number }),
  Schema.Struct({
    stored: Schema.Literals([false]),
    reason: Schema.String,
    size: Schema.Number,
    wireSize: Schema.Number,
    ratio: Schema.Number,
  }),
]);
export type PatchUpload = typeof PatchUpload.Type;
const UpdatePatches = Schema.Struct({
  patches: Schema.Array(Schema.Struct({ baseHash: AssetHash, size: Schema.Number })),
});
const Build = Schema.Struct({
  id: Schema.String,
  embeddedUpdateId: Schema.String,
  platform: Schema.Literals(["ios", "android"]),
  runtimeVersion: Schema.String,
  profile: Schema.String,
  distribution: Schema.Literals(["store", "internal", "simulator"]),
  channel: Schema.optionalKey(Schema.String),
  launchAssetHash: AssetHash,
  active: Schema.Boolean,
});
export type Build = typeof Build.Type;
const BuildResult = Schema.Struct({ build: Schema.NullOr(Build) });

export interface BuildInput {
  readonly updateId: string;
  readonly platform: Build["platform"];
  readonly runtimeVersion: string;
  readonly profile: string;
  readonly distribution: Build["distribution"];
  readonly channel?: string;
  readonly launchAsset: { hash: string; key: string; contentType: string; fileExtension: string };
}

const Overview = Schema.Struct({
  channels: Schema.Array(Schema.Struct({ name: Schema.String, branch: Schema.String })),
  latest: Schema.Array(
    Schema.Struct({
      branch: Schema.String,
      platform: Schema.String,
      runtimeVersion: Schema.String,
      rolloutPercent: Schema.Number,
    }),
  ),
});
const Fleet = Schema.Struct({
  runtimes: Schema.Array(
    Schema.Struct({
      channel: Schema.String,
      platform: Schema.String,
      runtimeVersion: Schema.String,
      devices: Schema.Number,
    }),
  ),
});

export class Server extends Context.Service<
  Server,
  {
    overview(): Effect.Effect<typeof Overview.Type, CliFailure>;
    fleet(): Effect.Effect<typeof Fleet.Type, CliFailure>;
    probe(
      platform: string,
      runtime: string,
      channel: string,
    ): Effect.Effect<{ body: string; contentType: string }, CliFailure>;
    missingAssets(hashes: ReadonlyArray<string>): Effect.Effect<ReadonlyArray<string>, CliFailure>;
    uploadAsset(hash: string, bytes: Uint8Array, contentType: string): Effect.Effect<void, CliFailure>;
    publishGroup(group: unknown): Effect.Effect<PublishedGroup, CliFailure>;
    branchBundles(
      branch: string,
      platform: string,
      runtimeVersion: string,
      limit: number,
    ): Effect.Effect<typeof Bundles.Type.bundles, CliFailure>;
    downloadAsset(hash: string): Effect.Effect<Uint8Array, CliFailure>;
    patchBases(branch: string, platform: string, runtimeVersion: string, target: string): Effect.Effect<PatchBases, CliFailure>;
    uploadPatch(base: string, target: string, bytes: Uint8Array): Effect.Effect<PatchUpload, CliFailure>;
    updatePatches(updateId: string): Effect.Effect<ReadonlyArray<string>, CliFailure>;
    registerBuild(input: BuildInput): Effect.Effect<Build, CliFailure>;
    findBuild(query: {
      platform: Build["platform"];
      runtimeVersion: string;
      profile: string;
      distribution: Build["distribution"];
      channel: string | undefined;
      includeInactive: boolean;
    }): Effect.Effect<Build | null, CliFailure>;
    setBuildActive(id: string, active: boolean): Effect.Effect<Build, CliFailure>;
  }
>()("cli/Server") {
  static readonly layer = (url: string, token: Redacted.Redacted<string>) =>
    Layer.effect(
      Server,
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient;
        const request = Effect.fn("server.request")(function* (request: HttpClientRequest.HttpClientRequest) {
          const response = yield* client
            .execute(request.pipe(HttpClientRequest.prependUrl(url), HttpClientRequest.bearerToken(token)))
            .pipe(
              Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
              Effect.mapError(
                (cause) =>
                  new CliFailure({
                    message: `Could not reach ${url}. Check OTA_URL, your network connection, and whether the server is running.`,
                    cause,
                  }),
              ),
            );
          if (response.status < 200 || response.status >= 300) {
            if (response.status === 401 || response.status === 403) {
              return yield* new CliFailure({
                message: `Authentication failed (HTTP ${response.status}). Check OTA_PUBLISH_TOKEN matches the token configured on the server.`,
              });
            }
            const body = yield* response.text.pipe(Effect.catch(() => Effect.succeed("")));
            return yield* new CliFailure({
              message: `${request.method} ${request.url} failed: ${response.status} ${body.slice(0, 1000)}`,
            });
          }
          return response;
        });
        const invalidResponse = (cause: unknown) =>
          new CliFailure({ message: `Invalid response from ${url}. Check the server version and endpoint.`, cause });
        return Server.of({
          overview: Effect.fn("server.overview")(function* () {
            const response = yield* request(HttpClientRequest.get("/admin/overview"));
            return yield* HttpClientResponse.schemaBodyJson(Overview)(response).pipe(Effect.mapError(invalidResponse));
          }),
          fleet: Effect.fn("server.fleet")(function* () {
            const response = yield* request(HttpClientRequest.get("/admin/metrics"));
            return yield* HttpClientResponse.schemaBodyJson(Fleet)(response).pipe(Effect.mapError(invalidResponse));
          }),
          probe: Effect.fn("server.probe")(function* (platform, runtime, channel) {
            const response = yield* request(
              HttpClientRequest.get("/manifest").pipe(
                HttpClientRequest.setHeaders({
                  "expo-protocol-version": "1",
                  "expo-platform": platform,
                  "expo-runtime-version": runtime,
                  "expo-channel-name": channel,
                  "expo-expect-signature": 'sig, keyid="main", alg="rsa-v1_5-sha256"',
                }),
              ),
            );
            return {
              body: yield* response.text.pipe(Effect.mapError(invalidResponse)),
              contentType: response.headers["content-type"] ?? "",
            };
          }),
          missingAssets: Effect.fn("server.missingAssets")(function* (hashes) {
            const response = yield* request(
              HttpClientRequest.post("/publish/assets/missing").pipe(HttpClientRequest.bodyJsonUnsafe({ hashes })),
            );
            const body = yield* HttpClientResponse.schemaBodyJson(
              Schema.Struct({ missing: Schema.Array(Schema.String) }),
            )(response).pipe(Effect.mapError(invalidResponse));
            return body.missing;
          }),
          uploadAsset: Effect.fn("server.uploadAsset")(function* (hash, bytes, contentType) {
            yield* request(
              HttpClientRequest.put(`/publish/assets/${hash}`).pipe(
                HttpClientRequest.bodyUint8Array(bytes, contentType),
              ),
            );
          }),
          publishGroup: Effect.fn("server.publishGroup")(function* (group) {
            const response = yield* request(
              HttpClientRequest.post("/publish/groups").pipe(HttpClientRequest.bodyJsonUnsafe(group)),
            );
            return yield* HttpClientResponse.schemaBodyJson(PublishedGroup)(response).pipe(
              Effect.mapError(invalidResponse),
            );
          }),
          branchBundles: Effect.fn("server.branchBundles")(function* (branch, platform, runtimeVersion, limit) {
            const response = yield* request(
              HttpClientRequest.get(`/publish/branches/${encodeURIComponent(branch)}/bundles`).pipe(
                HttpClientRequest.setUrlParams({ platform, runtime: runtimeVersion, limit }),
              ),
            );
            const body = yield* HttpClientResponse.schemaBodyJson(Bundles)(response).pipe(
              Effect.mapError(invalidResponse),
            );
            return body.bundles;
          }),
          downloadAsset: Effect.fn("server.downloadAsset")(function* (hash) {
            const response = yield* request(HttpClientRequest.get(`/assets/${hash}`));
            return new Uint8Array(yield* response.arrayBuffer.pipe(Effect.mapError(invalidResponse)));
          }),
          patchBases: Effect.fn("server.patchBases")(function* (branch, platform, runtimeVersion, target) {
            const response = yield* request(
              HttpClientRequest.get(`/publish/branches/${encodeURIComponent(branch)}/patch-bases`).pipe(
                HttpClientRequest.setUrlParams({ platform, runtime: runtimeVersion, target }),
              ),
            );
            return yield* HttpClientResponse.schemaBodyJson(PatchBases)(response).pipe(Effect.mapError(invalidResponse));
          }),
          uploadPatch: Effect.fn("server.uploadPatch")(function* (base, target, bytes) {
            const response = yield* request(
              HttpClientRequest.put(`/publish/patches/${base}/${target}`).pipe(
                HttpClientRequest.bodyUint8Array(bytes, "application/octet-stream"),
              ),
            );
            return yield* HttpClientResponse.schemaBodyJson(PatchUpload)(response).pipe(Effect.mapError(invalidResponse));
          }),
          updatePatches: Effect.fn("server.updatePatches")(function* (updateId) {
            const response = yield* request(HttpClientRequest.get(`/admin/updates/${encodeURIComponent(updateId)}/patches`));
            const body = yield* HttpClientResponse.schemaBodyJson(UpdatePatches)(response).pipe(Effect.mapError(invalidResponse));
            return body.patches.map((patch) => patch.baseHash);
          }),
          registerBuild: Effect.fn("server.registerBuild")(function* (input) {
            const response = yield* request(
              HttpClientRequest.post("/publish/builds").pipe(HttpClientRequest.bodyJsonUnsafe(input)),
            );
            const result = yield* HttpClientResponse.schemaBodyJson(BuildResult)(response).pipe(Effect.mapError(invalidResponse));
            if (result.build === null) return yield* new CliFailure({ message: "The server did not return the registered build." });
            return result.build;
          }),
          findBuild: Effect.fn("server.findBuild")(function* (query) {
            const response = yield* request(
              HttpClientRequest.get("/publish/builds").pipe(
                HttpClientRequest.setUrlParams({
                  platform: query.platform,
                  runtime: query.runtimeVersion,
                  profile: query.profile,
                  distribution: query.distribution,
                  ...(query.channel === undefined ? {} : { channel: query.channel }),
                  ...(query.includeInactive ? { includeInactive: "true" } : {}),
                }),
              ),
            );
            const result = yield* HttpClientResponse.schemaBodyJson(BuildResult)(response).pipe(Effect.mapError(invalidResponse));
            return result.build;
          }),
          setBuildActive: Effect.fn("server.setBuildActive")(function* (id, active) {
            const response = yield* request(
              HttpClientRequest.patch(`/publish/builds/${encodeURIComponent(id)}`).pipe(HttpClientRequest.bodyJsonUnsafe({ active })),
            );
            const result = yield* HttpClientResponse.schemaBodyJson(BuildResult)(response).pipe(Effect.mapError(invalidResponse));
            if (result.build === null) return yield* new CliFailure({ message: "The server did not return the updated build." });
            return result.build;
          }),
        });
      }),
    );
}
