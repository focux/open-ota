# Expo OTA

Self-hosted over-the-air updates for Expo apps, running entirely on Cloudflare.

Point `expo-updates` at a server you deploy with one command, publish from CI, and operate
channels, rollouts and rollbacks from a dashboard. No EAS subscription, no servers to patch,
no per-update pricing.

## Features

- **Speaks the Expo Updates protocol, version 1.** Works with the stock `expo-updates` library.
  No fork, no client SDK, nothing to add to your app beyond the standard config.
- **Code signing.** Every manifest and directive is signed with your RSA key; the app verifies
  them against the certificate baked into the build.
- **Channels, branches, update groups.** The same model as EAS Update, with the same words, so
  nothing new to learn.
- **Gradual rollouts.** Publish to 10 percent, widen it, complete it. Devices are bucketed
  deterministically, so nobody flips back and forth.
- **Rollbacks that know your fleet.** One dialog per branch shows every build in the field, what
  it runs, what it would go back to, and how many devices are affected. Previous update or the
  build's embedded JS, per build.
- **Delta patches.** bsdiff patches between bundles are built at publish time and served to
  devices that offer them, so most updates download kilobytes, not megabytes.
- **Health without telemetry.** After a launch crash the client rolls back and reports it on its
  next check. The dashboard shows adoption, faulty devices, crash messages and per-country
  segments from that alone.
- **Edge cached.** Assets are content-addressed and immutable; Workers Cache serves repeat
  downloads globally without invoking the Worker.
- **Access, not accounts.** The dashboard sits behind Cloudflare Access. There is no user table.
- **One stack, one command.** Workers, D1, R2, Analytics Engine, custom domains and the Access
  policy are declared in a single Alchemy stack and deployed with `pnpm cloud:deploy:prod`.

## How it works

```
  expo-updates  ── GET /manifest ─────►  Updates Worker  ──►  D1  (channels, branches, updates, devices)
     (device)   ◄─ signed multipart ──         │          ──►  R2  (assets/<sha256>, patches/<base>/<target>)
                ── GET /assets/:hash ─►  Workers Cache    ──►  Analytics Engine (check-ins, downloads)
                                               ▲
  ota publish   ── PUT assets, POST group ─────┤  bearer token
     (CI)                                      │
  Dashboard     ── /api/* over a service binding, behind Cloudflare Access
```

On every launch the app asks `/manifest` with its platform, runtime version, channel and the update
it currently runs. The Worker maps the channel to a branch, picks the newest published update for
that runtime, applies the rollout bucket, and answers with a signed manifest, a
`rollBackToEmbedded` directive, or `noUpdateAvailable`. Assets are fetched by hash. If the device
offers `A-IM: bsdiff` and a patch exists from the bundle it runs, it gets a `226` patch instead of
the full bundle.

## Requirements

- A Cloudflare account. Workers, D1, R2 and Analytics Engine are all on the free tier for
  small apps; Workers Cache bills cache hits as requests.
- An Expo app using `expo-updates` with protocol version 1 (any current SDK). Delta patches need
  `expo-updates` 55 or newer and are on by default from 56.0.13. The fingerprint runtime policy is
  recommended.
- Node 24 and pnpm 10 to deploy; Node 20+ wherever the CLI runs; `bsdiff` on the publishing
  machine for delta patches (`brew install bsdiff` or `apt install bsdiff`).

## Quick start

### 1. Deploy the server

```sh
git clone https://github.com/<you>/open-ota && cd open-ota
pnpm install
pnpm cloud:login                                  # one-time Cloudflare login
npx expo-updates codesigning:generate \
  --key-output-directory .keys \
  --certificate-output-directory certs \
  --certificate-validity-duration-years 10 \
  --certificate-common-name "Your App"
cp .env.example .env                              # then fill it in, see Configuration
pnpm cloud:deploy:prod
```

The deploy prints `updatesUrl` and `dashboardUrl`. Open the dashboard; Cloudflare Access asks you
to sign in with an allowed email.

### 2. Configure your app

```ts
// app.config.ts
export default {
  runtimeVersion: { policy: "fingerprint" },
  updates: {
    url: "https://u.example.com/manifest",
    checkAutomatically: "ON_LOAD",
    codeSigningCertificate: "./certs/certificate.pem",
    codeSigningMetadata: { keyid: "main", alg: "rsa-v1_5-sha256" },
    requestHeaders: { "expo-channel-name": isProduction ? "production" : "staging" },
  },
  plugins: ["expo-updates"],
}
```

Copy `certs/certificate.pem` from the server repo into the app. Ship a native build; the channel
and the certificate are part of it.

### 3. Publish

From the app directory:

```sh
export OTA_URL=https://u.example.com          # the updatesUrl printed by the deploy
export OTA_PUBLISH_TOKEN=...                   # the token the server was deployed with
npx open-ota publish --branch staging --message "Fix payment sheet"
```

`--server` and `--token` flags override the environment variables, and `OTA_ACTOR` sets who the
publish is credited to (default: the commit author). The CLI exports both platforms, resolves each platform's runtime version, uploads only assets the
server does not have, publishes the group, then builds and uploads bsdiff patches against the
newest three bundles on the branch. Promote to `production` from the dashboard, with a rollout
percentage if you want a canary.

## Configuration

Everything is read from the environment or `.env` when you deploy.

