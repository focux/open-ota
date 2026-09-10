import { Effect } from "effect";
import { afterAll, describe, expect, it } from "vitest";
import { sha256Base64Url } from "./crypto.ts";
import { makeServer, stores } from "./test-support.ts";

const bundle = new TextEncoder().encode("figures bundle") as Uint8Array<ArrayBuffer>;
const hash = await Effect.runPromise(sha256Base64Url(bundle));

// The figures attached to every update the admin API returns: counted on the
// server, once, so no page has to derive them from raw metrics.
describe.each(stores)("update figures over the %s store", (_, store) => {
  const server = makeServer(store);
  afterAll(() => server.dispose());
  const { authed, post, manifest } = server;

  const publish = async (branch: string) => {
    const response = await post("/publish/groups", {
      branch,
      updates: {
        ios: {
          runtimeVersion: "rt-1",
          launchAsset: { hash, key: "k", contentType: "application/javascript", fileExtension: ".bundle" },
          assets: [],
        },
      },
    });
    expect(response.status).toBe(201);
    return (await response.json()) as { groupId: string; updates: Array<{ id: string }> };
  };
  const checkIn = async (device: string, channel: string, current?: string) => {
    const response = await manifest({
      "eas-client-id": device,
      "expo-channel-name": channel,
      "expo-embedded-update-id": "00000000-0000-4000-8000-000000000000",
      ...(current === undefined ? {} : { "expo-current-update-id": current }),
    });
    expect(response.status).toBe(200);
  };
  const figuresOf = async (groupId: string) => {
    const response = await authed(`/admin/groups/${groupId}`);
    expect(response.status).toBe(200);
    const group = (await response.json()) as { updates: Array<{ id: string; figures: Record<string, number | string> }> };
    return group.updates[0]!.figures;
  };

  it("counts running wherever devices check in from and the population from the branch's channels", async () => {
    expect((await authed(`/publish/assets/${hash}`, { method: "PUT", headers: { "content-type": "application/javascript" }, body: bundle })).status).toBe(200);
    const staging = await publish("staging");
    const stagingId = staging.updates[0]!.id;

    // Two staging devices check in on their embedded JS and are handed the update.
    await checkIn("s1", "staging");
    await checkIn("s2", "staging");
    expect(await figuresOf(staging.groupId)).toEqual({
      updateId: stagingId, running: 0, served: 2, faulty: 0, elsewhere: 0, population: 2,
    });

    // One relaunches on it. The other relaunches on it, then moves to the
    // production channel: still running it, no longer part of staging.
    await checkIn("s1", "staging", stagingId);
    await checkIn("s2", "staging", stagingId);
    await checkIn("s2", "production", stagingId);
    expect(await figuresOf(staging.groupId)).toEqual({
      updateId: stagingId, running: 2, served: 1, faulty: 0, elsewhere: 1, population: 1,
    });

    // The group list carries the same figures.
    const page = await authed("/admin/branches/staging/groups?limit=1");
    expect(page.status).toBe(200);
    const { groups } = (await page.json()) as { groups: Array<{ updates: Array<{ figures: unknown }> }> };
    expect(groups[0]!.updates[0]!.figures).toEqual({
      updateId: stagingId, running: 2, served: 1, faulty: 0, elsewhere: 1, population: 1,
    });
  });

  it("counts a rollback by the devices it sent back to their embedded JS", async () => {
    const rolled = await post("/publish/groups", { branch: "staging", updates: { ios: { runtimeVersion: "rt-1", rollbackToEmbedded: true } } });
    expect(rolled.status).toBe(201);
    const { groupId, updates } = (await rolled.json()) as { groupId: string; updates: Array<{ id: string }> };
    // s1 is directed back and relaunches on its embedded JS; s2 is on production and never sees it.
    await checkIn("s1", "staging", "some-other-update");
    await checkIn("s1", "staging", "00000000-0000-4000-8000-000000000000");
    expect(await figuresOf(groupId)).toEqual({
      updateId: updates[0]!.id, running: 1, served: 1, faulty: 0, elsewhere: 0, population: 1,
    });
  });
});
