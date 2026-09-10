import { readFileSync } from "node:fs";
import { Effect } from "effect";
import { afterAll, describe, expect, it } from "vitest";
import { sha256Base64Url } from "./crypto.ts";
import { makeServer, stores } from "./test-support.ts";

const fixture = (name: string) =>
  new Uint8Array(readFileSync(new URL(`../../../packages/bsdiff/fixtures/${name}`, import.meta.url)));
const v1 = fixture("v1.hbc");
const v2 = fixture("v2.hbc");
const patch = fixture("v1-to-v2.patch");
const image = new TextEncoder().encode("png bytes");
const orphan = new TextEncoder().encode("never referenced");
const hashOf = (bytes: Uint8Array<ArrayBuffer>) => Effect.runPromise(sha256Base64Url(bytes));
const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

describe.each(stores)("retention sweep over the %s store", (_, store) => {
  // Everything older than "now" is eligible: only the newest group per branch,
  // an active rollout, a device's update, or an embedded bundle protects an asset.
  const server = makeServer(store, undefined, {
    policy: { maxRatio: 1 },
    retention: { keepGroups: 1, keepDays: 0, deviceDays: 0, uploadGraceHours: 0 },
  });
  afterAll(() => server.dispose());
  const { authed, post, request, manifest, retention } = server;

  const upload = async (bytes: Uint8Array<ArrayBuffer>, contentType = "application/javascript") => {
    const hash = await hashOf(bytes);
    const response = await authed(`/publish/assets/${hash}`, { method: "PUT", headers: { "content-type": contentType }, body: bytes });
    expect(response.status).toBe(200);
    return hash;
  };
  const publish = async (bundle: string, assets: ReadonlyArray<string>, branch = "staging", rolloutPercent?: number) => {
    const response = await post("/publish/groups", {
      branch,
      ...(rolloutPercent === undefined ? {} : { rolloutPercent }),
      updates: {
        ios: {
          runtimeVersion: "rt-1",
          launchAsset: { hash: bundle, key: `key-${bundle}`, contentType: "application/javascript", fileExtension: ".bundle" },
          assets: assets.map((hash) => ({ hash, key: `key-${hash}`, contentType: "image/png", fileExtension: ".png" })),
        },
      },
    });
    expect(response.status).toBe(201);
    return (await response.json()) as { groupId: string; updates: Array<{ id: string }> };
  };
  const sweep = async () => {
    await settle();
    const response = await authed("/admin/gc", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(response.status).toBe(200);
    return (await response.json()) as { assets: number; patches: number; rounds: number };
  };

  it("drops what no retained update references, with its patches, and keeps the rest", async () => {
    const [oldHash, newHash, imageHash, orphanHash] = await Promise.all([
      upload(v1), upload(v2), upload(image, "image/png"), upload(orphan, "text/plain"),
    ]);
    const first = await publish(oldHash, [imageHash]);
    const second = await publish(newHash, [imageHash]);
    expect((await authed(`/publish/patches/${oldHash}/${newHash}`, { method: "PUT", body: patch })).status).toBe(200);
    expect((await request(`/assets/${newHash}`, { headers: { "a-im": "bsdiff", "expo-current-update-id": first.updates[0]!.id } })).status).toBe(226);

    // The embedded bundle of a store build is always kept.
    const embedded = Uint8Array.from(v2).reverse() as Uint8Array<ArrayBuffer>;
    const embeddedHash = await upload(embedded);
    expect((await post("/publish/builds", {
      updateId: crypto.randomUUID(), platform: "ios", runtimeVersion: "rt-1",
      profile: "production", distribution: "store", channel: "production",
      launchAsset: { hash: embeddedHash, key: "embedded", contentType: "application/javascript" },
    })).status).toBe(201);

    expect(await sweep()).toEqual({ assets: 2, patches: 1, rounds: 1 });

    expect((await request(`/assets/${oldHash}`)).status).toBe(404);
    expect((await request(`/assets/${orphanHash}`)).status).toBe(404);
    for (const hash of [newHash, imageHash, embeddedHash]) expect((await request(`/assets/${hash}`)).status).toBe(200);
    const nowFull = await request(`/assets/${newHash}`, { headers: { "a-im": "bsdiff", "expo-current-update-id": first.updates[0]!.id } });
    expect(nowFull.status).toBe(200);

    // The pruned update is history, not a rollback target any more.
    const plan = (await (await authed("/admin/branches/staging/rollback-plan")).json()) as { targets: Array<{ current: { id: string }; previous: { id: string } | null }> };
    expect(plan.targets).toHaveLength(1);
    expect(plan.targets[0]!.current.id).toBe(second.updates[0]!.id);
    expect(plan.targets[0]!.previous).toBeNull();
    expect((await authed(`/admin/groups/${first.groupId}`)).status).toBe(200);

    expect(await sweep()).toEqual({ assets: 0, patches: 0, rounds: 0 });
  });

  it("keeps a bundle that devices still run or that is mid-rollout", async () => {
    const running = new TextEncoder().encode("bundle devices run");
    const canary = new TextEncoder().encode("bundle in canary");
    const [runningHash, canaryHash] = await Promise.all([upload(running), upload(canary)]);
    const older = await publish(runningHash, [], "production");
    await publish(canaryHash, [], "production", 10);
    expect((await manifest({ "eas-client-id": "loyal", "expo-channel-name": "production", "expo-current-update-id": older.updates[0]!.id })).status).toBe(200);

    retention.deviceDays = 30;
    try {
      expect(await sweep()).toEqual({ assets: 0, patches: 0, rounds: 0 });
    } finally {
      retention.deviceDays = 0;
    }
    for (const hash of [runningHash, canaryHash]) expect((await request(`/assets/${hash}`)).status).toBe(200);

    // Once the device is no longer counted, only the canary and the newest group protect bundles.
    expect(await sweep()).toEqual({ assets: 1, patches: 0, rounds: 1 });
    expect((await request(`/assets/${runningHash}`)).status).toBe(404);
    expect((await request(`/assets/${canaryHash}`)).status).toBe(200);
  });

  it("leaves assets uploaded within the grace period for a publish in flight", async () => {
    const pending = new TextEncoder().encode("uploaded, group not yet published");
    const pendingHash = await upload(pending);
    retention.uploadGraceHours = 24;
    try {
      expect(await sweep()).toEqual({ assets: 0, patches: 0, rounds: 0 });
    } finally {
      retention.uploadGraceHours = 0;
    }
    expect((await request(`/assets/${pendingHash}`)).status).toBe(200);

    // A presence check from a publish counts as recent use too.
    retention.uploadGraceHours = 24;
    expect((await post("/publish/assets/missing", { hashes: [pendingHash] })).status).toBe(200);
    retention.uploadGraceHours = 0;
    expect(await sweep()).toEqual({ assets: 1, patches: 0, rounds: 1 });
    expect((await request(`/assets/${pendingHash}`)).status).toBe(404);
  });
});
