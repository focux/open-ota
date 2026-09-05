# Contributing

Development setup, the local stack, and the test commands are in the
[README](README.md#development).

## Releasing the CLI

The `open-ota` CLI on npm is published by the `Release CLI` workflow, which runs on a `v*.*.*` tag
and refuses to publish when the tag and `packages/cli/package.json` disagree:

```sh
pnpm --filter open-ota version patch
git commit -am "chore(cli): release v0.1.4"
git tag v0.1.4
git push --follow-tags
```

The workflow publishes with `pnpm publish`, not `npm publish`: the package depends on the workspace
catalog, and only pnpm rewrites `catalog:` to real versions when it packs.

There is no publish token. npm authenticates the job through a [trusted
publisher](https://docs.npmjs.com/trusted-publishers/) bound to this repository and
`.github/workflows/release.yml`, and signs provenance itself.

That path depends on pnpm 10, pinned by the root `packageManager`. pnpm has no official OIDC support
([pnpm#9812](https://github.com/pnpm/pnpm/issues/9812)) and pnpm 11 regressed it to a 404
([pnpm#11513](https://github.com/pnpm/pnpm/issues/11513)). If a release ever fails with a 404 that
looks like a permissions error, check the pnpm major version first. The fix is to pack with pnpm and
publish the tarball with npm, which uses npm's own supported OIDC path:

```sh
pnpm --filter open-ota pack --pack-destination "$RUNNER_TEMP"
npm publish "$RUNNER_TEMP/open-ota-<version>.tgz" --access public
```
