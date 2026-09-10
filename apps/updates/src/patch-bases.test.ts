import { Effect } from "effect";
import { afterAll, describe, expect, it } from "vitest";
import { sha256Base64Url } from "./crypto.ts";
import { makeServer, stores } from "./test-support.ts";

const bytes = (text: string) => new TextEncoder().encode(text) as Uint8Array<ArrayBuffer>;
const hashOf = (content: Uint8Array<ArrayBuffer>) => Effect.runPromise(sha256Base64Url(content));

// Patch bases are chosen per bundle across branches: a bundle promoted from
// one branch to another is the same bytes, so the devices of both branches
// count toward it, and it is one base even under two update ids.
describe.each(stores)("patch bases across branches over the %s store", (_, store) => {
  const server = makeServer(store);
  afterAll(() => server.dispose());
  const { authed, post, manifest } = server;

  const upload = async (content: Uint8Array<ArrayBuffer>) => {
    const hash = await hashOf(content);
    const response = await authed(`/publish/assets/${hash}`, { method: "PUT", headers: { "content-type": "application/javascript" }, body: content });
    expect(response.status).toBe(200);
    return hash;
  };
  const publish = async (hash: string, branch: string) => {
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
    return ((await response.json()) as { updates: Array<{ id: string }> }).updates[0]!.id;
  };
  const runs = async (device: string, channel: string, updateId: string) => {
    expect((await manifest({ "eas-client-id": device, "expo-channel-name": channel, "expo-current-update-id": updateId })).status).toBe(200);
  };
  const basesFor = async (branch: string, target: string) => {
    const response = await authed(`/publish/branches/${branch}/patch-bases?platform=ios&runtime=rt-1&target=${target}`);
    expect(response.status).toBe(200);
    return ((await response.json()) as { bases: Array<{ hash: string; source: string; updateId: string | null; devices: number }> }).bases;
  };

  it("counts every branch's devices per bundle and lets the branch's own devices break ties", async () => {
    const [a, b, target] = await Promise.all([upload(bytes("bundle a")), upload(bytes("bundle b")), upload(bytes("bundle target"))]);
    const aOnStaging = await publish(a, "staging");
    const bOnStaging = await publish(b, "staging");
    // The same bundle promoted to production gets a new update id there.
    const aOnProduction = await publish(a, "production");

    // Two devices run A, one per branch; two devices on staging run B.
    await runs("staging-a", "staging", aOnStaging);
    await runs("production-a", "production", aOnProduction);
    await runs("staging-b1", "staging", bOnStaging);
    await runs("staging-b2", "staging", bOnStaging);

    // Both bundles have two devices. Publishing to staging prefers B, which
    // staging's own devices run; publishing to production prefers A.
    const aId = [aOnStaging, aOnProduction].sort().at(-1)!;
    expect(await basesFor("staging", target)).toEqual([
      { hash: b, source: "fleet", updateId: bOnStaging, devices: 2 },
      { hash: a, source: "fleet", updateId: aId, devices: 2 },
    ]);
    expect(await basesFor("production", target)).toEqual([
      { hash: a, source: "fleet", updateId: aId, devices: 2 },
      { hash: b, source: "fleet", updateId: bOnStaging, devices: 2 },
    ]);

    // A third device on production tips A ahead on staging as well.
    await runs("production-a2", "production", aOnProduction);
    expect((await basesFor("staging", target)).map((base) => [base.hash, base.devices])).toEqual([[a, 3], [b, 2]]);
  });
});
