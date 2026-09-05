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
import { makeServer, stores } from "./test-support.ts";

describe.each(stores)("delta patches over the %s store", (_, store) => {
  let readFailure: "patch" | "missing" | "lookup" | "full" | undefined;
  const server = makeServer(
    () => Layer.effect(UpdateStore, Effect.map(UpdateStore, (base) => ({
      ...base,
      hasPatch: Effect.fn("Test.hasPatch")((baseHash, targetHash) => readFailure === "lookup"
        ? Effect.fail(new StorageError({ message: "Patch lookup unavailable" }))
        : base.hasPatch(baseHash, targetHash)),
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
  );
  afterAll(() => server.dispose());
  afterEach(() => { readFailure = undefined; });
  const { request, authed, post, events } = server;

  const fixture = (name: string) => new Uint8Array(readFileSync(new URL(`./fixtures/bsdiff/${name}`, import.meta.url)));
  const baseBundle = fixture("v1.hbc");
  const targetBundle = fixture("v2.hbc");
  const patchBody = fixture("v1-to-v2.patch");
  let baseHash = "";
  let targetHash = "";
  let baseUpdateId = "";

  const upload = (hash: string, bytes: Uint8Array<ArrayBuffer>) =>
    authed(`/publish/assets/${hash}`, {
      method: "PUT",
      headers: { "content-type": "application/javascript" },
      body: bytes,
    });

  const publish = async (hash: string) => {
    const response = await post("/publish/groups", {
      branch: "staging",
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
    [baseHash, targetHash] = await Effect.runPromise(
      Effect.all([sha256Base64Url(baseBundle), sha256Base64Url(targetBundle)]),
    );
    await upload(baseHash, baseBundle);
    await upload(targetHash, targetBundle);
    baseUpdateId = (await publish(baseHash)).updates[0]!.id;
    await publish(targetHash);
    expect((await authed(`/publish/patches/${baseHash}/${targetHash}`, { method: "PUT", body: patchBody })).status).toBe(200);
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
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(targetBundle);
    },
  );

  it.each(["patch", "missing", "lookup"] as const)("falls back to the full bundle after a %s failure", async (failure) => {
    readFailure = failure;
    events.length = 0;
    const response = await request(`/assets/${targetHash}`, {
      headers: { "a-im": "bsdiff", "expo-current-update-id": baseUpdateId },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("expo-base-update-id")).toBeNull();
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(targetBundle);
    expect(events).toEqual([{ event: "asset", hash: targetHash, outcome: "full" }]);
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
      expect(await Effect.runPromise(sha256Base64Url(rebuilt))).toBe(targetHash);
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
  });

  it("stores a patch and serves it as a 226 to a client running the base update", async () => {
    const stored = await authed(`/publish/patches/${baseHash}/${targetHash}`, { method: "PUT", body: patchBody });
    expect(stored.status).toBe(200);
    expect(await stored.json()).toEqual({ baseHash, targetHash, size: patchBody.length });

    events.length = 0;
    const patched = await request(`/assets/${targetHash}`, {
      headers: { "a-im": "bsdiff", "expo-current-update-id": baseUpdateId.toUpperCase(), "eas-client-id": "device-1" },
    });
    expect(patched.status).toBe(226);
    expect(patched.headers.get("im")).toBe("bsdiff");
    expect(patched.headers.get("expo-base-update-id")).toBe(baseUpdateId);
    expect(patched.headers.get("content-type")).toBe("application/octet-stream");
    expect(patched.headers.get("cache-control")).toBe("private, max-age=0");
    expect(new Uint8Array(await patched.arrayBuffer())).toEqual(patchBody);
    expect(events).toEqual([{ event: "asset", clientId: "device-1", hash: targetHash, outcome: "patch" }]);
  });

  it("serves the full asset without the header, for an unknown update, and for a pair with no patch", async () => {
    events.length = 0;
    const plain = await request(`/assets/${targetHash}`, { headers: { "expo-current-update-id": baseUpdateId } });
    expect(plain.status).toBe(200);
    expect(new Uint8Array(await plain.arrayBuffer())).toEqual(targetBundle);

    const unknown = await request(`/assets/${targetHash}`, {
      headers: { "a-im": "bsdiff", "expo-current-update-id": crypto.randomUUID() },
    });
    expect(unknown.status).toBe(200);
    expect(new Uint8Array(await unknown.arrayBuffer())).toEqual(targetBundle);

    const reversed = await request(`/assets/${baseHash}`, {
      headers: { "a-im": "gzip, bsdiff", "expo-current-update-id": baseUpdateId },
    });
    expect(reversed.status).toBe(200);
    expect(new Uint8Array(await reversed.arrayBuffer())).toEqual(baseBundle);
    expect(events.map((event) => event.event === "asset" && event.outcome)).toEqual(["full", "full", "full"]);
  });
});
