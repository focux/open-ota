import { afterEach, describe, expect, it, vi } from "vitest"

import { forwardUpdates, updatesPath } from "./$"

afterEach(() => vi.unstubAllGlobals())

describe("updatesPath", () => {
  it("strips the /api prefix and keeps the query string", () => {
    expect(
      updatesPath(
        new URL(
          "https://ota.example.com/api/admin/branches/staging/groups?limit=50"
        )
      )
    ).toBe("/admin/branches/staging/groups?limit=50")
  })

  it("does not forward pages", () => {
    expect(
      updatesPath(new URL("https://ota.example.com/branches/staging"))
    ).toBeNull()
    expect(updatesPath(new URL("https://ota.example.com/api"))).toBeNull()
  })

  it.each([
    "/api//attacker.example/steal",
    "/api/\\attacker.example/steal",
    "/api/publish/groups",
    "/api/assets/hash",
    "/api/admin/../../manifest",
  ])("does not forward paths outside the admin API: %s", (path) => {
    expect(updatesPath(new URL(path, "https://ota.example.com"))).toBeNull()
  })
})

describe("forwardUpdates", () => {
  const origin = "https://updates.example.com"
  const request = (headers?: HeadersInit) =>
    new Request(
      "https://dashboard.example.com/api/admin/channels/beta?test=1",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://dashboard.example.com",
          ...headers,
        },
        body: JSON.stringify({ branch: "staging" }),
      }
    )

  it("forwards admin writes through the binding with only trusted identity headers", async () => {
    const upstreamResponse = Response.json({
      channel: "beta",
      branch: "staging",
    })
    const fetchUpstream = vi
      .fn<typeof fetch>()
      .mockResolvedValue(upstreamResponse)
    const response = await forwardUpdates(
      request({
        authorization: "Bearer browser-token",
        cookie: "CF_Authorization=private-cookie",
        "cf-access-jwt-assertion": "private-jwt",
        "cf-access-authenticated-user-email": "operator@example.com",
        "x-ota-actor": "forged@example.com",
      }),
      { UPDATES: { fetch: fetchUpstream }, OTA_PUBLISH_TOKEN: "server-token" }
    )

    expect(response).toBe(upstreamResponse)
    const forwarded = fetchUpstream.mock.calls[0][0] as Request
    expect(forwarded.url).toBe(
      "https://dashboard.example.com/admin/channels/beta?test=1"
    )
    expect(forwarded.method).toBe("POST")
    expect(await forwarded.json()).toEqual({ branch: "staging" })
    expect(Object.fromEntries(forwarded.headers)).toEqual({
      authorization: "Bearer server-token",
      "content-type": "application/json",
      "x-ota-actor": "operator@example.com",
    })
    expect(forwarded.redirect).toBe("manual")
  })

  it("uses the configured network origin and drops an unverified actor", async () => {
    const fetchUpstream = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ ok: true }))
    vi.stubGlobal("fetch", fetchUpstream)

    await forwardUpdates(request({ "x-ota-actor": "forged@example.com" }), {
      OTA_URL: origin,
      OTA_PUBLISH_TOKEN: "server-token",
    })

    const forwarded = fetchUpstream.mock.calls[0][0] as Request
    expect(forwarded.url).toBe(`${origin}/admin/channels/beta?test=1`)
    expect(forwarded.headers.get("x-ota-actor")).toBeNull()
    expect(forwarded.redirect).toBe("manual")
  })

  it("rejects a protocol-relative destination before sending credentials", async () => {
    const fetchUpstream = vi.fn<typeof fetch>()
    vi.stubGlobal("fetch", fetchUpstream)
    const response = await forwardUpdates(
      new Request("https://dashboard.example.com/api//attacker.example/steal"),
      { OTA_URL: origin, OTA_PUBLISH_TOKEN: "server-token" }
    )
    expect(response.status).toBe(404)
    expect(fetchUpstream).not.toHaveBeenCalled()
  })

  it.each([
    "https://attacker.example",
    "https://other.example.com",
    "null",
    "",
  ])(
    "rejects writes from origin %j before forwarding credentials",
    async (requestOrigin) => {
      const fetchUpstream = vi.fn<typeof fetch>()
      const response = await forwardUpdates(
        request({ origin: requestOrigin }),
        {
          UPDATES: { fetch: fetchUpstream },
          OTA_PUBLISH_TOKEN: "server-token",
        }
      )
      expect(response.status).toBe(403)
      expect(fetchUpstream).not.toHaveBeenCalled()
    }
  )

  it("rejects writes without an origin", async () => {
    const incoming = request()
    incoming.headers.delete("origin")
    const fetchUpstream = vi.fn<typeof fetch>()
    const response = await forwardUpdates(incoming, {
      UPDATES: { fetch: fetchUpstream },
      OTA_PUBLISH_TOKEN: "server-token",
    })
    expect(response.status).toBe(403)
    expect(fetchUpstream).not.toHaveBeenCalled()
  })

  it.each([
    "text/plain",
    "application/x-www-form-urlencoded",
    "multipart/form-data",
  ])("rejects form-compatible content type %s", async (contentType) => {
    const fetchUpstream = vi.fn<typeof fetch>()
    const response = await forwardUpdates(
      request({ "content-type": contentType }),
      {
        UPDATES: { fetch: fetchUpstream },
        OTA_PUBLISH_TOKEN: "server-token",
      }
    )
    expect(response.status).toBe(415)
    expect(fetchUpstream).not.toHaveBeenCalled()
  })

  it("allows same-origin reads without an Origin header", async () => {
    const fetchUpstream = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ ok: true }))
    const response = await forwardUpdates(
      new Request("https://dashboard.example.com/api/admin/overview"),
      {
        UPDATES: { fetch: fetchUpstream },
        OTA_PUBLISH_TOKEN: "server-token",
      }
    )
    expect(response.status).toBe(200)
    expect(fetchUpstream).toHaveBeenCalledOnce()
  })

  it("requires the configured token instead of forwarding browser credentials", async () => {
    const fetchUpstream = vi.fn<typeof fetch>()
    const response = await forwardUpdates(
      request({ authorization: "Bearer browser-token" }),
      {
        UPDATES: { fetch: fetchUpstream },
      }
    )
    expect(response.status).toBe(500)
    expect(fetchUpstream).not.toHaveBeenCalled()
  })

  it("does not pass an upstream redirect back to the browser", async () => {
    const fetchUpstream = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.redirect("https://attacker.example/steal", 307)
      )
    const response = await forwardUpdates(request(), {
      UPDATES: { fetch: fetchUpstream },
      OTA_PUBLISH_TOKEN: "server-token",
    })
    expect(response.status).toBe(502)
    expect(response.headers.get("location")).toBeNull()
    expect(fetchUpstream).toHaveBeenCalledTimes(1)
  })
})
