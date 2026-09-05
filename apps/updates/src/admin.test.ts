import { Effect } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sha256Base64Url } from "./crypto.ts";
import { firstPart, makeServer, stores } from "./test-support.ts";

describe.each(stores)("admin api over the %s store", (_, store) => {
  const server = makeServer(store);
  afterAll(() => server.dispose());
  const { request, authed, post, manifest } = server;

  const bundle = new TextEncoder().encode("var admin = true;");
  let hash = "";
  const bundleUpdate = (runtimeVersion = "rt-1") => ({
    runtimeVersion,
    launchAsset: { hash, key: "k1", contentType: "application/javascript", fileExtension: ".bundle" },
    assets: [],
  });
  const publish = async (body: unknown) => {
    const response = await post("/publish/groups", body);
    expect(response.status).toBe(201);
    return (await response.json()) as { groupId: string; updates: Array<{ id: string; platform: string }> };
  };
  const json = async (response: Response) => {
    expect(response.status).toBe(200);
    return response.json() as Promise<any>;
  };

  beforeAll(async () => {
    hash = await Effect.runPromise(sha256Base64Url(bundle));
    await authed(`/publish/assets/${hash}`, { method: "PUT", headers: { "content-type": "application/javascript" }, body: bundle });
  });

  it("requires the token", async () => {
    expect((await request("/admin/overview")).status).toBe(401);
  });

  it("lists channels, branches, and the newest update per runtime", async () => {
    const first = await publish({ branch: "staging", message: "one", updates: { ios: bundleUpdate(), android: bundleUpdate("rt-a") } });
    const second = await publish({ branch: "staging", message: "two", updates: { ios: bundleUpdate() } });
    const overview = await json(await authed("/admin/overview"));
    expect(overview.channels.map((c: any) => [c.name, c.branch])).toEqual([["production", "production"], ["staging", "staging"]]);
    expect(overview.branches).toEqual(["production", "staging"]);
    const latest = overview.latest.map((u: any) => [u.branch, u.platform, u.runtimeVersion, u.groupId]);
    expect(latest).toEqual([
      ["staging", "android", "rt-a", first.groupId],
      ["staging", "ios", "rt-1", second.groupId],
    ]);
  });

  it("pages groups newest first and reads one group with its updates", async () => {
    const { groups } = await json(await authed("/admin/branches/staging/groups?limit=1"));
    expect(groups).toHaveLength(1);
    expect(groups[0].message).toBe("two");
    const older = await json(await authed(`/admin/branches/staging/groups?limit=5&before=${encodeURIComponent(groups[0].createdAt)}`));
    expect(older.groups.every((g: any) => g.createdAt < groups[0].createdAt)).toBe(true);

    const group = await json(await authed(`/admin/groups/${groups[0].id}`));
    expect(group.updates).toHaveLength(1);
    expect(group.updates[0].kind).toBe("bundle");
    expect(group.updates[0].launchAsset.hash).toBe(hash);
    expect((await authed("/admin/groups/nope")).status).toBe(404);
  });

  it("promotes a group to another branch and serves it on that channel", async () => {
    const { groups } = await json(await authed("/admin/branches/staging/groups?limit=1"));
    const before = await firstPart(await manifest({ "expo-channel-name": "production" }));
    expect(before).toEqual({ type: "noUpdateAvailable" });

    const promoted = await post(`/admin/groups/${groups[0].id}/promote`, { branch: "production" });
    expect(promoted.status).toBe(201);
    const { groupId } = (await promoted.json()) as { groupId: string };
    const production = await json(await authed(`/admin/groups/${groupId}`));
    expect(production.message).toBe("Promoted from staging: two");
    expect(production.updates[0].launchAsset.hash).toBe(hash);

    const served = await firstPart(await manifest({ "expo-channel-name": "production" }));
    expect(served.id).toBe(production.updates[0].id);
    expect(served.metadata.branchName).toBe("production");
  });

  it("changes a rollout and a channel pointer", async () => {
    const { groups } = await json(await authed("/admin/branches/staging/groups?limit=1"));
    const current = await firstPart(await manifest({}));
    expect(current.id).toBe(groups[0].updates[0].id);

    expect((await post(`/admin/groups/${groups[0].id}/rollout`, { percent: 0 })).status).toBe(409);
    const heldBack = await firstPart(await manifest({}));
    expect(heldBack.id).toBe(current.id);
    expect((await post(`/admin/groups/${groups[0].id}/rollout`, { percent: 101 })).status).toBe(400);
    expect((await post("/admin/groups/nope/rollout", { percent: 10 })).status).toBe(404);

    expect((await post("/admin/channels/staging", { branch: "production" })).status).toBe(200);
    const repointed = await firstPart(await manifest({}));
    expect(repointed.metadata.branchName).toBe("production");
    expect((await post("/admin/channels/beta", { branch: "nope" })).status).toBe(404);
    expect((await post("/admin/channels/staging", { branch: "staging" })).status).toBe(200);
  });

  it("publishes a rollback to embedded for chosen platforms", async () => {
    const response = await post("/admin/branches/staging/rollback-to-embedded", { runtimeVersion: "rt-1", platforms: ["ios"] });
    expect(response.status).toBe(201);
    const directive = await firstPart(await manifest({ "expo-current-update-id": "x", "expo-embedded-update-id": "e" }));
    expect(directive.type).toBe("rollBackToEmbedded");
    const { groups } = await json(await authed("/admin/branches/staging/groups?limit=1"));
    expect(groups[0].updates.map((u: any) => [u.platform, u.kind])).toEqual([["ios", "rollback"]]);
    expect(groups[0].message).toBe("Rolled back to embedded (rt-1)");
  });
});

