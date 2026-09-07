import type { RuntimeContext } from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import { Context, DateTime, Effect, Schema } from "effect";
import { Headers, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { AssetStore } from "./assets.ts";
import { base64UrlToHex, sha256Base64Url } from "./crypto.ts";
import { BadRequest, NotFound, StorageError } from "./errors.ts";
import { bearer, badRequestOn, handle } from "./http.ts";
import { Metrics } from "./metrics.ts";
import { AssetHash, BranchName, EmbeddedUpdateInput, Platform, PublishGroupInput } from "./model.ts";
import { PatchEngine, PatchPolicy, gzipSize, patchDecision } from "./patching.ts";
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
const StrictHashParam = Schema.Struct({ hash: AssetHash });
const PatchParams = Schema.Struct({ base: AssetHash, target: AssetHash });
const Runtime = Schema.String.check(Schema.isNonEmpty());
const BundlesQuery = Schema.Struct({
  name: Schema.String,
  platform: Platform,
  runtime: Runtime,
  limit: Schema.optional(Schema.NumberFromString.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 10 }))),
});
const PatchBasesQuery = Schema.Struct({
  name: BranchName,
  platform: Platform,
  runtime: Runtime,
  // The bundle about to be published; it is never its own base.
  target: AssetHash,
  limit: Schema.optional(Schema.NumberFromString.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 12 }))),
});
const MissingInput = Schema.Struct({ hashes: Schema.Array(Schema.String) });
const encoder = new TextEncoder();

// Devices in the field are counted from check-ins this recent.
const fleetWindowDays = 30;

// Full bundles never change, so they are cached for a year. Serving one to a
// device that asked for a patch is the one answer that can change, once a
// patch for its base lands, so that answer is held briefly.
const immutable = "public, max-age=31536000, immutable";
const untilPatchExists = "public, max-age=300";
const negotiationVary = "A-IM, Expo-Current-Update-ID";

