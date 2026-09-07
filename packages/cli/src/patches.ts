import { gzipSync } from "node:zlib";
import { readFile } from "node:fs/promises";
import { instantiate, type Bsdiff } from "@open-ota/bsdiff";
import { Context, Effect, Layer } from "effect";
import { CliFailure } from "./errors.ts";
import type { Platform } from "./expo.ts";
import { Progress } from "./output.ts";
import { Server } from "./server.ts";

export interface PatchTarget {
  platform: Platform;
  runtimeVersion: string;
  hash: string;
  bytes: Uint8Array;
}

// The bsdiff engine, compiled on first use so commands that never diff do not pay for it.
export class Differ extends Context.Service<
  Differ,
  {
    diff(old: Uint8Array, target: Uint8Array): Effect.Effect<Uint8Array, CliFailure>;
    patch(old: Uint8Array, patch: Uint8Array): Effect.Effect<Uint8Array, CliFailure>;
  }
>()("cli/Differ") {
  static readonly layer = Layer.sync(Differ, () => {
    let loading: Promise<Bsdiff> | undefined;
    const engine = Effect.tryPromise({
      try: () => (loading ??= loadEngine()),
      catch: (cause) => new CliFailure({ message: "Could not load the bundled bsdiff engine.", cause }),
    });
    const run = (operation: "diff" | "patch") => (first: Uint8Array, second: Uint8Array) =>
      engine.pipe(
        Effect.flatMap((bsdiff) =>
          Effect.try({
            try: () => bsdiff[operation](first, second),
            catch: (cause) =>
              new CliFailure({ message: `bs${operation} failed: ${cause instanceof Error ? cause.message : String(cause)}`, cause }),
          }),
        ),
      );
    return Differ.of({ diff: run("diff"), patch: run("patch") });
  });
}

// Published, the module sits next to the bundle in dist/; from source it is
// the workspace engine package's build output.
const moduleLocations = [new URL("./bsdiff.wasm", import.meta.url), new URL("../../bsdiff/bsdiff.wasm", import.meta.url)];

const loadEngine = async (): Promise<Bsdiff> => {
  let failure: unknown;
  for (const location of moduleLocations) {
    try {
      return await instantiate(await readFile(location));
    } catch (cause) {
      failure = cause;
    }
  }
  throw new Error("bsdiff.wasm is missing from the open-ota package.", { cause: failure });
};

const short = (hash: string) => hash.slice(0, 7);
const percent = (ratio: number) => `${Math.round(ratio * 100)}%`;
const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && Buffer.from(a).equals(Buffer.from(b));

export const generatePatches = Effect.fn("patches.generate")(function* (options: {
  branch: string;
  targets: ReadonlyArray<PatchTarget>;
  // Bases that already have a patch toward the target, left alone.
  skip?: ReadonlySet<string>;
}) {
  const server = yield* Server;
  const differ = yield* Differ;
  const progress = yield* Progress;
  let uploaded = 0;
  let skipped = 0;
  let failed = 0;
  yield* progress.report({ type: "start", message: "Preparing delta patches" });
  for (const target of options.targets) {
    yield* Effect.gen(function* () {
      const { bases, maxRatio, maxBundleBytes } = yield* server.patchBases(
        options.branch,
        target.platform,
        target.runtimeVersion,
        target.hash,
      );
      if (target.bytes.length > maxBundleBytes) {
        skipped++;
        yield* progress.report({
          type: "detail",
          message: `${target.platform}: bundle is ${target.bytes.length} bytes, above the server's ${maxBundleBytes}-byte patch limit`,
        });
        return;
      }
      const candidates = bases.filter((base) => !options.skip?.has(base.hash));
      if (candidates.length === 0) return;
      // The launch asset is JavaScript, which the edge compresses: a patch
      // competes with the gzipped bundle, not the raw one.
      const wire = gzipSync(target.bytes).length;
      const budget = Math.floor(maxRatio * wire);
      for (const base of candidates) {
        const result = yield* Effect.result(
          Effect.gen(function* () {
            const baseBytes = yield* server.downloadAsset(base.hash);
            const patch = yield* differ.diff(baseBytes, target.bytes);
            const ratio = patch.length / wire;
            if (patch.length > budget) {
              skipped++;
              yield* progress.report({
                type: "detail",
                message: `Skipped patch from ${short(base.hash)}: ${patch.length} bytes is ${percent(ratio)} of the ${wire}-byte compressed bundle, over the ${percent(maxRatio)} limit`,
              });
              return;
            }
            // Proven here before upload; the server proves it again before storing.
            if (!same(yield* differ.patch(baseBytes, patch), target.bytes)) {
              return yield* new CliFailure({ message: "the patch does not rebuild the target bundle" });
            }
            const outcome = yield* server.uploadPatch(base.hash, target.hash, patch);
            if (!outcome.stored) {
              skipped++;
              yield* progress.report({
                type: "detail",
                message: `Server declined patch from ${short(base.hash)}: ${outcome.reason} (${outcome.size} bytes, ${percent(outcome.ratio)} of ${outcome.wireSize})`,
              });
              return;
            }
            uploaded++;
            yield* progress.report({
              type: "progress",
              message: `Uploaded ${uploaded} delta patch${uploaded === 1 ? "" : "es"}`,
            });
            const why = base.source === "fleet" ? `${base.devices} device${base.devices === 1 ? "" : "s"} run it` : base.source === "embedded" ? "embedded in a build" : "recently published";
            yield* progress.report({
              type: "detail",
              message: `${target.platform}: patch ${short(base.hash)} to ${short(target.hash)}, ${patch.length} bytes, ${percent(ratio)} of the compressed bundle (${why})`,
            });
          }),
        );
        if (result._tag === "Failure") {
          failed++;
          yield* progress.report({
            type: "detail",
            message: `Patch from ${short(base.hash)} failed: ${result.failure.message}`,
          });
        }
      }
    }).pipe(
      Effect.catch((error) =>
        Effect.gen(function* () {
          failed++;
          yield* progress.report({
            type: "detail",
            message: `Patches for ${target.platform} failed: ${error.message}`,
          });
        }),
      ),
    );
  }
  yield* progress.report({
    type: failed > 0 ? "warning" : "success",
    message: `Delta patches: ${uploaded} uploaded, ${skipped} skipped, ${failed} failed`,
  });
  if (failed > 0) {
    yield* progress.report({
      type: "warning",
      message: "The update still publishes. Devices without a delta patch will download the full bundle. Run with --verbose for patch diagnostics.",
    });
  } else if (uploaded === 0 && skipped === 0) {
    yield* progress.report({ type: "info", message: "No previous bundles available for delta patches." });
  }
  return { uploaded, skipped, failed };
});
