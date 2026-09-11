import { Effect } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sha256Base64Url } from "./crypto.ts";
import { CheckDebounce } from "./debounce.ts";
import { makeServer, stores } from "./test-support.ts";

describe.each(stores)("device lookup over the %s store", (_, store) => {
  const server = makeServer(store);
  afterAll(() => server.dispose());
  const { request, authed, post, manifest } = server;

  const bundle = new TextEncoder().encode("var devices = true;");
  let hash = "";
  let updateId = "";
  const json = async (response: Response) => {
    expect(response.status).toBe(200);
    return response.json() as Promise<any>;
  };

  beforeAll(async () => {
    hash = await Effect.runPromise(sha256Base64Url(bundle));
    await authed(`/publish/assets/${hash}`, { method: "PUT", headers: { "content-type": "application/javascript" }, body: bundle });
    const published = await post("/publish/groups", {
      branch: "staging",
      message: "devices",
      updates: { ios: { runtimeVersion: "rt-1", launchAsset: { hash, key: "k1", contentType: "application/javascript" }, assets: [] } },
    });
    expect(published.status).toBe(201);
    updateId = ((await published.json()) as { updates: Array<{ id: string }> }).updates[0]!.id;
  });

  it("requires the token", async () => {
    expect((await request("/admin/devices")).status).toBe(401);
    expect((await request("/admin/devices/device-1")).status).toBe(401);
  });

  it("answers 404 for a device that never checked in", async () => {
    expect((await authed("/admin/devices/never-seen")).status).toBe(404);
  });

  it("reads a device with the reason behind each answer it got", async () => {
    expect((await manifest({})).status).toBe(200);
    expect((await manifest({ "expo-current-update-id": updateId })).status).toBe(200);

    const { device, checks } = await json(await authed("/admin/devices/device-1"));
    expect(device).toMatchObject({
      clientId: "device-1",
      platform: "ios",
      runtimeVersion: "rt-1",
      channel: "staging",
      currentUpdateId: updateId,
      servedUpdateId: updateId,
    });
    expect(checks.map((check: any) => [check.decision, check.reason])).toEqual([
      ["none", "already-current"],
      ["manifest", "manifest"],
    ]);
    expect(checks[1].servedUpdateId).toBe(updateId);
    expect(checks[1].currentUpdateId).toBeNull();
  });

  it("names the channel itself when nothing points at a branch", async () => {
    expect((await manifest({ "eas-client-id": "device-3", "expo-channel-name": "nope" })).status).toBe(200);
    const { checks } = await json(await authed("/admin/devices/device-3"));
    expect(checks).toEqual([
      expect.objectContaining({ decision: "none", reason: "unknown-channel", channel: "nope", servedUpdateId: null }),
    ]);
  });

  it("searches by platform, runtime, channel, update, country and recency", async () => {
    await manifest({ "eas-client-id": "device-2", "expo-platform": "android", "expo-runtime-version": "rt-2" });
    const found = async (query: string) =>
      ((await json(await authed(`/admin/devices${query}`))).devices as Array<{ clientId: string }>).map((row) => row.clientId);

    expect((await found("")).sort()).toEqual(["device-1", "device-2", "device-3"]);
    expect(await found("?platform=android")).toEqual(["device-2"]);
    expect((await found("?runtimeVersion=rt-1&platform=ios")).sort()).toEqual(["device-1", "device-3"]);
    expect(await found("?channel=staging&platform=ios")).toEqual(["device-1"]);
    // The client sends the id in whatever case it stored it in.
    expect(await found(`?currentUpdateId=${updateId.toUpperCase()}`)).toEqual(["device-1"]);
    expect(await found("?country=CA")).toEqual([]);
    expect(await found("?seenWithinMinutes=60")).toHaveLength(3);
    expect(await found("?limit=1")).toHaveLength(1);
  });

  it("pages on the device the last page ended with", async () => {
    const page = async (query: string) =>
      ((await json(await authed(`/admin/devices${query}`))).devices as Array<{ clientId: string }>).map((row) => row.clientId);
    const all = await page("");
    expect(all.length).toBeGreaterThan(1);
    const first = await page("?limit=1");
    expect(first).toEqual(all.slice(0, 1));
    const second = await page(`?limit=1&before=${first[0]}`);
    expect(second).toEqual(all.slice(1, 2));
    expect(await page(`?before=${all[all.length - 1]}`)).toEqual([]);
  });

  it("rejects filters it cannot read", async () => {
    for (const query of ["?platform=windows", "?limit=0", "?limit=nope", "?seenWithinMinutes=0", "?seenWithinMinutes=4000", "?before="]) {
      expect((await authed(`/admin/devices${query}`)).status).toBe(400);
    }
  });
});

describe.each(stores)("debounced check-ins over the %s store", (_, store) => {
  const server = makeServer(store, undefined, { debounce: CheckDebounce.memory() });
  afterAll(() => server.dispose());
  const { authed, manifest } = server;
  const checks = async () =>
    ((await (await authed("/admin/devices/device-1")).json()) as { checks: ReadonlyArray<unknown> }).checks;

  it("writes the first check and skips the identical ones behind it", async () => {
    expect((await manifest({})).status).toBe(200);
    expect(await checks()).toHaveLength(1);
    for (let poll = 0; poll < 5; poll++) expect((await manifest({})).status).toBe(200);
    expect(await checks()).toHaveLength(1);
  });

  it("writes again as soon as the device says something new", async () => {
    expect((await manifest({ "expo-current-update-id": "abcdef00-0000-4000-8000-000000000000" })).status).toBe(200);
    expect(await checks()).toHaveLength(2);
    // A crash report is part of the check, so it is never the one skipped.
    expect((await manifest({ "expo-fatal-error": "Launch failed" })).status).toBe(200);
    expect(await checks()).toHaveLength(3);
  });
});
