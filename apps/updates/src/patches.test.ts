import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer } from "effect";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { AssetStore } from "./assets.ts";
import { sha256Base64Url } from "./crypto.ts";
import { StorageError } from "./errors.ts";
import { UpdateStore } from "./store.ts";
import { bsdiff, makeServer, stores } from "./test-support.ts";

const fixture = (name: string) =>
  new Uint8Array(readFileSync(new URL(`../../../packages/bsdiff/fixtures/${name}`, import.meta.url)));
const baseBundle = fixture("v1.hbc");
const targetBundle = fixture("v2.hbc");
const patchBody = fixture("v1-to-v2.patch");
const hashOf = (bytes: Uint8Array<ArrayBuffer>) => Effect.runPromise(sha256Base64Url(bytes));
const uuid = () => crypto.randomUUID();

describe.each(stores)("delta patches over the %s store", (_, store) => {
  let readFailure: "patch" | "missing" | "lookup" | "full" | undefined;
  // The fixture bundles are tiny, so the reference patch is a large share of
  // the gzipped bundle. The policy tests below use the real default.
  const server = makeServer(
    () => Layer.effect(UpdateStore, Effect.map(UpdateStore, (base) => ({
      ...base,
      patchSize: Effect.fn("Test.patchSize")((baseHash, targetHash) => readFailure === "lookup"
        ? Effect.fail(new StorageError({ message: "Patch lookup unavailable" }))
        : base.patchSize(baseHash, targetHash)),
    }))).pipe(Layer.provide(store())),
    Layer.effect(AssetStore, Effect.map(AssetStore, (base) => ({
      ...base,
      get: Effect.fn("Test.assets.get")((key) => {
        if (key.startsWith("patches/")) {
          if (readFailure === "missing") return Effect.succeed(null);
          if (readFailure === "patch") return Effect.fail(new StorageError({ message: "Patch read unavailable" }));
        } else if (readFailure === "full") {
          return Effect.fail(new StorageError({ message: "Full bundle unavailable" }));
        }
        return base.get(key);
      }),
    }))).pipe(Layer.provide(AssetStore.memory())),
    { policy: { maxRatio: 1 } },
  );
  afterAll(() => server.dispose());
  afterEach(() => { readFailure = undefined; });
  const { request, authed, post, events, manifest } = server;

  let baseHash = "";
  let targetHash = "";
  let baseUpdateId = "";
  let targetUpdateId = "";

  const upload = (hash: string, bytes: Uint8Array<ArrayBuffer>) =>
    authed(`/publish/assets/${hash}`, {
      method: "PUT",
      headers: { "content-type": "application/javascript" },
      body: bytes,
    });

  const publish = async (hash: string, branch = "staging") => {
    const response = await post("/publish/groups", {
      branch,
      updates: {
        ios: {
          runtimeVersion: "rt-1",
          launchAsset: { hash, key: `key-${hash}`, contentType: "application/javascript", fileExtension: ".bundle" },
          assets: [],
        },
      },
    });
    expect(response.status).toBe(201);
    return (await response.json()) as { updates: Array<{ id: string }> };
  };

  beforeAll(async () => {
    [baseHash, targetHash] = await Promise.all([hashOf(baseBundle), hashOf(targetBundle)]);
    await upload(baseHash, baseBundle);
    await upload(targetHash, targetBundle);
    baseUpdateId = (await publish(baseHash)).updates[0]!.id;
    targetUpdateId = (await publish(targetHash)).updates[0]!.id;
    const stored = await authed(`/publish/patches/${baseHash}/${targetHash}`, { method: "PUT", body: patchBody });
    expect(stored.status).toBe(200);
    expect(await stored.json()).toEqual(
      expect.objectContaining({ stored: true, baseHash, targetHash, size: patchBody.length }),
    );
  });

  it.each(["BSDIFF", "gzip, bsdiff;q=1.0", "bsdiff; q=0.5", "gzip;q=0.8, BsDiFf;Q=0.001"])(
    "accepts the supported patch offer %s", async (offer) => {
      const response = await request(`/assets/${targetHash}`, {
        headers: { "a-im": offer, "expo-current-update-id": baseUpdateId },
      });
      expect(response.status).toBe(226);
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(patchBody);
    },
  );

  it.each(["gzip", "bsdiff;q=0", "bsdiff;q=0.000", "bsdiff;q=2", "bsdiff;q=invalid", "bsdiff;q=0.0001"])(
    "serves the full bundle when the patch offer is unacceptable: %s", async (offer) => {
      const response = await request(`/assets/${targetHash}`, {
        headers: { "a-im": offer, "expo-current-update-id": baseUpdateId },
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("im")).toBeNull();
      expect(response.headers.get("vary")).toBe("A-IM, Expo-Current-Update-ID");
      expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(targetBundle);
    },
  );

  it("serves a patch as a 226 that the edge may cache for as long as the bundle", async () => {
    events.length = 0;
    const patched = await request(`/assets/${targetHash}`, {
      headers: { "a-im": "bsdiff", "expo-current-update-id": baseUpdateId.toUpperCase(), "eas-client-id": "device-1" },
    });
    expect(patched.status).toBe(226);
    expect(patched.headers.get("im")).toBe("bsdiff");
    expect(patched.headers.get("expo-base-update-id")).toBe(baseUpdateId);
    expect(patched.headers.get("content-type")).toBe("application/octet-stream");
    expect(patched.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(patched.headers.get("cache-tag")).toBe("asset, patch");
    expect(patched.headers.get("vary")).toBe("A-IM, Expo-Current-Update-ID");
    expect(new Uint8Array(await patched.arrayBuffer())).toEqual(patchBody);
    expect(events).toEqual([
      { event: "asset", clientId: "device-1", hash: targetHash, outcome: "patch", bytes: patchBody.length },
    ]);
  });

  it("holds a full bundle answered to a patch request only briefly, since a patch may land", async () => {
    events.length = 0;
    const unknownBase = await request(`/assets/${targetHash}`, {
      headers: { "a-im": "bsdiff", "expo-current-update-id": uuid() },
    });
    expect(unknownBase.status).toBe(200);
    expect(unknownBase.headers.get("cache-control")).toBe("public, max-age=300");
    expect(new Uint8Array(await unknownBase.arrayBuffer())).toEqual(targetBundle);

    const reversed = await request(`/assets/${baseHash}`, {
      headers: { "a-im": "gzip, bsdiff", "expo-current-update-id": baseUpdateId },
    });
    expect(reversed.status).toBe(200);
    expect(reversed.headers.get("cache-control")).toBe("public, max-age=300");

    const plain = await request(`/assets/${targetHash}`, { headers: { "expo-current-update-id": baseUpdateId } });
    expect(plain.status).toBe(200);
    expect(plain.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(events.map((event) => event.event === "asset" && [event.outcome, event.bytes])).toEqual([
      ["full", targetBundle.length],
      ["full", baseBundle.length],
      ["full", targetBundle.length],
    ]);
  });

  it.each(["patch", "missing", "lookup"] as const)("falls back to the full bundle after a %s failure", async (failure) => {
    readFailure = failure;
    events.length = 0;
    const response = await request(`/assets/${targetHash}`, {
      headers: { "a-im": "bsdiff", "expo-current-update-id": baseUpdateId },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("expo-base-update-id")).toBeNull();
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(targetBundle);
    expect(events).toEqual([{ event: "asset", hash: targetHash, outcome: "full", bytes: targetBundle.length }]);
  });

  it("keeps full bundle failures visible", async () => {
    readFailure = "full";
    expect((await request(`/assets/${targetHash}`)).status).toBe(500);
  });

  it("delivers a real Hermes patch that reconstructs the target bytes and hash", async () => {
    const response = await request(`/assets/${targetHash}`, {
      headers: { "a-im": "bsdiff", "expo-current-update-id": baseUpdateId },
    });
    expect(response.status).toBe(226);
    const directory = mkdtempSync(join(tmpdir(), "ota-bspatch-"));
    try {
      const base = join(directory, "base.hbc");
      const target = join(directory, "target.hbc");
      const patch = join(directory, "update.patch");
      writeFileSync(base, baseBundle);
      writeFileSync(patch, new Uint8Array(await response.arrayBuffer()));
      execFileSync("bspatch", [base, target, patch], { timeout: 10_000 });
      const rebuilt = new Uint8Array(readFileSync(target));
      expect(rebuilt).toEqual(targetBundle);
      expect(await hashOf(rebuilt)).toBe(targetHash);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("lists the newest launch assets on the branch and respects the limit", async () => {
    const response = await authed("/publish/branches/staging/bundles?platform=ios&runtime=rt-1");
    expect(response.status).toBe(200);
    const { bundles } = (await response.json()) as { bundles: Array<{ updateId: string; hash: string }> };
    expect(bundles.map((bundle) => bundle.hash)).toEqual([targetHash, baseHash]);
    expect(bundles[1]!.updateId).toBe(baseUpdateId);

    const one = await authed("/publish/branches/staging/bundles?platform=ios&runtime=rt-1&limit=1");
    expect(((await one.json()) as { bundles: Array<unknown> }).bundles).toHaveLength(1);
    expect((await authed("/publish/branches/staging/bundles?platform=ios&runtime=other")).status).toBe(200);
    expect((await request("/publish/branches/staging/bundles?platform=ios&runtime=rt-1")).status).toBe(401);
  });

  it("refuses a patch between hashes that were never uploaded", async () => {
    const response = await authed(`/publish/patches/${"A".repeat(43)}/${targetHash}`, {
      method: "PUT",
      body: patchBody,
    });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toContain("Assets not uploaded");
    expect((await authed(`/publish/patches/not-a-hash/${targetHash}`, { method: "PUT", body: patchBody })).status).toBe(400);
  });

  it("rejects a patch that is not BSDIFF40 or does not rebuild the target", async () => {
    const truncated = await authed(`/publish/patches/${baseHash}/${targetHash}`, {
      method: "PUT",
      body: patchBody.subarray(0, 100),
    });
    expect(truncated.status).toBe(400);
    expect(((await truncated.json()) as { error: string }).error).toContain("could not be applied");

    // A valid patch, but from base to itself: it rebuilds the base, not the target.
    const identity = bsdiff.diff(baseBundle, baseBundle);
    const wrong = await authed(`/publish/patches/${baseHash}/${targetHash}`, { method: "PUT", body: identity });
    expect(wrong.status).toBe(400);
    expect(((await wrong.json()) as { error: string }).error).toContain("does not rebuild the target");

    // Neither attempt disturbed the verified patch already stored.
    const still = await request(`/assets/${targetHash}`, {
      headers: { "a-im": "bsdiff", "expo-current-update-id": baseUpdateId },
    });
    expect(still.status).toBe(226);
    expect(new Uint8Array(await still.arrayBuffer())).toEqual(patchBody);
  });

  it("ranks patch bases by the fleet, then embedded builds, then recent publishes", async () => {
    const newHash = "N".repeat(43);
    const recent = await authed(`/publish/branches/staging/patch-bases?platform=ios&runtime=rt-1&target=${newHash}`);
    expect(recent.status).toBe(200);
    const initial = (await recent.json()) as { bases: Array<{ hash: string; source: string; updateId: string | null; devices: number }>; maxRatio: number };
    expect(initial.maxRatio).toBe(1);
    expect(initial.bases.map((base) => [base.hash, base.source])).toEqual([[targetHash, "recent"], [baseHash, "recent"]]);

    // Two devices still run the base update; one runs the target.
    for (const [device, current] of [["fleet-1", baseUpdateId], ["fleet-2", baseUpdateId], ["fleet-3", targetUpdateId]] as const) {
      expect((await manifest({ "eas-client-id": device, "expo-current-update-id": current })).status).toBe(200);
    }
    // Devices on another channel do not count for this branch.
    expect((await manifest({ "eas-client-id": "elsewhere", "expo-current-update-id": baseUpdateId, "expo-channel-name": "production" })).status).toBe(200);

    // A store build ships a third bundle, registered with the id its devices report.
    // Close to the target, as a build's bundle usually is, so its patch is worth storing.
    const embeddedBundle = Uint8Array.from(targetBundle) as Uint8Array<ArrayBuffer>;
    for (const index of [64, 128, 256, 512]) embeddedBundle[index] = embeddedBundle[index]! ^ 0x55;
    const embeddedHash = await hashOf(embeddedBundle);
    const embeddedId = uuid().toUpperCase();
    await upload(embeddedHash, embeddedBundle);
    const registered = await post("/publish/builds", {
      updateId: embeddedId,
      platform: "ios",
      runtimeVersion: "rt-1",
      profile: "production",
      distribution: "store",
      channel: "production",
      launchAsset: { hash: embeddedHash, key: "embedded", contentType: "application/javascript" },
    });
    expect(registered.status).toBe(201);
    const registeredBuild = await registered.json() as { build: Record<string, unknown> };
    expect(registeredBuild).toEqual({
      build: {
        id: expect.any(String),
        embeddedUpdateId: embeddedId.toLowerCase(),
        platform: "ios",
        runtimeVersion: "rt-1",
        profile: "production",
        distribution: "store",
        channel: "production",
        launchAssetHash: embeddedHash,
        active: true,
      },
    });
    const found = await authed("/publish/builds?platform=ios&runtime=rt-1&profile=production&distribution=store&channel=production");
    expect(found.status).toBe(200);
    expect(await found.json()).toEqual(registeredBuild);
    const wrongProfile = await authed("/publish/builds?platform=ios&runtime=rt-1&profile=preview&distribution=store");
    expect(wrongProfile.status).toBe(200);
    expect(await wrongProfile.json()).toEqual({ build: null });
    expect((await post("/publish/builds", {
      updateId: uuid(), platform: "ios", runtimeVersion: "rt-1", profile: "production", distribution: "store",
      launchAsset: { hash: "M".repeat(43), key: "k", contentType: "x" },
    })).status).toBe(400);

    const ranked = await authed(`/publish/branches/staging/patch-bases?platform=ios&runtime=rt-1&target=${targetHash}`);
    const { bases } = (await ranked.json()) as typeof initial;
    expect(bases).toEqual([
      { hash: baseHash, source: "fleet", updateId: baseUpdateId, devices: 2 },
      { hash: embeddedHash, source: "embedded", updateId: embeddedId.toLowerCase(), devices: 0 },
    ]);
    expect((await authed(`/publish/branches/staging/patch-bases?platform=ios&runtime=rt-1&target=${targetHash}&limit=1`).then((r) => r.json()) as typeof initial).bases).toHaveLength(1);

    // A fresh install running the embedded bundle gets a patch from it.
    const fromEmbedded = bsdiff.diff(embeddedBundle, targetBundle);
    expect((await authed(`/publish/patches/${embeddedHash}/${targetHash}`, { method: "PUT", body: fromEmbedded })).status).toBe(200);
    const served = await request(`/assets/${targetHash}`, { headers: { "a-im": "bsdiff", "expo-current-update-id": embeddedId } });
    expect(served.status).toBe(226);
    expect(served.headers.get("expo-base-update-id")).toBe(embeddedId.toLowerCase());
    expect(bsdiff.patch(embeddedBundle, new Uint8Array(await served.arrayBuffer()))).toEqual(targetBundle);

    const admin = await authed(`/admin/updates/${targetUpdateId}/patches`);
    expect(admin.status).toBe(200);
    const detail = (await admin.json()) as {
      launchAsset: { hash: string; size: number; compressedSize: number; wireSize: number; present: boolean };
      patches: Array<{ baseHash: string; size: number; ratio: number; bases: Array<{ updateId: string; embedded: boolean }> }>;
      delivery: unknown;
      maxRatio: number;
    };
    expect(detail.launchAsset).toEqual(expect.objectContaining({ hash: targetHash, size: targetBundle.length, present: true }));
    expect(detail.launchAsset.wireSize).toBe(detail.launchAsset.compressedSize);
    expect(detail.delivery).toBeNull();
    expect(detail.patches.map((patch) => patch.baseHash).sort()).toEqual([baseHash, embeddedHash].sort());
    const toward = detail.patches.find((patch) => patch.baseHash === baseHash)!;
    expect(toward.bases).toEqual([{ updateId: baseUpdateId, embedded: false }]);
    expect(toward.ratio).toBeCloseTo(patchBody.length / detail.launchAsset.wireSize);
    expect(detail.patches.find((patch) => patch.baseHash === embeddedHash)!.bases).toEqual([
      { updateId: embeddedId.toLowerCase(), embedded: true },
    ]);
    expect((await authed(`/admin/updates/${uuid()}/patches`)).status).toBe(404);
  });

  it("streams a declared-length upload into storage and still rejects the wrong bytes", async () => {
    const bytes = new TextEncoder().encode("streamed bundle ".repeat(64));
    const hash = await hashOf(bytes);
    const body = (chunks: ReadonlyArray<Uint8Array>) =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(chunk);
          controller.close();
        },
      });
    const streamed = await authed(`/publish/assets/${hash}`, {
      method: "PUT",
      headers: { "content-type": "application/javascript", "content-length": String(bytes.length) },
      body: body([bytes.subarray(0, 100), bytes.subarray(100)]),
      duplex: "half",
    } as RequestInit);
    expect(streamed.status).toBe(200);
    const stored = (await streamed.json()) as { size: number; compressedSize: number };
    expect(stored.size).toBe(bytes.length);
    expect(stored.compressedSize).toBeLessThan(bytes.length);
    expect(new Uint8Array(await (await request(`/assets/${hash}`)).arrayBuffer())).toEqual(bytes);

    const other = await hashOf(new TextEncoder().encode("other"));
    const wrong = await authed(`/publish/assets/${other}`, {
      method: "PUT",
      headers: { "content-length": String(bytes.length) },
      body: body([bytes]),
      duplex: "half",
    } as RequestInit);
    expect(wrong.status).toBe(400);
    expect((await request(`/assets/${other}`)).status).toBe(404);
  });
});

describe.each(stores)("patch policy over the %s store", (_, store) => {
  const server = makeServer(store);
  afterAll(() => server.dispose());
  const { authed } = server;
  const upload = (hash: string, bytes: Uint8Array<ArrayBuffer>, contentType = "application/javascript") =>
    authed(`/publish/assets/${hash}`, { method: "PUT", headers: { "content-type": contentType }, body: bytes });

  it("declines a patch that is not worth it against the compressed bundle, without failing the publish", async () => {
    const [baseHash, targetHash] = await Promise.all([hashOf(baseBundle), hashOf(targetBundle)]);
    await upload(baseHash, baseBundle);
    const uploaded = (await (await upload(targetHash, targetBundle)).json()) as { compressedSize: number };
    // The fixture patch is well over 30% of the gzipped target.
    expect(patchBody.length).toBeGreaterThan(0.3 * uploaded.compressedSize);
    const declined = await authed(`/publish/patches/${baseHash}/${targetHash}`, { method: "PUT", body: patchBody });
    expect(declined.status).toBe(200);
    expect(await declined.json()).toEqual({
      stored: false,
      reason: "too-large",
      baseHash,
      targetHash,
      size: patchBody.length,
      wireSize: uploaded.compressedSize,
      ratio: patchBody.length / uploaded.compressedSize,
      maxRatio: 0.3,
    });
    const bases = await authed(`/publish/branches/staging/patch-bases?platform=ios&runtime=rt-1&target=${targetHash}`);
    expect(((await bases.json()) as { maxRatio: number; maxBundleBytes: number })).toEqual(
      expect.objectContaining({ maxRatio: 0.3, maxBundleBytes: 32 * 1024 * 1024 }),
    );
  });

  it("compares against the raw size for content the edge does not compress", async () => {
    const raw = new Uint8Array(4096).map((_, index) => index % 251) as Uint8Array<ArrayBuffer>;
    const rawHash = await hashOf(raw);
    const changed = Uint8Array.from(raw, (byte) => (byte === 7 ? 8 : byte)) as Uint8Array<ArrayBuffer>;
    const changedHash = await hashOf(changed);
    await upload(rawHash, raw, "application/octet-stream");
    await upload(changedHash, changed, "application/octet-stream");
    const delta = bsdiff.diff(raw, changed);
    const stored = await authed(`/publish/patches/${rawHash}/${changedHash}`, { method: "PUT", body: delta });
    expect(await stored.json()).toEqual(expect.objectContaining({ stored: true, wireSize: changed.length, ratio: delta.length / changed.length }));
  });
});

describe("patch policy with a bundle size cap", () => {
  const server = makeServer(stores[0][1], AssetStore.memory(), { policy: { maxBundleBytes: 500, maxRatio: 1 } });
  afterAll(() => server.dispose());

  it("gives no patches to bundles the Worker could not verify in memory", async () => {
    const [baseHash, targetHash] = await Promise.all([hashOf(baseBundle), hashOf(targetBundle)]);
    for (const [hash, bytes] of [[baseHash, baseBundle], [targetHash, targetBundle]] as const) {
      await server.authed(`/publish/assets/${hash}`, { method: "PUT", headers: { "content-type": "application/javascript" }, body: bytes });
    }
    const declined = await server.authed(`/publish/patches/${baseHash}/${targetHash}`, { method: "PUT", body: patchBody });
    expect(await declined.json()).toEqual(expect.objectContaining({ stored: false, reason: "bundle-too-large" }));
  });
});