| Variable | Purpose |
| --- | --- |
| `OTA_PUBLISH_TOKEN` | Bearer token for `/publish/*` and `/admin/*`. Any long random string. |
| `OTA_SIGNING_KEY` | PEM private key that signs manifests. PKCS#1 or PKCS#8. In `.env`, one line in double quotes with newlines as `\n`. |
| `OTA_UPDATES_DOMAIN` | Custom hostname for the updates Worker, for example `u.example.com`. Empty means the workers.dev URL. |
| `OTA_DASHBOARD_DOMAIN` | Custom hostname for the dashboard, for example `ota.example.com`. Empty means the workers.dev URL. |
| `OTA_ACCESS_EMAIL_DOMAINS` | Comma-separated email domains allowed into the dashboard. |
| `OTA_ACCESS_EMAILS` | Comma-separated individual emails allowed in. |

At least one allow-list variable is required on every stage except `dev_<user>`, so the dashboard
never deploys without Access. Custom domains are ignored on dev stages, so one `.env` serves every
stage safely. Domains must be on a zone in your Cloudflare account; the deploy provisions the DNS
records and certificates. Keep the updates hostname and the dashboard hostname separate: devices
must reach the first anonymously, and Access protects the second.

## Deploying

| Command | What it does |
| --- | --- |
| `pnpm dev` | Runs the Worker on local D1 and R2 simulators and the dashboard with hot reload. |
| `pnpm cloud:plan` | Shows what a deploy would change. No writes. |
| `pnpm cloud:deploy` | Deploys your `dev_<user>` stage to Cloudflare on workers.dev URLs. |
| `pnpm cloud:deploy:prod` | Deploys the `prod` stage with the custom domains and the Access policy. |
| `pnpm cloud:destroy` | Tears down the current stage. R2 refuses while the bucket has objects. |

Deploys are idempotent. Migrations in `apps/updates/migrations` are applied in order and skipped
when already applied. Staging versus production is a channel, not a second deployment: one stack
serves every channel.

### Publishing from GitHub Actions

```yaml
- run: npx open-ota@latest publish --branch staging --message "${{ github.event.head_commit.message }}"
  working-directory: apps/mobile
  env:
    OTA_URL: ${{ vars.OTA_URL }}
    OTA_PUBLISH_TOKEN: ${{ secrets.OTA_PUBLISH_TOKEN }}
```

Store the token as a repository secret and the origin as a repository variable. The runner needs
`bsdiff` on the PATH for delta patches; without it the publish still succeeds and patches are skipped.

The publish must run from the same dependency state as the native build, or the fingerprint will
not match and the update reaches nobody. The dashboard flags runtime versions that have devices but
no matching update, which is how that mistake shows up.

## The dashboard

The vocabulary is EAS Update's. A **channel** is what a build points at and is **linked** to a
**branch**. A branch is a stream of **update groups**, one per publish, each holding one update per
platform for a **runtime version**.

- **Overview** answers "what is each channel serving right now?": adoption and health per build,
  devices online, devices by country, and a warning when devices report a runtime version the
  channel's branch has nothing for.
- **Promote** copies a group to another branch, with a rollout percentage. Promoting to the same
  branch is **Republish**, which makes an older group the served one again.
- **Roll back** opens one dialog per branch, prefilled from the fleet: every build goes back to its
  previous update, or to its embedded JS when there is none.
- **Rollouts** only increase; 100 completes one.
- **Change linked branch** points a channel at another branch, for example to test a feature
  branch on staging builds.

Every action records who did it, from the Cloudflare Access identity. CLI publishes carry the
commit author.

## Caching and delivery

- Assets are stored under the SHA-256 of their bytes and served with
  `cache-control: public, max-age=31536000, immutable`. Workers Cache serves repeat downloads from
  Cloudflare's tiered cache without running the Worker; the cache survives deploys because the
  keys never change meaning.
- A publish uploads only the assets the server does not already have, typically the two
  Hermes bundles.
- Patch responses are private and vary on the device's current update, so a cached full bundle
  never shadows a patch.
- Manifests are never cached. Every launch is one D1 query.

## Security

- Manifests and directives are signed with RSASSA-PKCS1-v1_5 over SHA-256, the only algorithm
  `expo-updates` accepts. The private key lives in a Worker secret; the certificate lives in the app.
- The publish and admin routes take a bearer token. The dashboard holds it as a Worker binding and
  the browser never sees it.
- The dashboard is reachable only through Cloudflare Access. There are no accounts, sessions or
  passwords in this codebase.
- Device traffic is anonymous by design. The server stores a per-device client id, platform,
  runtime version, channel, country and city, nothing else.

## Repository layout

```
alchemy.run.ts          the stack: D1, R2, Analytics Engine, both Workers, domains, Access
apps/updates            the updates Worker (Effect, HttpRouter, SqlClient over D1)
  migrations/           SQL migrations applied by the deploy
  src/protocol.ts       manifest selection, multipart framing, hashing
  src/store.ts          every query, with an in-memory double for tests
  src/routes.ts         device and publish routes
  src/admin.ts          dashboard routes
apps/dashboard          TanStack Start on Workers, shadcn components only
packages/cli            `open-ota` on npm, zero runtime dependencies
docs/plan.md            design notes and the decisions behind them
```

Built with [Alchemy](https://alchemy.run), [Effect](https://effect.website), TanStack Start and
shadcn/ui.

## Development

```sh
pnpm install
pnpm dev          # local stack with hot reload
pnpm -r check     # typecheck every package
pnpm -r test      # Worker (memory and SQLite stores), CLI, dashboard
pnpm -r build     # dashboard production build and the CLI's dist
```

Releasing the CLI: bump `packages/cli/package.json`, then `pnpm --filter open-ota publish`.
`prepublishOnly` compiles `src` to `dist`, which is all the package ships.

## Non-goals

Branch-versus-branch channel rollouts, per-device targeting, launch-timing telemetry, and
multi-app hosting. Each is a real feature in EAS or xprem; none is needed to ship one app well.
Contributions that keep the codebase small are welcome.

## License

MIT.