export const routes = HttpRouter.use(
  Effect.fn("Updates.routes")(function* (router) {
    const store = yield* UpdateStore;
    const assets = yield* AssetStore;
    const metrics = yield* Metrics;
    const signer = yield* Signer;
    const auth = yield* PublishAuth;
    const engine = yield* PatchEngine;
    const policy = yield* PatchPolicy;

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
    const json = (value: unknown, status = 200) => HttpServerResponse.jsonUnsafe(value, { status });

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
      if (!offered || baseUpdateId === undefined || baseUpdateId === "") return { negotiated: false as const, patch: null };
      const baseHash = yield* store.launchAssetHash(baseUpdateId);
      const size = baseHash === null ? null : yield* store.patchSize(baseHash, hash);
      if (baseHash === null || size === null) return { negotiated: true as const, patch: null };
      const body = yield* assets.get(`patches/${baseHash}/${hash}`);
      return { negotiated: true as const, patch: body === null ? null : { body, baseUpdateId, size } };
    });

    const asset = handle(
      Effect.fn("Updates.asset")(function* () {
        const { hash } = yield* HttpRouter.schemaPathParams(HashParam).pipe(badRequestOn("Invalid asset hash."));
        const request = yield* HttpServerRequest.HttpServerRequest;
        const clientId = request.headers["eas-client-id"];
        const negotiation = yield* patchFor(request.headers, hash).pipe(
          Effect.catchTag("StorageError", (error) => Effect.logWarning("Patch unavailable, serving full asset", { cause: error }).pipe(
            Effect.as({ negotiated: true as const, patch: null }),
          )),
        );
        if (negotiation.patch !== null) {
          const { body, baseUpdateId, size } = negotiation.patch;
          yield* afterResponse(metrics.record({ event: "asset", clientId, hash, outcome: "patch", bytes: size }));
          // A patch is fixed by (target, base update), which is exactly what
          // the cache key varies on, so it is as immutable as the bundle.
          return HttpServerResponse.stream(body, {
            status: 226,
            contentType: "application/octet-stream",
            headers: {
              im: "bsdiff",
              "expo-base-update-id": baseUpdateId,
              "cache-control": immutable,
              "cache-tag": "asset, patch",
              vary: negotiationVary,
            },
          });
        }
        const info = yield* store.assetInfo(hash);
        const body = info === null ? null : yield* assets.get(`assets/${hash}`);
        if (info === null || body === null) {
          return yield* Effect.fail(new NotFound({ message: "Unknown asset." }));
        }
        yield* afterResponse(metrics.record({ event: "asset", clientId, hash, outcome: "full", bytes: info.size }));
        // Workers Cache keys on Vary: a cached full bundle must not shadow a
        // patch for devices that offer bsdiff from a different base.
        return HttpServerResponse.stream(body, {
          contentType: info.contentType,
          headers: {
            "cache-control": negotiation.negotiated ? untilPatchExists : immutable,
            "cache-tag": "asset",
            vary: negotiationVary,
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
          const missing = yield* store.missingAssets(hashes);
          // A publish that learns an asset is present will reference it shortly;
          // the sweep must not take it in between.
          const absent = new Set(missing);
          yield* store.touchAssets(hashes.filter((hash) => !absent.has(hash)));
          return json({ missing });
        })(),
      ),
    );

    const putAsset = handle(
      authorized(
        Effect.fn("Updates.putAsset")(function* () {
          const { hash } = yield* HttpRouter.schemaPathParams(StrictHashParam).pipe(badRequestOn("Invalid asset hash."));
          const request = yield* HttpServerRequest.HttpServerRequest;
          const contentType = request.headers["content-type"] ?? "application/octet-stream";
          const web = yield* HttpServerRequest.toWeb(request).pipe(badRequestOn("Invalid request."));
          const declared = Number(request.headers["content-length"]);
          const key = `assets/${hash}`;
          const checksum = base64UrlToHex(hash);
          let size: number;
          let compressedSize: number;
          if (web.body !== null && Number.isInteger(declared) && declared >= 0) {
            // The body goes straight into R2, which checks the hash as it lands,
            // while its twin is gzipped to learn what the asset costs over the wire.
            const [stored, measured] = web.body.tee();
            const [, compressed] = yield* Effect.all(
              [assets.put(key, { stream: stored, size: declared }, { contentType, sha256: checksum }), gzipSize(measured)],
              { concurrency: 2 },
            );
            size = declared;
            compressedSize = compressed;
          } else {
            const bytes = new Uint8Array(yield* request.arrayBuffer.pipe(badRequestOn("Could not read the body.")));
            if ((yield* sha256Base64Url(bytes)) !== hash) {
              return yield* Effect.fail(new BadRequest({ message: "The body does not match the hash." }));
            }
            yield* assets.put(key, { bytes }, { contentType, sha256: checksum });
            size = bytes.length;
            compressedSize = yield* gzipSize(bytes);
          }
          yield* store.insertAsset({ hash, contentType, size, compressedSize });
          return json({ hash, size, compressedSize });
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
          return json({ bundles });
        })(),
      ),
    );

    // The bundles worth diffing a new one against: what devices on the branch
    // run today, what fresh installs start from, and what was published last.
    const patchBases = handle(
      authorized(
        Effect.fn("Updates.patchBases")(function* () {
          const query = yield* HttpRouter.schemaParams(PatchBasesQuery).pipe(badRequestOn("Invalid patch base query."));
          const now = yield* DateTime.now;
          const bases = yield* store.patchBases({
            branch: query.name,
            platform: query.platform,
            runtimeVersion: query.runtime,
            exclude: query.target,
            limit: query.limit ?? 8,
            fleetSince: DateTime.formatIso(DateTime.subtract(now, { days: fleetWindowDays })),
          });
          return json({ bases, maxRatio: policy.maxRatio, maxBundleBytes: policy.maxBundleBytes });
        })(),
      ),
    );

    const putPatch = handle(
      authorized(
        Effect.fn("Updates.putPatch")(function* () {
          const { base, target } = yield* HttpRouter.schemaPathParams(PatchParams).pipe(
            badRequestOn("Invalid patch hashes."),
          );
          const [baseInfo, targetInfo] = yield* Effect.all([store.assetInfo(base), store.assetInfo(target)]);
          const missing = [
            ...(baseInfo === null ? [base] : []),
            ...(targetInfo === null || target === base ? [] : []),
            ...(targetInfo === null ? [target] : []),
          ];
          if (baseInfo === null || targetInfo === null) {
            return yield* Effect.fail(new BadRequest({ message: `Assets not uploaded: ${[...new Set(missing)].join(", ")}` }));
          }
          const request = yield* HttpServerRequest.HttpServerRequest;
          const bytes = new Uint8Array(yield* request.arrayBuffer.pipe(badRequestOn("Could not read the body.")));
          const decision = patchDecision(policy, targetInfo, baseInfo, bytes.length);
          if (!decision.stored) {
            return json({
              stored: false,
              reason: decision.reason,
              baseHash: base,
              targetHash: target,
              size: bytes.length,
              wireSize: decision.wireSize,
              ratio: decision.ratio,
              maxRatio: policy.maxRatio,
            });
          }
          // The trust boundary: the patch is applied here, with the same
          // algorithm the device runs, and must rebuild the target exactly.
          const baseBytes = yield* assets.getBytes(`assets/${base}`);
          if (baseBytes === null) {
            return yield* Effect.fail(new StorageError({ message: "The base bundle is missing from storage." }));
          }
          const rebuilt = yield* engine.apply(baseBytes, bytes);
          if ((yield* sha256Base64Url(rebuilt as Uint8Array<ArrayBuffer>)) !== target) {
            return yield* Effect.fail(new BadRequest({ message: "The patch does not rebuild the target bundle." }));
          }
          yield* assets.put(`patches/${base}/${target}`, { bytes }, { contentType: "application/octet-stream" });
          yield* store.insertPatch({ baseHash: base, targetHash: target, size: bytes.length });
          return json({
            stored: true,
            baseHash: base,
            targetHash: target,
            size: bytes.length,
            wireSize: decision.wireSize,
            ratio: decision.ratio,
          });
        })(),
      ),
    );

    const registerEmbedded = handle(
      authorized(
        Effect.fn("Updates.registerEmbedded")(function* () {
          const input = yield* HttpServerRequest.schemaBodyJson(EmbeddedUpdateInput).pipe(
            Effect.mapError((error) => new BadRequest({ message: `Invalid embedded update: ${error.message}` })),
          );
          yield* store.insertEmbedded({
            updateId: input.updateId.toLowerCase(),
            platform: input.platform,
            runtimeVersion: input.runtimeVersion,
            launchAssetHash: input.launchAsset.hash,
          });
          return json({ updateId: input.updateId.toLowerCase() }, 201);
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
          return json(group, 201);
        })(),
      ),
    );

    yield* router.add("GET", "/health", HttpServerResponse.jsonUnsafe({ ok: true }));
    yield* router.add("GET", "/manifest", manifest);
    yield* router.add("GET", "/assets/:hash", asset);
    yield* router.add("POST", "/publish/assets/missing", missingAssets);
    yield* router.add("PUT", "/publish/assets/:hash", putAsset);
    yield* router.add("GET", "/publish/branches/:name/bundles", branchBundles);
    yield* router.add("GET", "/publish/branches/:name/patch-bases", patchBases);
    yield* router.add("PUT", "/publish/patches/:base/:target", putPatch);
    yield* router.add("POST", "/publish/embedded", registerEmbedded);
    yield* router.add("POST", "/publish/groups", publishGroup);
  }),
);
