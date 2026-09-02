import { Effect } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sha256Base64Url } from "./protocol.ts";
import { Signer } from "./signing.ts";
import { keys, makeServer, origin, parseMultipart, stores } from "./test-support.ts";
import testPrivateKey from "./fixtures/test-private-key.pem?raw";
import testPublicKey from "./fixtures/test-public-key.pem?raw";

describe.each(stores)("updates server over the %s store", (_, store) => {
  const server = makeServer(store);
  afterAll(() => server.dispose());
  const { request, authed: publishRequest, manifest: manifestRequest } = server;

  const bundle = new TextEncoder().encode("var hello = 'world';");
  let bundleHash = "";
  const launchAsset = () => ({ hash: bundleHash, key: "b1946ac92492d2347c6235b4d2611184", contentType: "application/javascript", fileExtension: ".hbc" });

  const publishGroup = async (body: unknown) => {
    const response = await publishRequest("/publish/groups", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(201);
    return (await response.json()) as { groupId: string; updates: Array<{ id: string; platform: string }> };
  };

  beforeAll(async () => {
    bundleHash = await Effect.runPromise(sha256Base64Url(bundle));
  });

  it("rejects publishing without the token", async () => {
    const response = await request("/publish/assets/missing", { method: "POST", body: JSON.stringify({ hashes: [] }) });
    expect(response.status).toBe(401);
  });

  it("stores assets by hash and rejects mismatched bodies", async () => {
    const missing = await publishRequest("/publish/assets/missing", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hashes: [bundleHash] }),
    });
    expect(await missing.json()).toEqual({ missing: [bundleHash] });

    const wrong = await publishRequest(`/publish/assets/${bundleHash}`, { method: "PUT", body: "not the bundle" });
    expect(wrong.status).toBe(400);

    const put = await publishRequest(`/publish/assets/${bundleHash}`, {
      method: "PUT",
      headers: { "content-type": "application/javascript" },
      body: bundle,
    });
    expect(put.status).toBe(200);

    const served = await request(`/assets/${bundleHash}`);
    expect(served.status).toBe(200);
    expect(served.headers.get("content-type")).toBe("application/javascript");
    expect(served.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(served.headers.get("vary")).toBe("A-IM, Expo-Current-Update-ID");
    expect(served.headers.get("cache-tag")).toBe("asset");
    expect(put.headers.get("cache-control")).toBe("no-store");
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(bundle);

    expect((await request("/assets/unknown")).status).toBe(404);
  });

  it("answers noUpdateAvailable before anything is published", async () => {
    const response = await manifestRequest({});
    expect(response.status).toBe(200);
    expect(response.headers.get("expo-protocol-version")).toBe("1");
    expect(response.headers.get("expo-manifest-filters")).toBe('branchname="staging"');
    const parts = await parseMultipart(response);
    expect(parts.map((p) => p.name)).toEqual(["directive"]);
    expect(JSON.parse(parts[0]!.body)).toEqual({ type: "noUpdateAvailable" });
  });

  it("rejects unsupported protocol versions and missing headers", async () => {
    expect((await manifestRequest({ "expo-protocol-version": "0" })).status).toBe(400);
    expect((await request("/manifest")).status).toBe(400);
  });

  it("refuses a group that references assets that were never uploaded", async () => {
    const response = await publishRequest("/publish/groups", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        branch: "staging",
        updates: { ios: { runtimeVersion: "rt-1", launchAsset: { ...launchAsset(), hash: "A".repeat(43) }, assets: [] } },
      }),
    });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toContain("Assets not uploaded");
  });

  it("serves a signed manifest for the newest published update", async () => {
    const group = await publishGroup({
      branch: "staging",
      message: "first",
      expoConfig: { name: "Acme", slug: "acme" },
      updates: { ios: { runtimeVersion: "rt-1", launchAsset: launchAsset(), assets: [] } },
    });
    const response = await manifestRequest({ "expo-expect-signature": 'sig, keyid="main", alg="rsa-v1_5-sha256"' });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/^multipart\/mixed; boundary=/);
    expect(response.headers.get("cache-control")).toBe("private, max-age=0");
    const parts = await parseMultipart(response);
    expect(parts.map((p) => p.name)).toEqual(["manifest", "extensions"]);

    const manifest = JSON.parse(parts[0]!.body);
    expect(manifest.id).toBe(group.updates[0]!.id);
    expect(manifest.runtimeVersion).toBe("rt-1");
    expect(manifest.launchAsset).toEqual({ ...launchAsset(), url: `${origin}/assets/${bundleHash}` });
    expect(manifest.metadata).toEqual({ branchName: "staging" });
    expect(manifest.extra.expoClient.slug).toBe("acme");

    const signature = parts[0]!.headers["expo-signature"]!;
    const sig = /sig="([^"]+)", keyid="main"/.exec(signature)![1]!;
    const verified = await crypto.subtle.verify(
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      keys.publicKey,
      Uint8Array.from(atob(sig), (c) => c.charCodeAt(0)),
      new TextEncoder().encode(parts[0]!.body),
    );
    expect(verified).toBe(true);
    expect(parts[1]!.headers["expo-signature"]).toBeUndefined();

    const same = await parseMultipart(await manifestRequest({ "expo-current-update-id": manifest.id.toUpperCase() }));
    expect(JSON.parse(same[0]!.body)).toEqual({ type: "noUpdateAvailable" });

    const android = await parseMultipart(await manifestRequest({ "expo-platform": "android" }));
    expect(JSON.parse(android[0]!.body)).toEqual({ type: "noUpdateAvailable" });
  });

  it("keeps devices outside a rollout on the previous update", async () => {
    const before = JSON.parse((await parseMultipart(await manifestRequest({})))[0]!.body);
    const rolled = await publishGroup({
      branch: "staging",
      rolloutPercent: 0,
      updates: { ios: { runtimeVersion: "rt-1", launchAsset: launchAsset(), assets: [] } },
    });
    const excluded = JSON.parse((await parseMultipart(await manifestRequest({})))[0]!.body);
    expect(excluded.id).toBe(before.id);

    const half = await publishGroup({
      branch: "staging",
      rolloutPercent: 50,
      updates: { ios: { runtimeVersion: "rt-1", launchAsset: launchAsset(), assets: [] } },
    });
    const seen = new Set<string>();
    for (let device = 0; device < 40; device++) {
      const parts = await parseMultipart(await manifestRequest({ "eas-client-id": `device-${device}` }));
      seen.add(JSON.parse(parts[0]!.body).id);
    }
    expect(seen).toEqual(new Set([rolled.updates[0]!.id, half.updates[0]!.id]));
  });

  it("sends rollBackToEmbedded until the device is back on the embedded update", async () => {
    const rollback = await publishGroup({
      branch: "staging",
      updates: { ios: { runtimeVersion: "rt-1", rollbackToEmbedded: true } },
    });
    const directive = await parseMultipart(
      await manifestRequest({ "expo-current-update-id": "abc", "expo-embedded-update-id": "embedded", "expo-expect-signature": "sig" }),
    );
    expect(directive[0]!.name).toBe("directive");
    expect(directive[0]!.headers["expo-signature"]).toContain('keyid="main"');
    expect(JSON.parse(directive[0]!.body)).toEqual({
      type: "rollBackToEmbedded",
      parameters: { commitTime: expect.stringMatching(/^\d{4}-/) },
    });
    expect(rollback.updates[0]!.platform).toBe("ios");

    const done = await parseMultipart(
      await manifestRequest({ "expo-current-update-id": "embedded", "expo-embedded-update-id": "embedded" }),
    );
    expect(JSON.parse(done[0]!.body)).toEqual({ type: "noUpdateAvailable" });
  });

  it("answers an unknown channel with noUpdateAvailable and no filters", async () => {
    const response = await manifestRequest({ "expo-channel-name": "nope" });
    expect(response.status).toBe(200);
    expect(response.headers.get("expo-manifest-filters")).toBeNull();
    expect(JSON.parse((await parseMultipart(response))[0]!.body)).toEqual({ type: "noUpdateAvailable" });
  });
});

describe("Signer.fromPem", () => {
  it("imports a PKCS#1 key as written by expo-updates codesigning:generate", async () => {
    const signature = await Effect.runPromise(
      Effect.gen(function* () {
        const signer = yield* Signer;
        return yield* signer.sign(new TextEncoder().encode("payload"));
      }).pipe(Effect.provide(Signer.fromPem(testPrivateKey, "main"))),
    );
    const publicKey = await crypto.subtle.importKey(
      "spki",
      Uint8Array.from(atob(testPublicKey.replace(/-----[A-Z ]+-----/g, "").replace(/\s+/g, "")), (c) => c.charCodeAt(0)),
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
    const ok = await crypto.subtle.verify(
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      publicKey,
      Uint8Array.from(atob(signature), (c) => c.charCodeAt(0)),
      new TextEncoder().encode("payload"),
    );
    expect(ok).toBe(true);
  });
});
