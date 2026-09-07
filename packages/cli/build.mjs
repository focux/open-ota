// The published package must stand alone: the engine lives in a workspace
// package, so it is bundled into dist/cli.js and its module copied next to it.
// Every other dependency stays external and installs from npm as usual.
import { build } from "esbuild";
import { copyFile, mkdir } from "node:fs/promises";

await mkdir("dist", { recursive: true });
await build({
  entryPoints: ["src/cli.ts"],
  outfile: "dist/cli.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  packages: "external",
  alias: {
    "@open-ota/bsdiff": "../bsdiff/src/index.ts",
    "@open-ota/bsdiff/node": "../bsdiff/src/node.ts",
  },
  sourcemap: false,
  logLevel: "warning",
});
await copyFile("../bsdiff/bsdiff.wasm", "dist/bsdiff.wasm");
