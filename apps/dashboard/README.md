# Open OTA dashboard

TanStack Start on Cloudflare Workers. The dashboard reads and mutates the updates
Worker through `/api/admin/*`; D1 and R2 belong to the updates Worker.

Run `pnpm dev` from the repository root for the local Alchemy stack. To run only
the dashboard, set `OTA_URL` and `OTA_PUBLISH_TOKEN`, then run
`pnpm --filter dashboard dev`. Deployed requests use the `UPDATES` service binding
and the Cloudflare Access identity.

`src/lib/api.ts` owns response schemas and the Effect-to-Promise bridge.
`src/lib/queries.ts` owns query keys and pagination. Pages use TanStack Query for
reads and mutations; failed reads keep an explanation and a retry action visible.

Validation:

```sh
pnpm --filter dashboard check
pnpm --filter dashboard lint
pnpm --filter dashboard test
pnpm --filter dashboard build
```

Add UI components through the registry configured in `components.json` before
writing a custom primitive. See the root [engineering
conventions](../../AGENTS.md).
