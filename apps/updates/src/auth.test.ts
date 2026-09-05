import { afterAll, describe, expect, it } from "vitest";
import { makeServer } from "./test-support.ts";
import { UpdateStore } from "./store.ts";

const server = makeServer(UpdateStore.memory);
afterAll(() => server.dispose());

describe.each([undefined, "Bearer wrong-token"])("authorization with %j", (authorization) => {
  it.each([
    ["POST", "/publish/assets/missing"],
    ["PUT", "/publish/assets/hash"],
    ["GET", "/publish/branches/staging/bundles"],
    ["PUT", "/publish/patches/base/target"],
    ["POST", "/publish/groups"],
    ["GET", "/admin/overview"],
    ["GET", "/admin/metrics"],
    ["GET", "/admin/branches/staging/groups"],
    ["GET", "/admin/groups/id"],
    ["POST", "/admin/channels/staging"],
    ["POST", "/admin/groups/id/promote"],
    ["POST", "/admin/groups/id/rollout"],
    ["GET", "/admin/branches/staging/rollback-plan"],
    ["POST", "/admin/branches/staging/rollback"],
    ["POST", "/admin/branches/staging/rollback-to-embedded"],
  ])("rejects %s %s before parsing input or touching storage", async (method, path) => {
    const response = await server.request(path, {
      method,
      headers: authorization === undefined ? {} : { authorization },
      ...(method === "GET" ? {} : { body: "invalid JSON" }),
    });
    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ error: "Missing or invalid publish token." });
  });
});
