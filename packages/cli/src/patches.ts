import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Platform, Run } from "./expo.ts";
import { branchBundles, downloadAsset, uploadPatch, type Server } from "./server.ts";

export interface PatchTarget {
  readonly platform: Platform;
  readonly runtimeVersion: string;
  readonly hash: string;
  readonly bytes: Uint8Array;
}

export interface PatchOptions {
  branch: string;
  targets: ReadonlyArray<PatchTarget>;
  server: Server;
  run: Run;
  log: (message: string) => void;
}

const reason = (error: unknown) => (error instanceof Error ? error.message : String(error));

// bsdiff needs about 17x the bundle in memory, so patches are built here on the
// runner and uploaded. A patch that fails to build is skipped, never fatal.
export const generatePatches = async (options: PatchOptions) => {
  const { branch, server, run, log } = options;
  for (const target of options.targets) {
    try {
      const bundles = await branchBundles(server, branch, target.platform, target.runtimeVersion, 3);
      const bases = bundles.filter((bundle) => bundle.hash !== target.hash);
      if (bases.length === 0) continue;
      const dir = await mkdtemp(path.join(tmpdir(), "ota-patch-"));
      try {
        const targetFile = path.join(dir, "target.bundle");
        await writeFile(targetFile, target.bytes);
        for (const base of bases) {
          try {
            const baseFile = path.join(dir, `${base.hash}.bundle`);
            const patchFile = path.join(dir, `${base.hash}.patch`);
            await writeFile(baseFile, await downloadAsset(server, base.hash));
            await run("bsdiff", [baseFile, targetFile, patchFile], dir);
            const patch = await readFile(patchFile);
            await uploadPatch(server, base.hash, target.hash, patch);
            log(`patch ${base.hash.slice(0, 7)}..${target.hash.slice(0, 7)} ${patch.length}`);
          } catch (error) {
            log(`warning: no patch from ${base.hash.slice(0, 7)}: ${reason(error)}`);
          }
        }
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    } catch (error) {
      log(`warning: no patches for ${target.platform}: ${reason(error)}`);
    }
  }
};
