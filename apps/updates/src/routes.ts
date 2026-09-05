import type { RuntimeContext } from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import { Context, Effect, Schema } from "effect";
import { Headers, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { AssetStore } from "./assets.ts";
import { sha256Base64Url } from "./crypto.ts";
import { BadRequest, NotFound } from "./errors.ts";
import { bearer, badRequestOn, handle } from "./http.ts";
import { Metrics } from "./metrics.ts";
import { Platform, PublishGroupInput } from "./model.ts";
import {
  ManifestHeaders,
  decide,
  manifestJson,
  multipartBody,
  parseFailedUpdateIds,
  type Part,
} from "./protocol.ts";
import { Signer, signatureHeader } from "./signing.ts";
import { UpdateStore } from "./store.ts";

export class PublishAuth extends Context.Service<PublishAuth, { readonly token: string }>()(
  "expo-ota/PublishAuth",
) {}

const HashParam = Schema.Struct({ hash: Schema.String });
const PatchParams = Schema.Struct({ base: Schema.String, target: Schema.String });
const BundlesQuery = Schema.Struct({
  name: Schema.String,
  platform: Platform,
  runtime: Schema.String.check(Schema.isNonEmpty()),
  limit: Schema.optional(Schema.NumberFromString.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 10 }))),
});
const MissingInput = Schema.Struct({ hashes: Schema.Array(Schema.String) });
const encoder = new TextEncoder();

