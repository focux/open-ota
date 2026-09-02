import { createFileRoute } from "@tanstack/react-router"

interface DashboardEnv {
  readonly UPDATES?: { readonly fetch: typeof fetch }
  readonly OTA_PUBLISH_TOKEN?: string
}

/**
 * `/api/admin/overview` on the dashboard is `/admin/overview` on the updates
 * Worker. Anything outside `/api/` is not ours to forward.
 */
export function updatesPath(url: URL): string | null {
  return url.pathname.startsWith("/api/")
    ? url.pathname.slice("/api".length) + url.search
    : null
}

/**
 * The admin API lives behind a bearer token the browser never sees. Deployed,
 * the request goes over the service binding; under a plain `vite dev` there is
 * no binding, so it goes over the network to OTA_URL instead.
 */
export const Route = createFileRoute("/$")({
  server: {
    handlers: {
      ANY: async ({ request }) => {
        const path = updatesPath(new URL(request.url))
        if (path === null) {
          return Response.json({ error: "Not found." }, { status: 404 })
        }

        // The binding module exists only inside the Cloudflare runtime.
        const env: DashboardEnv = await import("cloudflare:workers")
          .then((module) => module.env as DashboardEnv)
          .catch(() => ({}))

        const token = env.OTA_PUBLISH_TOKEN ?? process.env.OTA_PUBLISH_TOKEN
        const headers = new Headers(request.headers)
        headers.delete("host")
        // Cloudflare Access already proved who this is; the updates server
        // records it as the actor on anything published from here.
        const actor = request.headers.get("cf-access-authenticated-user-email")
        if (actor !== null) headers.set("x-ota-actor", actor)
        if (token !== undefined) {
          headers.set("authorization", `Bearer ${token}`)
        }
        const init: RequestInit = {
          method: request.method,
          headers,
          ...(request.method === "GET" || request.method === "HEAD"
            ? {}
            : { body: await request.text() }),
        }

        if (env.UPDATES !== undefined) {
          return env.UPDATES.fetch(
            new Request(new URL(path, request.url), init)
          )
        }
        const origin = process.env.OTA_URL
        if (origin === undefined) {
          return Response.json(
            {
              error:
                "OTA_URL is not set, so there is no updates server to call.",
            },
            { status: 500 }
          )
        }
        return fetch(new URL(path, origin), init)
      },
    },
  },
})
