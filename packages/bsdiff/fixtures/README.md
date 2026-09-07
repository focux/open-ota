# BSDIFF40 fixtures

Copied from the MIT-licensed [xprem bsdiff testdata](https://github.com/mercuretechnologies/xprem/tree/5f23b935a7c4132c718709ba21a62d43359d6c81/internal/bsdiff/testdata):

- `v1.hbc`: base Hermes bundle.
- `v2.hbc`: target Hermes bundle.
- `v1-to-v2.patch`: BSDIFF40 delta from base to target, made by the reference bsdiff.

The upstream MIT notice is retained in `LICENSE`. No enterprise files are included.

Used by the engine tests here (decode the reference patch, round-trip our own,
apply ours with the system `bspatch`) and by the updates Worker tests, which
upload these bytes through the publish API and serve the patch back.
