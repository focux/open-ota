# open-ota

Publishes an Expo app's JS bundle to a self-hosted [Open OTA](https://github.com/focux/open-ota)
server. Follow the [server setup guide](https://github.com/focux/open-ota#quick-start) first, then
install the CLI in your app so local runs and CI use the same version:

```sh
npm install --save-dev --save-exact open-ota
```

Run commands with `npx open-ota` from the app directory. The examples below use
`open-ota` as shorthand.

```sh
npx open-ota publish --branch staging --message "Fix payment sheet"
```

It checks configuration, credentials, signing, and active rollouts before exporting both platforms.
It resolves each platform's runtime version, uploads missing assets, optionally builds bsdiff
patches against up to three distinct previous bundles, and then publishes the update group. Patches
go first so no device can fetch the new bundle before its patch exists. `bsdiff` must be on PATH;
otherwise patches are skipped with a warning.

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
open-ota init --channel <name> [--certificate ./certs/certificate.pem]
open-ota doctor [--channel <name>] [--platform ios|android]
open-ota publish --branch <name> [--message <text>] [--rollout <0-100>]
                 [--platform ios] [--platform android] [--skip-export] [--dist <dir>]
                 [--no-patches] [--project <dir>] [--server <url>] [--token <token>]
open-ota rollback-to-embedded --branch <name> [--platform ios|android] [--message <text>]
open-ota --help
```

`--rollout` starts the group as a canary; the remaining devices keep the previous update until the
rollout is widened in the dashboard. Only one active rollout is allowed per branch, platform, and runtime.
Complete it at 100% or use Roll back before publishing or promoting another update for that build.
The server enforces this atomically, including concurrent publishers. Rollout percentages cannot decrease.

`rollback-to-embedded` publishes a group that sends devices matching the selected platforms and
the runtime versions resolved from this project back to the JS baked into their builds. Other runtime
versions are unaffected. Publish-only flags such as `--rollout` are rejected for rollback.

Requires Node 20 or newer and the Expo CLI of the app it runs in.

## Set up and check an app

Install `expo-updates` in the app first with `npx expo install expo-updates`. Copy the server's public
`certs/certificate.pem` into the app, configure credentials, and choose an existing channel. New deployments include `staging` and
`production`; create any additional channels in the dashboard.

```sh
open-ota init --channel staging
open-ota doctor
```

`init` verifies credentials and the server's signature before changing files. For static `app.json`,
it sets fingerprint runtimes, the update URL, channel, and code signing. Existing unrelated fields
are preserved and the original is saved as `app.json.open-ota.bak`; an existing backup is never
replaced. It runs `doctor` after writing. Review the diff and ship a new native build.

For `app.config.ts` or JavaScript config, `init` prints a JSON snippet without editing the file.
Merge it into the returned Expo config, keeping environment-specific channel selection, then run
`doctor` with the same environment as the native build. URL, channel, and certificate changes need
a new native build; they cannot reach installed apps through an OTA update.

`doctor` checks resolved Expo config, certificate validity, server authentication, channel mapping,
per-platform runtime versions, fleet observations, and a signed manifest or directive. `--channel`
asserts the configured channel; it does not override the app. No observed devices is a warning for
a fresh app, and a signed no-update response proves connectivity and signing, not device delivery.
Doctor probes do not register fake devices. Local Expo commands and server checks have a shared
60-second deadline. Publish runs these checks before exporting, including with `--skip-export`.

Both commands accept `--project`, `--server`, `--token`, `--platform`, `--verbose`, and `--json`.
Doctor JSON contains `channel`, `branch`, and per-platform `runtimes`. Init JSON has a `mode` of
`configured` (with check results) or `snippet` (with fields to merge).

## Terminal output

Interactive terminals show a spinner for each stage, elapsed times, and completed asset counts.
CI, redirected output, `TERM=dumb`, and `--verbose` use plain progress lines. Set `NO_COLOR` to
disable colors. Progress, warnings, and the human-readable summary go to stderr.

Use `--verbose` to stream subprocess output and show individual patch diagnostics. Patch failures
are warnings: the update still publishes and devices can download full bundles. Install `bsdiff`
on PATH to generate patches, or pass `--no-patches` to skip them.

Use `--json` to write one result object to stdout for scripts:

```sh
npx open-ota publish --branch staging --json > published.json
```

The object contains `command`, `server`, `branch`, `message`, `groupId`, and `updates` (each with
`id`, `platform`, and `runtimeVersion`). Publish results also include `rolloutPercent`.
Progress remains on stderr. Fatal errors exit with status 1 and do not write a result object;
optional patch failures still return a successful result.

`open-ota --version` prints the installed version. Run `open-ota publish --help` or
`open-ota rollback-to-embedded --help` for command-specific options and examples.

Command parsing, validation, help, and version output use Effect 4's `effect/unstable/cli`.
Generate shell completions with `open-ota --completions bash` (also supports zsh, fish, and sh).

Publishing runs inside the command's Effect scope. File access, HTTP requests, subprocesses, and
progress use Effect services; interrupting the command cancels in-flight work and releases temporary
patch directories. Tokens remain redacted until the HTTP or terminal boundary.