export const routes = HttpRouter.use(
  Effect.fn("Updates.routes")(function* (router) {
    const store = yield* UpdateStore;
    const assets = yield* AssetStore;
    const metrics = yield* Metrics;
    const signer = yield* Signer;
    const auth = yield* PublishAuth;

    // Bookkeeping runs after the response is sent and never fails the request.
    const afterResponse = Effect.fn("Updates.afterResponse")(function* <E>(...work: ReadonlyArray<Effect.Effect<void, E, RuntimeContext>>) {
      const execution = yield* Cloudflare.Workers.WorkerExecutionContext;
      yield* execution.waitUntil(Effect.forEach(
        work,
        (effect) => effect.pipe(Effect.catch((error) => Effect.logWarning("Bookkeeping failed", { cause: error }))),
        { discard: true },
      ));
    });

    const authorized = bearer(auth.token);

    const jsonPart = (name: string, value: unknown): Part => ({
      name,
      body: encoder.encode(JSON.stringify(value)),
      headers: { "content-type": "application/json" },
    });

    const signed = (part: Part) =>
      signer.sign(part.body).pipe(
        Effect.map((sig) => ({
          ...part,
          headers: { ...part.headers, "expo-signature": signatureHeader(sig, signer.keyId) },
        })),
      );

    const manifest = handle(
      Effect.fn("Updates.manifest")(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const headers = yield* HttpServerRequest.schemaHeaders(ManifestHeaders).pipe(
          Effect.mapError((error) => new BadRequest({ message: `Invalid manifest request: ${error.message}` })),
        );
        const branch = yield* store.branchForChannel(headers["expo-channel-name"]);
        if (branch === null) {
          yield* Effect.logWarning("Unknown channel", { channel: headers["expo-channel-name"] });
        }
        const candidates =
          branch === null
            ? []
            : yield* store.latestUpdates({
                branch,
                platform: headers["expo-platform"],
                runtimeVersion: headers["expo-runtime-version"],
                limit: 2,
              });
        const decision = yield* decide(candidates, headers);
        const web = yield* HttpServerRequest.toWeb(request).pipe(badRequestOn("Invalid request URL."));
        const origin = new URL(web.url).origin;
        const geo = (web as { cf?: { country?: string; city?: string } }).cf;
        const country = geo?.country ?? request.headers["cf-ipcountry"];
        const city = geo?.city;

        const parts =
          decision.kind === "manifest"
            ? [jsonPart("manifest", manifestJson(decision.update, origin)), jsonPart("extensions", { assetRequestHeaders: {} })]
            : [
                jsonPart(
                  "directive",
                  decision.kind === "rollback"
                    ? { type: "rollBackToEmbedded", parameters: { commitTime: decision.update.createdAt } }
                    : { type: "noUpdateAvailable" },
                ),
              ];
        const expectSignature = headers["expo-expect-signature"] !== undefined;
        const body = yield* Effect.forEach(parts, (part) =>
          expectSignature && part.name !== "extensions" ? signed(part) : Effect.succeed(part),
        );
        const servedUpdateId = decision.kind === "none" ? undefined : decision.update.id;
        const clientId = headers["eas-client-id"] || undefined;
        const failedUpdateIds = parseFailedUpdateIds(headers["expo-recent-failed-update-ids"]);
        yield* afterResponse(
          clientId === undefined || failedUpdateIds.length === 0
            ? Effect.void
            : store.recordFailures({ clientId, updateIds: failedUpdateIds, fatalError: headers["expo-fatal-error"]?.slice(0, 1024) }),
          clientId === undefined
            ? Effect.void
            : store.recordCheck({
                clientId,
                platform: headers["expo-platform"],
                runtimeVersion: headers["expo-runtime-version"],
                channel: headers["expo-channel-name"],
                currentUpdateId: headers["expo-current-update-id"],
                embeddedUpdateId: headers["expo-embedded-update-id"],
                servedUpdateId,
                country,
                city,
              }),
          metrics.record({
            event: "check",
            clientId,
            platform: headers["expo-platform"],
            runtimeVersion: headers["expo-runtime-version"],
            channel: headers["expo-channel-name"],
            currentUpdateId: headers["expo-current-update-id"],
            servedUpdateId,
            outcome: decision.kind,
            country,
            city,
          }),
        );
        const boundary = crypto.randomUUID();
        return HttpServerResponse.uint8Array(multipartBody(body, boundary), {
          headers: {
            "content-type": `multipart/mixed; boundary=${boundary}`,
            "expo-protocol-version": "1",
            "expo-sfv-version": "0",
            "cache-control": "private, max-age=0",
            ...(branch === null ? {} : { "expo-manifest-filters": `branchname="${branch}"` }),
          },
        });
      })(),
    );

    // A client running update A asks for B's bundle with `A-IM: bsdiff`; when we
    // have the patch for that pair its body turns A's bytes into B's.
    const patchFor = Effect.fn("Updates.patchFor")(function* (headers: Headers.Headers, hash: string) {
      const offered = headers["a-im"]?.split(",").some((token) => {
        const match = /^bsdiff(?:\s*;\s*q\s*=\s*(0(?:\.\d{0,3})?|1(?:\.0{0,3})?))?$/i.exec(token.trim());
        return match !== null && (match[1] === undefined || Number(match[1]) > 0);
      }) ?? false;
      const baseUpdateId = headers["expo-current-update-id"]?.toLowerCase();
      if (!offered || baseUpdateId === undefined) return null;
      const baseHash = yield* store.launchAssetHash(baseUpdateId);
      if (baseHash === null || !(yield* store.hasPatch(baseHash, hash))) return null;
      const body = yield* assets.get(`patches/${baseHash}/${hash}`);
      return body === null ? null : { body, baseUpdateId };
    });

    const asset = handle(
      Effect.fn("Updates.asset")(function* () {
        const { hash } = yield* HttpRouter.schemaPathParams(HashParam).pipe(badRequestOn("Invalid asset hash."));
        const request = yield* HttpServerRequest.HttpServerRequest;
        const clientId = request.headers["eas-client-id"];
        const patch = yield* patchFor(request.headers, hash).pipe(
          Effect.catchTag("StorageError", (error) => Effect.logWarning("Patch unavailable, serving full asset", { cause: error }).pipe(
            Effect.as(null),
          )),
        );
        if (patch !== null) {
          yield* afterResponse(metrics.record({ event: "asset", clientId, hash, outcome: "patch" }));
          return HttpServerResponse.stream(patch.body, {
            status: 226,
            contentType: "application/octet-stream",
            headers: {
              im: "bsdiff",
              "expo-base-update-id": patch.baseUpdateId,
              "cache-control": "private, max-age=0",
            },
          });
        }
        const contentType = yield* store.assetContentType(hash);
        const body = contentType === null ? null : yield* assets.get(`assets/${hash}`);
        if (contentType === null || body === null) {
          return yield* Effect.fail(new NotFound({ message: "Unknown asset." }));
        }
        yield* afterResponse(metrics.record({ event: "asset", clientId, hash, outcome: "full" }));
        // Workers Cache keys on Vary: a cached full bundle must not shadow a
        // patch for devices that offer bsdiff from a different base.
        return HttpServerResponse.stream(body, {
          contentType,
          headers: {
            "cache-control": "public, max-age=31536000, immutable",
            "cache-tag": "asset",
            vary: "A-IM, Expo-Current-Update-ID",
          },
        });
      })(),
    );

    const missingAssets = handle(
      authorized(
        Effect.fn("Updates.missingAssets")(function* () {
          const { hashes } = yield* HttpServerRequest.schemaBodyJson(MissingInput).pipe(
            badRequestOn("Expected a JSON body with a list of hashes."),
          );
          return HttpServerResponse.jsonUnsafe({ missing: yield* store.missingAssets(hashes) });
        })(),
      ),
    );

    const putAsset = handle(
      authorized(
        Effect.fn("Updates.putAsset")(function* () {
          const { hash } = yield* HttpRouter.schemaPathParams(HashParam).pipe(badRequestOn("Invalid asset hash."));
          const request = yield* HttpServerRequest.HttpServerRequest;
          const bytes = new Uint8Array(yield* request.arrayBuffer.pipe(badRequestOn("Could not read the body.")));
          if ((yield* sha256Base64Url(bytes)) !== hash) {
            return yield* Effect.fail(new BadRequest({ message: "The body does not match the hash." }));
          }
          const contentType = request.headers["content-type"] ?? "application/octet-stream";
          yield* assets.put(`assets/${hash}`, bytes, contentType);
          yield* store.insertAsset({ hash, contentType, size: bytes.length });
          return HttpServerResponse.jsonUnsafe({ hash, size: bytes.length });
        })(),
      ),
    );

    const branchBundles = handle(
      authorized(
        Effect.fn("Updates.branchBundles")(function* () {
          const query = yield* HttpRouter.schemaParams(BundlesQuery).pipe(badRequestOn("Invalid bundle query."));
          const bundles = yield* store.recentLaunchAssets({
            branch: query.name,
            platform: query.platform,
            runtimeVersion: query.runtime,
            limit: query.limit ?? 3,
          });
          return HttpServerResponse.jsonUnsafe({ bundles });
        })(),
      ),
    );

    const putPatch = handle(
      authorized(
        Effect.fn("Updates.putPatch")(function* () {
          const { base, target } = yield* HttpRouter.schemaPathParams(PatchParams).pipe(
            badRequestOn("Invalid patch hashes."),
          );
          const missing = yield* store.missingAssets([...new Set([base, target])]);
          if (missing.length > 0) {
            return yield* Effect.fail(new BadRequest({ message: `Assets not uploaded: ${missing.join(", ")}` }));
          }
          const request = yield* HttpServerRequest.HttpServerRequest;
          const bytes = new Uint8Array(yield* request.arrayBuffer.pipe(badRequestOn("Could not read the body.")));
          yield* assets.put(`patches/${base}/${target}`, bytes, "application/octet-stream");
          yield* store.insertPatch({ baseHash: base, targetHash: target, size: bytes.length });
          return HttpServerResponse.jsonUnsafe({ baseHash: base, targetHash: target, size: bytes.length });
        })(),
      ),
    );

    const publishGroup = handle(
      authorized(
        Effect.fn("Updates.publishGroup")(function* () {
          const input = yield* HttpServerRequest.schemaBodyJson(PublishGroupInput).pipe(
            Effect.mapError((error) => new BadRequest({ message: `Invalid publish request: ${error.message}` })),
          );
          const group = yield* store.publishGroup(input);
          return HttpServerResponse.jsonUnsafe(group, { status: 201 });
        })(),
      ),
    );

    yield* router.add("GET", "/health", HttpServerResponse.jsonUnsafe({ ok: true }));
    yield* router.add("GET", "/manifest", manifest);
    yield* router.add("GET", "/assets/:hash", asset);
    yield* router.add("POST", "/publish/assets/missing", missingAssets);
    yield* router.add("PUT", "/publish/assets/:hash", putAsset);
    yield* router.add("GET", "/publish/branches/:name/bundles", branchBundles);
    yield* router.add("PUT", "/publish/patches/:base/:target", putPatch);
    yield* router.add("POST", "/publish/groups", publishGroup);
  }),
);
