# @open-ota/bsdiff

BSDIFF40 diff and patch compiled to WebAssembly. It produces the patches the
`bspatch` inside `expo-updates` applies, and applies them itself so a server can
verify a patch before storing it.

- `diff(old, target)` is bsdiff 4.3 over a suffix array.
- `patch(old, patch)` is bspatch 4.3 with every length checked before use.
- One 130 KB module, no native dependencies, no threads. Runs in Node 20+ and
  in Cloudflare Workers.

```ts
import { loadBsdiff } from "@open-ota/bsdiff/node";

const bsdiff = await loadBsdiff();
const delta = bsdiff.diff(oldBundle, newBundle);
const rebuilt = bsdiff.patch(oldBundle, delta);
```

In a Worker, import the module and instantiate it, since Workers do not compile
WebAssembly from bytes at runtime:

```ts
import wasm from "@open-ota/bsdiff/bsdiff.wasm";
import { instantiate } from "@open-ota/bsdiff";

const bsdiff = await instantiate(wasm);
```

Failures throw `BsdiffError` with a `code`: `too-large`, `corrupt-patch`,
`compression`, or `out-of-memory`.

## Building the module

`bsdiff.wasm` is committed and reproducible: the build remaps source and
registry paths, so the pinned toolchain produces the same bytes on any machine,
and CI checks the committed file against a fresh build. To rebuild it after
changing `crate/`, install Rust (`rustup` picks up the pinned toolchain from
`crate/rust-toolchain.toml`) and run:

```sh
pnpm --filter @open-ota/bsdiff build:wasm
```

`fixtures/` holds a Hermes bundle pair and a patch made by the reference bsdiff,
from xprem's MIT-licensed test data. The tests apply that patch, round-trip our
own, and hand ours to the system `bspatch` when it is installed.
