# Expo OTA: self-hosted Expo Updates on Cloudflare

Status: 2026-09-02, phases 1 to 3 implemented, 5 and 6 in progress. Deviations from the original plan are marked *shipped as*.

## Goal

Ship JS-only updates to an Expo app (SDK 57, `expo-updates`) from infrastructure you own,
entirely on Cloudflare, with the parts of EAS Update we actually use: channels, branches, code signing,
gradual rollouts, rollbacks, and a dashboard to operate it. Nothing else.

## Decisions

- Own implementation. `cfota` proved the protocol fits Workers (reference only: asset hashing, multipart
  framing). `xprem` is Go, `codemagic-patch` is not Expo Updates. Neither is ported.
- Protocol version 1 only. SDK 57 clients send it. Protocol 0 requests get 400.
- One Worker owns the data (`apps/updates`). The dashboard never touches D1 or R2; it calls the Worker
  through a service binding. One owner of the store, one place to test it.
- Effect v4 (`4.0.0-rc.112`) everywhere on the server. `Context.Service` + explicit `Layer`s, typed
  errors with `Schema.TaggedError`, `Effect.fn` spans, `HttpRouter.use` routes. Promise interop only at the
  R2 and WebCrypto boundary (`Effect.tryPromise`), inside the owning module.
- SQL through `SqlClient` via Alchemy's `alchemy/SQL/D1` (wraps `@effect/sql-d1`). No ORM. D1 has no
  transactions: multi-row publishes become visible only when `published_at` is stamped last.
- Alchemy (`2.0.0-beta.76`) is the sole infrastructure authority. No `wrangler.toml`. Stages: `prod` and
  `dev_<user>` (`alchemy dev`). One stack; staging vs production is a *channel*, not a second deployment.
- No app auth. Dashboard Worker sits behind Cloudflare Access (Alchemy Worker `access` prop). The
  updates Worker's `/publish/*` and `/admin/*` routes require a bearer token; the dashboard proxy injects it.
- Dashboard: TanStack Start on Workers via `Cloudflare.Website.Vite`, shadcn components only, pathless
  `_dashboard` layout, TanStack Query + one `ManagedRuntime` bridge (`lib/api.ts`), no `useEffect`.
- Runtime version policy: `fingerprint`. Updates are per platform (iOS and Android fingerprints differ),
  grouped by `group_id` like an EAS update group.

## Repository layout

```
expo-ota/
  alchemy.run.ts              composition root: Db, Assets, Updates, Dashboard, outputs
  apps/updates/
    src/worker.ts             Cloudflare.Worker: bindings, secrets, layers, fetch
    src/routes.ts             HttpRouter.use: /manifest, /assets/:hash, /publish/*, /admin/*
    src/protocol.ts           header schema, selection, multipart, directives (pure + store)
    src/rollout.ts            bucket(clientId, updateId) -> 0..99 (pure)
    src/signing.ts            Signer service: RSASSA-PKCS1-v1_5 SHA-256, expo-signature SFV
    src/store.ts              UpdateStore service over SqlClient; memory double for tests
    src/assets.ts             AssetStore service over R2 binding
    src/errors.ts             Schema.TaggedError catalog + http status map
    migrations/0001_init.sql
    src/*.test.ts             vitest + HttpRouter.toWebHandler + layer doubles
  apps/dashboard/             TanStack Start (scaffolded)
    src/routes/$.ts           proxy /api/* -> env.UPDATES.fetch (+ bearer)
    src/lib/api.ts            Schema shapes + ManagedRuntime bridge -> Promise
    src/lib/queries.ts        queryKeys + queryOptions + useHydrated
    src/routes/_dashboard.*   overview, branches.$name, updates.$groupId
  packages/cli/               `ota publish`, run from the app repository's CI
  docs/plan.md
  .refs/                      effect-smol, alchemy, executor, distilled (read-only references)
```

## Data model (D1)

```
branches(name PK, created_at)
channels(name PK, branch_name -> branches, updated_at)
update_groups(id PK, branch_name, message, git_commit, created_at, published_at NULL)
updates(id PK uuid, group_id -> update_groups, platform, runtime_version,
        launch_asset JSON, assets JSON, expo_config JSON, rollout_percent INT DEFAULT 100,
        rollback_to_embedded INT DEFAULT 0, created_at)
  index (group_id), index (platform, runtime_version, created_at DESC)
assets(hash PK base64url-sha256, key md5-hex, content_type, size, created_at)   R2 key = assets/<hash>
patches(base_hash, target_hash, size, created_at, PK(base_hash, target_hash))     R2 key = patches/<base>/<target>
devices(client_id PK, platform, runtime_version, channel, current_update_id, embedded_update_id,
        served_update_id, first_seen_at, last_seen_at)                            upserted off the hot path
```

