import { BsdiffError, type Bsdiff } from "@open-ota/bsdiff";
import { Context, Effect, Layer } from "effect";
import { PatchError, StorageError } from "./errors.ts";

// Applies a bsdiff patch. The server runs every uploaded patch through it
// before storing it, so the only patches devices ever see are ones that
// provably rebuild the target.
export class PatchEngine extends Context.Service<
  PatchEngine,
  { readonly apply: (base: Uint8Array, patch: Uint8Array) => Effect.Effect<Uint8Array, PatchError> }
>()("expo-ota/PatchEngine") {
  // Outside the Worker runtime nothing can be verified, so nothing is accepted.
  static readonly unavailable = Layer.succeed(PatchEngine, {
    apply: () => Effect.fail(new PatchError({ code: "unavailable", message: "The patch engine is not loaded." })),
  });

  static readonly fromBsdiff = (bsdiff: Bsdiff) =>
    Layer.succeed(PatchEngine, {
      apply: Effect.fn("PatchEngine.apply")((base: Uint8Array, patch: Uint8Array) =>
        Effect.try({
          try: () => bsdiff.patch(base, patch),
          catch: (cause) =>
            cause instanceof BsdiffError
              ? new PatchError({ code: cause.code, message: `The patch could not be applied: ${cause.message}` })
              : new PatchError({ code: "unknown", message: `The patch could not be applied: ${String(cause)}` }),
        }),
      ),
    });
}

export interface PatchPolicyShape {
  // A patch is stored only when it is at most this share of what the full
  // bundle costs over the wire. Above it the patch is not worth a second
  // request path.
  readonly maxRatio: number;
  // Bundles above this get no patches: verifying one holds the base, the patch
  // and the rebuilt bundle in Worker memory at once.
  readonly maxBundleBytes: number;
}

export class PatchPolicy extends Context.Service<PatchPolicy, PatchPolicyShape>()("expo-ota/PatchPolicy") {
  static readonly defaults: PatchPolicyShape = { maxRatio: 0.3, maxBundleBytes: 32 * 1024 * 1024 };
}

export interface AssetSizes {
  readonly contentType: string;
  readonly size: number;
  readonly compressedSize: number | null;
}

// Cloudflare compresses these at the edge, so the device downloads the gzip
// size, not the raw one. Everything else goes out as stored.
export const isCompressible = (contentType: string): boolean =>
  /^(text\/|application\/(javascript|x-javascript|ecmascript|json|xml|ld\+json)|image\/svg\+xml)/i.test(contentType);

// What a device downloads when it takes the full asset.
export const wireSize = (asset: AssetSizes): number =>
  isCompressible(asset.contentType) && asset.compressedSize !== null ? asset.compressedSize : asset.size;

export type PatchDecision =
  | { readonly stored: true; readonly wireSize: number; readonly ratio: number }
  | { readonly stored: false; readonly reason: "bundle-too-large" | "too-large"; readonly wireSize: number; readonly ratio: number };

export const patchDecision = (
  policy: PatchPolicyShape,
  target: AssetSizes,
  base: AssetSizes,
  patchSize: number,
): PatchDecision => {
  const wire = wireSize(target);
  const ratio = wire === 0 ? Number.POSITIVE_INFINITY : patchSize / wire;
  if (target.size > policy.maxBundleBytes || base.size > policy.maxBundleBytes) {
    return { stored: false, reason: "bundle-too-large", wireSize: wire, ratio };
  }
  if (patchSize > policy.maxRatio * wire) {
    return { stored: false, reason: "too-large", wireSize: wire, ratio };
  }
  return { stored: true, wireSize: wire, ratio };
};

// Gzip is what the edge applies; the count is all that is kept.
export const gzipSize = Effect.fn("Patching.gzipSize")((body: ReadableStream<Uint8Array> | Uint8Array) =>
  Effect.tryPromise({
    try: async () => {
      const source = body instanceof Uint8Array ? new Blob([body as Uint8Array<ArrayBuffer>]).stream() : body;
      const reader = (source as ReadableStream<BufferSource>).pipeThrough(new CompressionStream("gzip")).getReader();
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return total;
        total += value.length;
      }
    },
    catch: (cause) => new StorageError({ message: "Could not measure the compressed size.", cause }),
  }),
);
