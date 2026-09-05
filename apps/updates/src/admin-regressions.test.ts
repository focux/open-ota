import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sha256Base64Url } from "./crypto.ts";
import type { PublishGroupInput, PublishedGroup } from "./model.ts";
import type { Group } from "./store.ts";
import { makeServer, stores } from "./test-support.ts";

describe.each(stores)("admin regressions over %s", (_, store) => {
  let server: ReturnType<typeof makeServer>;
  beforeEach(() => {
    server = makeServer(store);
  });
  afterEach(() => server.dispose());

  const publish = async (input: PublishGroupInput) => {
    const response = await server.post("/publish/groups", input);
    expect(response.status).toBe(201);
    return (await response.json()) as PublishedGroup;
  };
  const bundle = async (content: string) => {
    const bytes = new TextEncoder().encode(content);
    const hash = await Effect.runPromise(sha256Base64Url(bytes));
    expect((await server.authed(`/publish/assets/${hash}`, { method: "PUT", body: bytes })).status).toBe(200);
    return {
      runtimeVersion: "shared-runtime",
      launchAsset: { hash, key: hash, contentType: "application/javascript" },
      assets: [],
    };
  };
  const readGroup = async (id: string) => {
    const response = await server.authed(`/admin/groups/${id}`);
    expect(response.status).toBe(200);
    return (await response.json()) as Group;
  };

  it("preserves each platform's config through rollback and promotion", async () => {
    const old = await bundle("old");
    const latest = await bundle("latest");
    await publish({ branch: "staging", expoConfig: { version: "ios-old" }, updates: { ios: old } });
    await publish({ branch: "staging", expoConfig: { version: "android-old" }, updates: { android: old } });
    await publish({ branch: "staging", expoConfig: { version: "new" }, updates: { ios: latest, android: latest } });
    const response = await server.post("/admin/branches/staging/rollback", {
      targets: ["ios", "android"].map((platform) => ({ platform, runtimeVersion: "shared-runtime", mode: "previous" })),
    });
    expect(response.status).toBe(201);
    const { groups } = (await response.json()) as { groups: PublishedGroup[] };
    const rolled = await readGroup(groups[0]!.groupId);
    const configs = (group: Group) =>
      Object.fromEntries(
        group.updates.map((update) => [update.platform, update.kind === "bundle" ? update.expoConfig : null]),
      );
    expect(configs(rolled)).toEqual({ ios: { version: "ios-old" }, android: { version: "android-old" } });
    const promoted = await server.post(`/admin/groups/${rolled.id}/promote`, { branch: "production" });
    expect(promoted.status).toBe(201);
    expect(configs(await readGroup(((await promoted.json()) as PublishedGroup).groupId))).toEqual(configs(rolled));
  });

  it("keeps the source commit on a promoted group", async () => {
    const group = await publish({
      branch: "staging",
      gitCommit: "abc123",
      updates: { ios: await bundle("committed") },
    });
    const response = await server.post(`/admin/groups/${group.groupId}/promote`, { branch: "production" });
    expect(response.status).toBe(201);
    expect((await readGroup(((await response.json()) as PublishedGroup).groupId)).gitCommit).toBe("abc123");
  });

  it("rejects duplicate rollback targets before publishing anything", async () => {
    const target = { platform: "ios", runtimeVersion: "shared-runtime", mode: "embedded" };
    const group = await publish({ branch: "staging", updates: { ios: await bundle("current") } });
    expect((await server.post("/admin/branches/staging/rollback", { targets: [target, target] })).status).toBe(400);
    const page = await server.authed("/admin/branches/staging/groups");
    expect(((await page.json()) as { groups: Group[] }).groups.map((group) => group.id)).toEqual([group.groupId]);
  });

  it("rejects fractional query limits at the HTTP interface", async () => {
    for (const path of [
      "/admin/branches/staging/groups?limit=1.5",
      "/publish/branches/staging/bundles?platform=ios&runtime=rt-1&limit=1.5",
    ]) {
      expect((await server.authed(path)).status).toBe(400);
    }
  });
});