Selection joins `updates` to `update_groups` on branch and requires `published_at IS NOT NULL`.

## Manifest endpoint (`GET /manifest`)

1. Decode headers with Schema: `expo-protocol-version` = 1, `expo-platform` ios|android,
   `expo-runtime-version`, `expo-channel-name` (required, app sets it via `requestHeaders`),
   `expo-current-update-id`, `expo-embedded-update-id`, `expo-expect-signature`, `eas-client-id`.
   Failure = 400 with a JSON error.
2. Channel -> branch. Unknown channel logs a warning and answers `noUpdateAvailable`.
3. Load the two newest published updates for (branch, platform, runtime).
   None -> `noUpdateAvailable` directive (never 404; cfota's 404 makes every fresh build log a failed check).
4. Rollout: if newest has `rollout_percent < 100`, `bucket = sha256(clientId + ":" + updateId) % 100`;
   `bucket >= percent` -> serve the previous update instead (or `noUpdateAvailable` if none).
5. Rollback row: `rollBackToEmbedded` directive with `commitTime = created_at`, unless the device is
   already on the embedded update.
6. `currentUpdateId === candidate.id` -> `noUpdateAvailable`.
7. Manifest: `{ id, createdAt, runtimeVersion, launchAsset, assets, metadata: { branchName }, extra: { expoClient } }`.
   Asset `url` = `${origin}/assets/${hash}`. `expoClient` is the *public* config (`expo config --type public`).
8. Response: `multipart/mixed`, parts `manifest` (+ `extensions` with empty `assetRequestHeaders`) or
   `directive`. Headers: `expo-protocol-version: 1`, `expo-sfv-version: 0`, `cache-control: private, max-age=0`,
   `expo-manifest-filters: branchname="<branch>"` (mirrors EAS so cached updates from another branch are not launched).
9. Signing: when `expo-expect-signature` is present, sign the exact part bytes with the private key,
   `expo-signature: sig="<base64>", keyid="main"` on the manifest or directive part. Cert generated with
   `npx expo-updates codesigning:generate`; certificate lives in the app repository, key in an Alchemy secret.

`GET /assets/:hash`: R2 object, `content-type` from the asset row, `cache-control: public, max-age=31536000, immutable`.
404 when missing. *Shipped with* Workers Cache (`Cloudflare.Workers.cache({ enabled, crossVersionCache })` at init) instead of
the legacy Cache API: the immutable header alone makes the tiered cache serve repeat asset requests without invoking the
Worker, `crossVersionCache` keeps content-addressed assets warm across deploys, `Vary: A-IM, Expo-Current-Update-ID` keeps a
cached full bundle from shadowing a patch, patch responses are `private`, and every other route says `no-store`.

After the response is built, `ctx.waitUntil` upserts the `devices` row and writes one Analytics Engine data point
(event, platform, runtime, channel, current id, served id, outcome). Neither adds latency to the manifest answer.

## Delta patches (bsdiff)

Verified against the SDK 57 client (`FileDownloader.swift`, enabled by default via `enableBsdiffPatchSupport`):
the client requests only the launch asset with `A-IM: bsdiff` plus `Expo-Current-Update-ID` when the launched
update differs from the requested one. The server may answer `226` with `IM: bsdiff`,
`expo-base-update-id: <launched update id>` and a bsdiff body; the client applies it to its current bundle, checks
the result against the manifest hash, and falls back to a full download on any mismatch. Anything else is a plain 200.

- Patches are computed by the CLI on the CI runner, never in a Worker (bsdiff needs about 17x the bundle in memory;
  Workers cap at 128 MB). The CLI asks `GET /publish/branches/:name/bundles?platform&runtime&limit=3` for the newest
  launch-asset hashes, downloads them from `/assets/:hash`, runs bsdiff, and `PUT /publish/patches/:base/:target`.
- `GET /assets/:hash` with `A-IM: bsdiff`: look up the base update's launch-asset hash by `Expo-Current-Update-ID`,
  then the `patches` row; serve the patch with the 226 headers when it exists, else the full asset. Patches carry
  `cache-control: private` keyed by base id, so the Cache API entry stays per pair.

## Adoption metrics

Two stores, both written from the manifest handler off the hot path:

- `devices` in D1 answers "now": devices per update, per runtime version, per channel; devices served X that still
  report an older `current_update_id` (failed or pending); runtime versions with no device at all (fingerprint drift
  warning). Exact counts, one row per device.
- Analytics Engine dataset (`Cloudflare.AnalyticsEngine.Dataset`, `WriteDataset` binding) answers "over time":
  checks per hour, downloads and patch hit rate per update, adoption curve after a publish. Queried through the SQL
  API with a `Config.redacted("CF_API_TOKEN")`; 3-month retention is enough.
- Update health without an SDK: after a launch crash the client rolls back and its next check carries
  `Expo-Recent-Failed-Update-IDs` (up to five ids) and `Expo-Fatal-Error` (1024 chars). Stored in
  `device_update_failures(client_id, update_id, fatal_error)`; `/admin/metrics` reports `faulty` per update and the
  crash messages grouped per update. Health percent = running / (running + faulty), floored, like xprem.
- `online` = devices seen in the last 20 minutes.
- Geo segments from `request.cf` (`country`, `city`, free on every plan; `cf-ipcountry` header as fallback): stored on the
  device row and in every Analytics Engine point; `/admin/metrics` reports `countries` and per-update `segments`
  (running and faulty per country), which is xprem's health-by-segment without a telemetry SDK.
- Dashboard: `GET /admin/metrics`; charts use the shadcn Chart component.

## Publish API (bearer `OTA_PUBLISH_TOKEN`)

- `POST /publish/assets/missing` `{ hashes }` -> `{ missing }` (content-addressed dedupe; a typical publish uploads only the bundles).
- `PUT /publish/assets/:hash` raw body + `content-type`; server re-hashes, rejects mismatches, writes `assets/<hash>` to R2, inserts the row.
- `POST /publish/groups` `{ branch, message, gitCommit, rolloutPercent?, expoConfig, updates: { ios: { runtimeVersion, launchAsset, assets } | { runtimeVersion, rollbackToEmbedded: true }, android: {...} } }`
  *Shipped with* `rolloutPercent` at publish time (like `eas update --rollout-percentage`) and rollback rows, so the CLI can do both without the dashboard.
  -> creates branch if missing, inserts group + per-platform rows, stamps `published_at`, returns ids.
  Every referenced hash must exist in `assets`, else 400 and nothing is stamped.
- `GET /publish/branches/:name/bundles?platform&runtime&limit` newest launch-asset hashes on the branch, for diffing.
- `PUT /publish/patches/:base/:target` raw bsdiff body -> R2 `patches/<base>/<target>` + row. Both hashes must exist.

## Admin API (same bearer, only reached via the dashboard service binding)

- `GET /admin/overview` channels -> branch -> newest group per runtime version.
- `GET /admin/branches/:name/groups?runtime=` paginated groups with rollout state.
- `POST /admin/channels/:name { branch }` repoint a channel.
- `POST /admin/groups/:id/promote { branch, message? }` republish the group onto a branch (new ids, same assets).
  *Shipped as* the single mechanism for both promotion and rollback: promoting to the group's own branch is the rollback.
- `POST /admin/groups/:id/rollout { percent }` 0..100.
- `GET /admin/branches/:name/rollback-plan` one row per build the branch serves (platform, runtime): the current update, the
  previous *different* bundle (a republish of the same content is skipped), and the device count. The dashboard's Roll back
  dialog is rendered from this, so nobody types a runtime version.
- `POST /admin/branches/:name/rollback { targets: [{ platform, runtimeVersion, mode: previous | embedded }], message? }`
  publishes one group per runtime version with the chosen rows; 404 names the build when "previous" has nothing to go to.
- `POST /admin/branches/:name/rollback-to-embedded { runtimeVersion, platforms, message? }` insert directive rows (kept for the CLI).
- `POST /admin/groups/:id/promote` also takes `rolloutPercent`, so a promotion can start as a canary.
- Actor: the dashboard forwards the Cloudflare Access email as `x-ota-actor`; the CLI sends the commit author (or `OTA_ACTOR`).
  Stored as `update_groups.actor` and shown as "Promoted by …".
- `POST /admin/channels/:name { branch }` also creates the channel when it does not exist yet.
- `GET /admin/metrics` *shipped as* one route: devices per (channel, platform, runtime) so drift is judged per channel, running/served/faulty per update id, crash messages, countries, per-update country segments, and `online`. Analytics Engine series are written but not yet queried.

## CLI (`packages/cli`, `ota publish`)

Runs inside the app repository: `expo export --platform ios --platform android`, `expo config --type public --json`,
`expo-updates runtimeversion:resolve --platform <p>` per platform, hashes `dist/` files exactly like Expo's
reference server (hash = base64url sha256, key = md5 hex, `.hbc` bundles as `application/javascript`),
then calls the publish endpoints. After the group is published it diffs the new bundle against the newest three
on the same branch, platform and runtime (`bsdiff` binary on the runner) and uploads the patches; a failed diff
is logged and skipped, never fatal. Node 22+, `fetch` + `node:crypto` only. Env: `OTA_URL`, `OTA_PUBLISH_TOKEN`.

## Dashboard

Pages (all inside `_dashboard`): Overview (channels x runtime versions, devices per runtime, checks per hour),
Branch (groups table with adoption column, rollout slider, promote, rollback, roll back to embedded), Group detail
(per-platform ids, assets, patch hit rate, adoption curve, config, message, commit).
Nav in `app-sidebar.tsx`: Overview, Branches, Channels. Replace the block's placeholder data.
Data: `lib/api.ts` = Schema shapes + `ManagedRuntime.make(FetchHttpClient.layer)` + `runPromise`; every read is
`useQuery(queryOptions)` gated on `useHydrated()`; every write is `useMutation` + `invalidateQueries` in a handler.

## Infrastructure (`alchemy.run.ts`)

```
Db        = Cloudflare.D1.Database("Db", { migrations: "./apps/updates/migrations" })
Assets    = Cloudflare.R2.Bucket("Assets")                      private; served by the Worker
Metrics   = Cloudflare.AnalyticsEngine.Dataset("Metrics")        WriteDataset binding in the Worker
Updates   = Cloudflare.Worker (apps/updates/src/worker.ts)       yields QueryDatabase(Db), ReadWriteBucket(Assets),
                                                                 WriteDataset(Metrics), Config.redacted("OTA_SIGNING_KEY"),
                                                                 Config.redacted("OTA_PUBLISH_TOKEN"), Config.redacted("CF_API_TOKEN")
                                                                 domain: OTA_UPDATES_DOMAIN (optional)
Dashboard = Cloudflare.Website.Vite("Dashboard", { rootDir: "./apps/dashboard",
              env: { UPDATES: Updates, OTA_PUBLISH_TOKEN }, access from OTA_ACCESS_EMAIL_DOMAINS / OTA_ACCESS_EMAILS,
              domain: OTA_DASHBOARD_DOMAIN (optional) })
outputs   = { updatesUrl, dashboardUrl }
```

Local: `pnpm cloud:dev` runs the Worker on local D1/R2 simulators and the dashboard's Vite dev server.
`@cloudflare/vite-plugin` must NOT be added (Alchemy injects its own). `cloudflare:workers` is external in vite config.

## App repository changes

- `pnpm add --filter app expo-updates`; commit `certs/certificate.pem`.
- `app.config.ts` `updates`: `url: "https://u.example.com/manifest"`, `codeSigningCertificate`,
  `codeSigningMetadata: { keyid: "main", alg: "rsa-v1_5-sha256" }`,
  `requestHeaders: { "expo-channel-name": appVariant === "production" ? "production" : "staging" }`,
  `checkAutomatically: "ON_LOAD"`, `fallbackToCacheTimeout: 0`; `runtimeVersion: { policy: "fingerprint" }`.
- CI: on merge to `release`, `ota publish --branch staging --message "$COMMIT_SUBJECT"`. Promotion to
  `production` is a dashboard action. The publish job must run from the same lockfile and patches as the native
  build or the fingerprint will never match and updates silently stop applying. The dashboard shows runtime
  versions with no known native build so this is visible.

## Phases

1. Worker core: migration, store (+ memory double), manifest and assets routes, signing, rollout, tests.
2. Publish API + CLI + app wiring; first update applied on a dev-client build against `dev_<user>` stage.
3. Dashboard: api bridge, overview, branch, group pages; Access policy; deploy `prod`.
4. Promote, rollout, rollbacks end to end; CI publish job; runbook in `docs/`.
5. Adoption metrics: `devices` upsert, Analytics Engine data points, metrics routes, dashboard charts.
6. Delta patches: bundles endpoint, CLI diffing, patch upload, `A-IM` handling on the asset route, hit-rate metric.

## Out of scope

Branch-vs-branch channel rollouts (a channel split across two branches by percentage; additive later as
`channels.rollout_branch_name` + percent), per-device targeting (pinning a client id or cohort to a branch through
`expo-server-defined-headers`; staging builds already cover testers), multi-app support, user accounts.
