# open-ota

Publishes an Expo app's JS bundle to a self-hosted [Expo OTA](https://github.com/focux/expo-ota)
server. Run it from the app directory after deploying the server.

```sh
npx open-ota publish --branch staging --message "Fix payment sheet"
```

It runs `expo export` for both platforms, resolves each platform's runtime version, uploads only the
assets the server does not already have, publishes the update group, then builds bsdiff patches
against the newest three bundles on the branch and uploads them (`bsdiff` must be on the PATH,
otherwise patches are skipped with a warning).

## Credentials

| Setting | Env var | Flag | Value |
| --- | --- | --- | --- |
| Server origin | `OTA_URL` | `--server` | The `updatesUrl` printed by the server deploy, for example `https://u.example.com` |
| Publish token | `OTA_PUBLISH_TOKEN` | `--token` | The `OTA_PUBLISH_TOKEN` the server was deployed with |
| Actor | `OTA_ACTOR` | | Optional. Who the publish is credited to; defaults to the commit author |

Flags win over environment variables. In CI, store the token as a secret and the origin as a
variable. Locally, export them in your shell or put them in a `.env` your shell loads; the CLI does
not read `.env` files itself.

## Commands

```
open-ota publish --branch <name> [--message <text>] [--rollout <0-100>]
                 [--platform ios] [--platform android] [--skip-export] [--dist <dir>]
                 [--no-patches] [--project <dir>] [--server <url>] [--token <token>]
open-ota rollback-to-embedded --branch <name> [--platform ios|android] [--message <text>]
open-ota --help
```

`--rollout` starts the group as a canary; the remaining devices keep the previous update until the
rollout is widened in the dashboard. `rollback-to-embedded` publishes a group that sends every
device on the branch back to the JS baked into its build.

Requires Node 20 or newer and the Expo CLI of the app it runs in.
