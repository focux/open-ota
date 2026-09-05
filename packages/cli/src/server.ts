import { Context, Effect, Layer, Redacted, Schema } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import { CliFailure } from "./errors.ts";

const PublishedGroup = Schema.Struct({
  groupId: Schema.String,
  updates: Schema.Array(Schema.Struct({ id: Schema.String, platform: Schema.String, runtimeVersion: Schema.String })),
});
export type PublishedGroup = typeof PublishedGroup.Type;
const Bundles = Schema.Struct({
  bundles: Schema.Array(Schema.Struct({
    updateId: Schema.String,
    hash: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{43}$/)),
  })),
});

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
    uploadPatch(base: string, target: string, bytes: Uint8Array): Effect.Effect<void, CliFailure>;
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
          uploadPatch: Effect.fn("server.uploadPatch")(function* (base, target, bytes) {
            yield* request(
              HttpClientRequest.put(`/publish/patches/${base}/${target}`).pipe(
                HttpClientRequest.bodyUint8Array(bytes, "application/octet-stream"),
              ),
            );
          }),
        });
      }),
    );
}