describe.each(stores)("branch rollback over the %s store", (_, store) => {
  const server = makeServer(store);
  afterAll(() => server.dispose());
  const { authed, post, manifest } = server;
  const actorHeaders = { authorization: `Bearer publish-token`, "x-ota-actor": "ops@example.com" };
  const bytes = (text: string) => new TextEncoder().encode(text);
  const upload = async (content: string) => {
    const hash = await Effect.runPromise(sha256Base64Url(bytes(content)));
    await authed(`/publish/assets/${hash}`, { method: "PUT", headers: { "content-type": "application/javascript" }, body: bytes(content) });
    return hash;
  };
  const bundle = (hash: string, runtimeVersion = "rt-1") => ({
    runtimeVersion,
    launchAsset: { hash, key: hash.slice(0, 8), contentType: "application/javascript" },
    assets: [],
  });

  it("plans a rollback per build and republishes the previous good update", async () => {
    const [v1, v2, v3] = await Promise.all([upload("v1"), upload("v2"), upload("v3")]);
    await post("/publish/groups", { branch: "production", message: "v1", updates: { ios: bundle(v1), android: bundle(v1, "rt-a") } });
    await post("/publish/groups", { branch: "production", message: "v2", updates: { ios: bundle(v2) } });
    await post("/publish/groups", { branch: "production", message: "v2 again", updates: { ios: bundle(v2) } });
    const bad = (await (await post("/publish/groups", { branch: "production", message: "v3 bad", updates: { ios: bundle(v3) } })).json()) as any;
    await manifest({ "expo-channel-name": "production", "eas-client-id": "p1", "expo-current-update-id": bad.updates[0].id });
    await manifest({ "expo-channel-name": "production", "eas-client-id": "p2" });

    const plan = (await (await authed("/admin/branches/production/rollback-plan")).json()) as any;
    const ios = plan.targets.find((t: any) => t.platform === "ios");
    const android = plan.targets.find((t: any) => t.platform === "android");
    expect(ios.current.id).toBe(bad.updates[0].id);
    expect(ios.devices).toBe(2);
    expect(ios.previous.launchAsset.hash).toBe(v2);
    expect(android.previous).toBeNull();
    expect(android.runtimeVersion).toBe("rt-a");

    const missing = await post("/admin/branches/production/rollback", { targets: [{ platform: "android", runtimeVersion: "rt-a", mode: "previous" }] });
    expect(missing.status).toBe(404);

    const response = await server.request("/admin/branches/production/rollback", {
      method: "POST",
      headers: { ...actorHeaders, "content-type": "application/json" },
      body: JSON.stringify({
        targets: [
          { platform: "ios", runtimeVersion: "rt-1", mode: "previous" },
          { platform: "android", runtimeVersion: "rt-a", mode: "embedded" },
        ],
      }),
    });
    expect(response.status).toBe(201);
    const { groups } = (await response.json()) as any;
    expect(groups).toHaveLength(2);

    const served = await firstPart(await manifest({ "expo-channel-name": "production", "eas-client-id": "p1", "expo-current-update-id": bad.updates[0].id }));
    expect(served.launchAsset.hash).toBe(v2);
    const androidDirective = await firstPart(
      await manifest({ "expo-channel-name": "production", "expo-platform": "android", "expo-runtime-version": "rt-a", "expo-current-update-id": "x", "expo-embedded-update-id": "e" }),
    );
    expect(androidDirective.type).toBe("rollBackToEmbedded");

    const list = (await (await authed("/admin/branches/production/groups?limit=2")).json()) as any;
    const messages = list.groups.map((g: any) => [g.message, g.actor]).sort();
    expect(messages).toEqual([
      ["Rolled back to embedded (rt-a)", "ops@example.com"],
      ["Rolled back to: v2 again", "ops@example.com"],
    ]);
  });

  it("names an embedded rollback as embedded even when a previous update exists", async () => {
    const [a, b] = await Promise.all([upload("emb-v1"), upload("emb-v2")]);
    await post("/publish/groups", { branch: "embedded-msg", message: "chore: testing ota", updates: { ios: bundle(a, "rt-e") } });
    await post("/publish/groups", { branch: "embedded-msg", message: "second", updates: { ios: bundle(b, "rt-e") } });

    const plan = (await (await authed("/admin/branches/embedded-msg/rollback-plan")).json()) as any;
    expect(plan.targets.find((t: any) => t.platform === "ios").previous).not.toBeNull();

    const response = await post("/admin/branches/embedded-msg/rollback", {
      targets: [{ platform: "ios", runtimeVersion: "rt-e", mode: "embedded" }],
    });
    expect(response.status).toBe(201);
    const list = (await (await authed("/admin/branches/embedded-msg/groups?limit=1")).json()) as any;
    expect(list.groups[0].message).toBe("Rolled back to embedded (rt-e)");
    expect(list.groups[0].updates.map((u: any) => u.kind)).toEqual(["rollback"]);
  });

  it("promotes with a rollout percent", async () => {
    const list = (await (await authed("/admin/branches/production/groups?limit=1")).json()) as any;
    const promoted = await post(`/admin/groups/${list.groups[0].id}/promote`, { branch: "staging", rolloutPercent: 10 });
    expect(promoted.status).toBe(201);
    const { groupId } = (await promoted.json()) as any;
    const group = (await (await authed(`/admin/groups/${groupId}`)).json()) as any;
    expect(group.updates[0].rolloutPercent).toBe(10);
    expect(group.message).toMatch(/^Promoted from production: /);
  });
});

