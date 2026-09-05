import { createFileRoute } from "@tanstack/react-router"

interface DashboardEnv {
  readonly UPDATES?: { readonly fetch: typeof fetch }
  readonly OTA_PUBLISH_TOKEN?: string
  readonly OTA_URL?: string
}

/**
 * `/api/admin/overview` on the dashboard is `/admin/overview` on the updates
 * Worker. Only the admin API is exposed by the dashboard.
 */
export function updatesPath(url: URL): string | null {
  return url.pathname.startsWith("/api/admin/")
    ? url.pathname.slice("/api".length) + url.search
    : null
}

export async function forwardUpdates(request: Request, env: DashboardEnv) {
  const url = new URL(request.url)
  const path = updatesPath(url)
  if (path === null) {
    return Response.json({ error: "Not found." }, { status: 404 })
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    if (request.headers.get("origin") !== url.origin) {
      return Response.json(
        { error: "Invalid request origin." },
        { status: 403 }
      )
    }
    if (
      request.headers
        .get("content-type")
        ?.split(";")[0]
        ?.trim()
        .toLowerCase() !== "application/json"
    ) {
      return Response.json(
        { error: "Expected application/json." },
        { status: 415 }
      )
    }
  }
  if (!env.OTA_PUBLISH_TOKEN) {
    return Response.json(
      { error: "OTA_PUBLISH_TOKEN is not set." },
      { status: 500 }
    )
  }
  if (env.UPDATES === undefined && env.OTA_URL === undefined) {
    return Response.json(
      { error: "OTA_URL is not set, so there is no updates server to call." },
      { status: 500 }
    )
  }

  const headers = new Headers({
    authorization: `Bearer ${env.OTA_PUBLISH_TOKEN}`,
  })
  for (const name of ["accept", "content-type"]) {
    const value = request.headers.get(name)
    if (value !== null) headers.set(name, value)
  }
  const actor = request.headers.get("cf-access-authenticated-user-email")
  if (actor !== null) headers.set("x-ota-actor", actor)

  const upstream = new Request(
    new URL(path, env.UPDATES === undefined ? env.OTA_URL : request.url),
    {
      method: request.method,
      headers,
      redirect: "manual",
      ...(request.method === "GET" || request.method === "HEAD"
        ? {}
        : { body: await request.arrayBuffer() }),
    }
  )
  const response =
    env.UPDATES === undefined
      ? await fetch(upstream)
      : await env.UPDATES.fetch(upstream)
  if (response.status >= 300 && response.status < 400) {
    return Response.json(
      { error: "The updates server returned an unexpected redirect." },
      { status: 502 }
    )
  }
  return response
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

        return forwardUpdates(request, {
          ...env,
          OTA_PUBLISH_TOKEN:
            env.OTA_PUBLISH_TOKEN ?? process.env.OTA_PUBLISH_TOKEN,
          OTA_URL: process.env.OTA_URL,
        })
      },
    },
  },
})
