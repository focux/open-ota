import path from "node:path";
import { Effect, FileSystem } from "effect";
import { Processes, type Platform } from "./expo.ts";
import { Progress } from "./output.ts";
import { Server } from "./server.ts";

export interface PatchTarget {
  platform: Platform;
  runtimeVersion: string;
  hash: string;
  bytes: Uint8Array;
}

export const generatePatches = Effect.fn("patches.generate")(function* (options: {
  branch: string;
  targets: ReadonlyArray<PatchTarget>;
}) {
  const server = yield* Server;
  const processes = yield* Processes;
  const progress = yield* Progress;
  const fs = yield* FileSystem.FileSystem;
  let uploaded = 0;
  let skipped = 0;
  let failed = 0;
  let missingBsdiff = false;
  yield* progress.report({ type: "start", message: "Preparing optional delta patches" });
  for (const target of options.targets) {
    yield* Effect.gen(function* () {
      // The new bundle is not published yet, so it only appears here when the
      // same bytes were published before; ask for one extra row to cover that.
      const bundles = yield* server.branchBundles(options.branch, target.platform, target.runtimeVersion, 4);
      const bases = [...new Set(bundles.map((bundle) => bundle.hash))]
        .filter((hash) => hash !== target.hash)
        .slice(0, 3);
      if (bases.length === 0) return;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "ota-patch-" });
      const targetFile = path.join(dir, "target.bundle");
      yield* fs.writeFile(targetFile, target.bytes);
      for (const base of bases) {
        const result = yield* Effect.result(
          Effect.gen(function* () {
            const baseFile = path.join(dir, "base.bundle");
            const patchFile = path.join(dir, "delta.patch");
            yield* fs.writeFile(baseFile, yield* server.downloadAsset(base));
            yield* processes.run("bsdiff", [baseFile, targetFile, patchFile], dir);
            const patch = yield* fs.readFile(patchFile);
            if (patch.length >= target.bytes.length) {
              skipped++;
              yield* progress.report({
                type: "detail",
                message: `Skipped patch from ${base.slice(0, 7)}: no smaller than the full bundle`,
              });
              return;
            }
            yield* server.uploadPatch(base, target.hash, patch);
            uploaded++;
            yield* progress.report({
              type: "progress",
              message: `Uploaded ${uploaded} delta patch${uploaded === 1 ? "" : "es"}`,
            });
            yield* progress.report({
              type: "detail",
              message: `${target.platform}: patch ${base.slice(0, 7)} to ${target.hash.slice(0, 7)}, ${patch.length} bytes`,
            });
          }),
        );
        if (result._tag === "Failure") {
          failed++;
          const error = result.failure;
          yield* progress.report({
            type: "detail",
            message: `Patch from ${base.slice(0, 7)} failed: ${error.message}`,
          });
          if (error._tag === "ProcessFailure" && error.missing) {
            missingBsdiff = true;
            break;
          }
        }
      }
    }).pipe(
      Effect.scoped,
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
    if (missingBsdiff) break;
  }
  yield* progress.report({
    type: failed > 0 ? "warning" : "success",
    message: `Delta patches: ${uploaded} uploaded, ${skipped} skipped, ${failed} failed`,
  });
  if (failed > 0) {
    yield* progress.report({
      type: "warning",
      message: `The update still publishes. Devices without a delta patch will download the full bundle. ${missingBsdiff ? "Install bsdiff on PATH or use --no-patches to skip this step." : "Run with --verbose for patch diagnostics."}`,
    });
  } else if (uploaded === 0 && skipped === 0) {
    yield* progress.report({ type: "info", message: "No previous bundles available for delta patches." });
  }
});