describe.each(stores)("metrics over the %s store", (_, store) => {
  const server = makeServer(store);
  afterAll(() => server.dispose());
  const { authed, post, manifest, events } = server;

  const bundle = new TextEncoder().encode("var metrics = true;");

  it("counts devices per runtime and per update from manifest checks", async () => {
    const hash = await Effect.runPromise(sha256Base64Url(bundle));
    await authed(`/publish/assets/${hash}`, { method: "PUT", headers: { "content-type": "application/javascript" }, body: bundle });
    const group = (await (await post("/publish/groups", {
      branch: "staging",
      updates: { ios: { runtimeVersion: "rt-1", launchAsset: { hash, key: "k", contentType: "application/javascript" }, assets: [] } },
    })).json()) as { updates: Array<{ id: string }> };
    const updateId = group.updates[0]!.id;

    await manifest({ "eas-client-id": "a", "cf-ipcountry": "CA" });
    await manifest({ "eas-client-id": "b", "expo-current-update-id": updateId, "cf-ipcountry": "US" });
    await manifest({ "eas-client-id": "a", "expo-current-update-id": updateId });
    await manifest({ "eas-client-id": "c", "expo-runtime-version": "rt-2", "cf-ipcountry": "CA" });
    await manifest({});

    const metrics = (await (await authed("/admin/metrics")).json()) as any;
    expect(metrics.runtimes).toEqual([
      { channel: "staging", platform: "ios", runtimeVersion: "rt-2", devices: 1 },
      { channel: "staging", platform: "ios", runtimeVersion: "rt-1", devices: 3 },
    ]);
    expect(metrics.updates).toEqual([{ updateId, channel: "staging", running: 2, served: 2, faulty: 0 }]);
    expect(metrics.online).toBe(4);
    expect(metrics.failures).toEqual([]);
    expect(metrics.countries).toEqual([{ country: "CA", devices: 2 }, { country: "US", devices: 1 }]);
    expect(metrics.segments).toEqual([
      { updateId, country: "CA", running: 1, faulty: 0 },
      { updateId, country: "US", running: 1, faulty: 0 },
    ]);

    // Two devices crashed on the update and rolled back; one reports the message twice.
    const crashed = { "expo-recent-failed-update-ids": `"${updateId.toUpperCase()}"`, "expo-fatal-error": "TypeError: boom" };
    await manifest({ "eas-client-id": "a", ...crashed });
    await manifest({ "eas-client-id": "a", ...crashed });
    await manifest({ "eas-client-id": "d", "expo-recent-failed-update-ids": `"${updateId}", "other"` });
    const after = (await (await authed("/admin/metrics")).json()) as any;
    expect(after.updates.find((u: any) => u.updateId === updateId)).toMatchObject({ faulty: 2 });
    expect(after.failures).toEqual([{ updateId, message: "TypeError: boom", devices: 1 }]);
    expect(events.filter((e) => e.event === "check").map((e) => e.event === "check" && e.outcome)).toEqual([
      "manifest", "none", "none", "none", "manifest", "manifest", "manifest", "manifest",
    ]);
  });

  it("counts a device back on embedded after it follows a rollback", async () => {
    const bytes = new TextEncoder().encode("var rollback-metrics = true;");
    const hash = await Effect.runPromise(sha256Base64Url(bytes));
    await authed(`/publish/assets/${hash}`, { method: "PUT", headers: { "content-type": "application/javascript" }, body: bytes });
    const group = (await (await post("/publish/groups", {
      branch: "staging",
      message: "rollbackable",
      updates: { ios: { runtimeVersion: "rt-rb", launchAsset: { hash, key: "k-rb", contentType: "application/javascript" }, assets: [] } },
    })).json()) as { updates: Array<{ id: string }> };
    const updateId = group.updates[0]!.id;

    // Fresh device takes the bundle, then the branch is rolled back.
    await manifest({ "eas-client-id": "rb-1", "expo-runtime-version": "rt-rb", "expo-embedded-update-id": "emb-1" });
    const rolled = await post("/admin/branches/staging/rollback-to-embedded", { runtimeVersion: "rt-rb", platforms: ["ios"] });
    expect(rolled.status).toBe(201);
    const rollbackUpdateId = ((await rolled.json()) as { updates: Array<{ id: string }> }).updates[0]!.id;

    // Still on the bundle: served the rollback directive.
    const directive = await firstPart(
      await manifest({ "eas-client-id": "rb-1", "expo-runtime-version": "rt-rb", "expo-current-update-id": updateId, "expo-embedded-update-id": "emb-1" }),
    );
    expect(directive.type).toBe("rollBackToEmbedded");
    // Relaunched on embedded: nothing to serve, the served id sticks.
    const none = await firstPart(
      await manifest({ "eas-client-id": "rb-1", "expo-runtime-version": "rt-rb", "expo-current-update-id": "emb-1", "expo-embedded-update-id": "emb-1" }),
    );
    expect(none.type).toBe("noUpdateAvailable");

    const metrics = (await (await authed("/admin/metrics")).json()) as any;
    expect(metrics.updates.find((u: any) => u.updateId === rollbackUpdateId)).toEqual({
      updateId: rollbackUpdateId,
      channel: "staging",
      running: 1,
      served: 1,
      faulty: 0,
    });
  });
});
