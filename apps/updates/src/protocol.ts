import { Effect, Schema } from "effect";
import type { BundleUpdate, RollbackUpdate, Update } from "./model.ts";
import { Platform } from "./model.ts";
import { rolloutBucket } from "./rollout.ts";

export const ManifestHeaders = Schema.Struct({
  "expo-protocol-version": Schema.Literals(["1"]),
  "expo-platform": Platform,
  "expo-runtime-version": Schema.String.check(Schema.isNonEmpty()),
  "expo-channel-name": Schema.String.check(Schema.isNonEmpty()),
  "expo-current-update-id": Schema.optional(Schema.String),
  "expo-embedded-update-id": Schema.optional(Schema.String),
  "expo-expect-signature": Schema.optional(Schema.String),
  "eas-client-id": Schema.optional(Schema.String),
  // Sent on the check after an update crashed at launch and was rolled back.
  "expo-recent-failed-update-ids": Schema.optional(Schema.String),
  "expo-fatal-error": Schema.optional(Schema.String),
});

// A structured-field list of quoted strings: `"id-1", "id-2"`.
export const parseFailedUpdateIds = (header: string | undefined): ReadonlyArray<string> => {
  const ids = new Set<string>();
  // Expo reports at most five failed launches. Bound parsing as well as writes.
  for (const entry of header?.slice(0, 512).split(",") ?? []) {
    const match = /^"([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})"$/i.exec(entry.trim());
    if (match !== null) ids.add(match[1]!.toLowerCase());
    if (ids.size === 5) break;
  }
  return [...ids];
};
export type ManifestHeaders = typeof ManifestHeaders.Type;

// Why a check was answered the way it was. `none` is the answer support has
// to explain, so every branch that produces one names itself.
export const NoUpdateReason = Schema.Literals([
  // The channel the build asks for points at no branch.
  "unknown-channel",
  // The branch has nothing published for this platform and runtime version.
  "no-update-for-runtime",
  // Outside the newest update's rollout bucket, with nothing older to fall back to.
  "rollout-excluded",
  "already-current",
  // A rollback directive the device has already carried out.
  "already-embedded",
]);
export type NoUpdateReason = typeof NoUpdateReason.Type;

export const DecisionReason = Schema.Literals([
  "manifest",
  "rollback",
  "unknown-channel",
  "no-update-for-runtime",
  "rollout-excluded",
  "already-current",
  "already-embedded",
]);
export type DecisionReason = typeof DecisionReason.Type;

export const DecisionKind = Schema.Literals(["manifest", "rollback", "none"]);
export type DecisionKind = typeof DecisionKind.Type;

export type Decision =
  | { readonly kind: "manifest"; readonly reason: "manifest"; readonly update: BundleUpdate }
  | { readonly kind: "rollback"; readonly reason: "rollback"; readonly update: RollbackUpdate }
  | { readonly kind: "none"; readonly reason: NoUpdateReason };

const none = (reason: NoUpdateReason): Decision => ({ kind: "none", reason });

// `candidates` are the newest published updates first. A partial rollout on the
// newest one sends devices outside the bucket to the one before it.
export const decide = Effect.fn("Protocol.decide")(function* (
  candidates: ReadonlyArray<Update>,
  headers: ManifestHeaders,
) {
  const newest = candidates[0];
  // The caller knows whether the channel itself was the problem; from here an
  // empty candidate list only means the branch serves nothing for this build.
  if (newest === undefined) return none("no-update-for-runtime");
  let chosen: Update | undefined = newest;
  if (newest.rolloutPercent < 100) {
    const clientId = headers["eas-client-id"];
    const bucket = clientId === undefined || clientId === "" ? 100 : yield* rolloutBucket(clientId, newest.id);
    if (bucket >= newest.rolloutPercent) chosen = candidates[1];
  }
  if (chosen === undefined) return none("rollout-excluded");
  const current = headers["expo-current-update-id"]?.toLowerCase();
  if (chosen.kind === "rollback") {
    return current !== undefined && current !== "" && current === headers["expo-embedded-update-id"]?.toLowerCase()
      ? none("already-embedded")
      : ({ kind: "rollback", reason: "rollback", update: chosen } satisfies Decision);
  }
  return current === chosen.id ? none("already-current") : ({ kind: "manifest", reason: "manifest", update: chosen } satisfies Decision);
});

export const manifestJson = (update: BundleUpdate, origin: string) => {
  const asset = (stored: BundleUpdate["launchAsset"]) => ({
    hash: stored.hash,
    key: stored.key,
    contentType: stored.contentType,
    fileExtension: stored.fileExtension,
    url: `${origin}/assets/${stored.hash}`,
  });
  return {
    id: update.id,
    createdAt: update.createdAt,
    runtimeVersion: update.runtimeVersion,
    launchAsset: asset(update.launchAsset),
    assets: update.assets.map(asset),
    metadata: { branchName: update.branch },
    extra: { expoClient: update.expoConfig },
  };
};

export interface Part {
  readonly name: string;
  readonly body: Uint8Array<ArrayBuffer>;
  readonly headers: Readonly<Record<string, string>>;
}

export const multipartBody = (parts: ReadonlyArray<Part>, boundary: string): Uint8Array<ArrayBuffer> => {
  const encoder = new TextEncoder();
  const chunks: Array<Uint8Array<ArrayBuffer>> = [];
  for (const part of parts) {
    const headers = Object.entries({ ...part.headers, "content-disposition": `form-data; name="${part.name}"` })
      .map(([name, value]) => `${name}: ${value}\r\n`)
      .join("");
    chunks.push(encoder.encode(`--${boundary}\r\n${headers}\r\n`), part.body, encoder.encode("\r\n"));
  }
  chunks.push(encoder.encode(`--${boundary}--\r\n`));
  const out = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
};
