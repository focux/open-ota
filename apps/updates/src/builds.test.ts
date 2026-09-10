import { Effect } from "effect";
import { afterAll, describe, expect, it } from "vitest";
import { sha256Base64Url } from "./crypto.ts";
import { makeServer, stores } from "./test-support.ts";

const bundle = new TextEncoder().encode("embedded bundle") as Uint8Array<ArrayBuffer>;
const hash = await Effect.runPromise(sha256Base64Url(bundle));

// Eligibility: a build stays on record and keeps its bundle after it is
// deactivated, but CI no longer finds it unless it asks for inactive builds.
describe.each(stores)("build eligibility over the %s store", (_, store) => {
  // Nothing but a registered build protects its bundle from the sweep here.
  const server = makeServer(store, undefined, {
    retention: { keepGroups: 0, keepDays: 0, deviceDays: 0, uploadGraceHours: 0 },
  });
  afterAll(() => server.dispose());
  const { authed, post, request } = server;

  const query = "platform=ios&runtime=rt-1&profile=production&distribution=store&channel=production";
  const register = (updateId: string) =>
    post("/publish/builds", {
      updateId,
      platform: "ios",
      runtimeVersion: "rt-1",
      profile: "production",
      distribution: "store",
      channel: "production",
      launchAsset: { hash, key: "embedded", contentType: "application/javascript" },
    });
  const find = async (suffix = "") => (await (await authed(`/publish/builds?${query}${suffix}`)).json()) as { build: { id: string; active: boolean } | null };
  const setActive = (id: string, active: boolean) =>
    authed(`/publish/builds/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ active }) });

  it("hides deactivated builds from the default lookup and brings them back", async () => {
    const uploaded = await authed(`/publish/assets/${hash}`, { method: "PUT", headers: { "content-type": "application/javascript" }, body: bundle });
    expect(uploaded.status).toBe(200);
    const embeddedId = crypto.randomUUID();
    const registered = await register(embeddedId);
    expect(registered.status).toBe(201);
    const { build } = (await registered.json()) as { build: { id: string; active: boolean } };
    expect(build.active).toBe(true);
    expect((await find()).build?.id).toBe(build.id);

    // Deactivating is idempotent and reports the new state.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await setActive(build.id, false);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ build: { ...build, active: false } });
    }
    expect((await find()).build).toBeNull();
    expect((await find("&includeInactive=true")).build).toEqual({ ...build, active: false });
    expect((await find("&includeInactive=false")).build).toBeNull();

    // Reactivating is idempotent too.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await setActive(build.id, true);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ build: { ...build, active: true } });
    }
    expect((await find()).build).toEqual({ ...build, active: true });

    // Registering the same embedded update again reactivates the existing record.
    expect((await setActive(build.id, false)).status).toBe(200);
    expect((await find()).build).toBeNull();
    const again = await register(embeddedId);
    expect(again.status).toBe(201);
    expect(await again.json()).toEqual({ build: { ...build, active: true } });
    expect((await find()).build).toEqual({ ...build, active: true });
  });

  it("keeps a deactivated build's bundle for retention and patch bases", async () => {
    const other = new TextEncoder().encode("another embedded bundle") as Uint8Array<ArrayBuffer>;
    const otherHash = await Effect.runPromise(sha256Base64Url(other));
    expect((await authed(`/publish/assets/${otherHash}`, { method: "PUT", headers: { "content-type": "application/javascript" }, body: other })).status).toBe(200);
    const registered = await post("/publish/builds", {
      updateId: crypto.randomUUID(),
      platform: "ios",
      runtimeVersion: "rt-1",
      profile: "production",
      distribution: "store",
      channel: "production",
      launchAsset: { hash: otherHash, key: "other", contentType: "application/javascript" },
    });
    expect(registered.status).toBe(201);
    const { build } = (await registered.json()) as { build: { id: string; embeddedUpdateId: string } };
    expect((await setActive(build.id, false)).status).toBe(200);

    await new Promise((resolve) => setTimeout(resolve, 5));
    const swept = await authed("/admin/gc", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(swept.status).toBe(200);
    expect((await request(`/assets/${otherHash}`)).status).toBe(200);

    const bases = await authed(`/publish/branches/staging/patch-bases?platform=ios&runtime=rt-1&target=${"T".repeat(43)}`);
    expect(bases.status).toBe(200);
    const { bases: ranked } = (await bases.json()) as { bases: Array<{ hash: string; source: string; updateId: string | null }> };
    expect(ranked).toContainEqual({ hash: otherHash, source: "embedded", updateId: build.embeddedUpdateId, devices: 0 });
  });

  it("rejects unknown builds and malformed activation bodies", async () => {
    expect((await setActive("missing", false)).status).toBe(404);
    const malformed = await authed("/publish/builds/missing", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ active: "no" }) });
    expect(malformed.status).toBe(400);
    const badQuery = await authed(`/publish/builds?${query}&includeInactive=yes`);
    expect(badQuery.status).toBe(400);
  });
});
