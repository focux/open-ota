import { Effect } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sha256Base64Url } from "./protocol.ts";
import { makeServer, stores } from "./test-support.ts";

describe.each(stores)("delta patches over the %s store", (_, store) => {
  const server = makeServer(store);
  afterAll(() => server.dispose());
  const { request, authed, post, events } = server;

  const baseBundle = new TextEncoder().encode("var version = 1;");
  const targetBundle = new TextEncoder().encode("var version = 2;");
  const patchBody = new TextEncoder().encode("BSDIFF40 pretend patch");
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
