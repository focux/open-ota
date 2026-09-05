# Hermes delta fixtures

Copied from the MIT-licensed [xprem bsdiff testdata](https://github.com/mercuretechnologies/xprem/tree/5f23b935a7c4132c718709ba21a62d43359d6c81/internal/bsdiff/testdata):

- `v1.hbc`: base Hermes bundle.
- `v2.hbc`: target Hermes bundle.
- `v1-to-v2.patch`: BSDIFF40 delta from base to target.

The upstream MIT notice is retained in `LICENSE`. No enterprise files are included.

`patches.test.ts` uploads these bytes through the publish API, downloads the patch through the
asset endpoint, and applies the downloaded response with the host's `bspatch` binary. The rebuilt
bytes must equal `v2.hbc` and match the target asset hash. This verifies transport and standard
BSDIFF40 compatibility; it does not run Hermes or Expo's iOS/Android downloader.
