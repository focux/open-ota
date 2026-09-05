import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import type { BundleUpdate, RollbackUpdate } from "./model.ts";
import { decide, type ManifestHeaders } from "./protocol.ts";
import { rolloutBucket } from "./rollout.ts";

const headers: ManifestHeaders = {
  "expo-protocol-version": "1",
  "expo-platform": "ios",
  "expo-runtime-version": "rt-1",
  "expo-channel-name": "staging",
  "expo-current-update-id": "installed-update",
};
const latest: BundleUpdate = {
  kind: "bundle",
  id: "a29ac93f-cac4-45a3-88d4-a70e860f4256",
  groupId: "group-1",
  branch: "staging",
  platform: "ios",
  runtimeVersion: "rt-1",
  rolloutPercent: 99,
  createdAt: "2026-09-04T00:00:00.000Z",
  launchAsset: { hash: "A".repeat(43), key: "bundle", contentType: "application/javascript" },
  assets: [],
  expoConfig: {},
};
const previous = { ...latest, id: "814f8a3f-ae43-44df-b371-874d1391630b", rolloutPercent: 100 };

// Deterministic samples keep distribution checks reproducible.
const clients = Array.from({ length: 10_000 }, (_, i) => `device-${i}`);

describe("rollout cohorts", () => {
  it.each([
    ["device-0", 85],
    ["device-42", 14],
    ["device-9999", 4],
  ] as const)("preserves the SHA-256 cohort for %s", async (clientId, bucket) => {
    expect(await Effect.runPromise(rolloutBucket(clientId, latest.id))).toBe(bucket);
  });

  it("is deterministic, approximately uniform, and independent between updates", async () => {
    const sample = (updateId: string) => Effect.runPromise(
      Effect.forEach(clients, (id) => rolloutBucket(id, updateId), { concurrency: 32 }),
    );
    const first = await sample(latest.id);
    expect(await sample(latest.id)).toEqual(first);
    const second = await sample(previous.id);
    for (const percent of [1, 10, 30, 50, 99]) {
      const included = first.filter((bucket) => bucket < percent).length / clients.length;
      expect(Math.abs(included - percent / 100)).toBeLessThan(0.02);
    }
    expect(first.every((bucket) => Number.isInteger(bucket) && bucket >= 0 && bucket < 100)).toBe(true);
    const overlap = first.filter((bucket, i) => bucket < 30 && second[i]! < 30).length / clients.length;
    expect(Math.abs(overlap - 0.09)).toBeLessThan(0.02);
  }, 30_000);

  it("keeps selected devices in the rollout as the percentage increases", async () => {
    await Effect.runPromise(Effect.forEach(clients.slice(0, 100), (clientId) => Effect.gen(function* () {
      let entered = false;
      for (const rolloutPercent of [0, 1, 10, 30, 50, 99, 100]) {
        const decision = yield* decide([{ ...latest, rolloutPercent }, previous], { ...headers, "eas-client-id": clientId });
        expect(decision.kind).toBe("manifest");
        const selected = decision.kind === "manifest" && decision.update.id === latest.id;
        if (rolloutPercent === 0) expect(selected).toBe(false);
        if (entered || rolloutPercent === 100) expect(selected).toBe(true);
        entered = selected;
      }
    }), { concurrency: 16 }));
  });

  it.each([undefined, ""])("excludes device id %j until rollout is complete", async (clientId) => {
    const request = { ...headers, "eas-client-id": clientId };
    expect(await Effect.runPromise(decide([latest, previous], request))).toEqual({ kind: "manifest", update: previous });
    expect(await Effect.runPromise(decide([latest], request))).toEqual({ kind: "none" });
    const full = { ...latest, rolloutPercent: 100 };
    expect(await Effect.runPromise(decide([full, previous], request))).toEqual({ kind: "manifest", update: full });
  });

  it("serves a rollback control to held-back devices, then the hotfix at 100%", async () => {
    const control: RollbackUpdate = { ...previous, kind: "rollback" };
    const request = { ...headers, "expo-embedded-update-id": "embedded-update" };
    expect(await Effect.runPromise(decide([latest, control], request))).toEqual({ kind: "rollback", update: control });
    expect(await Effect.runPromise(decide([latest, control], {
      ...request, "expo-current-update-id": "EMBEDDED-UPDATE",
    }))).toEqual({ kind: "none" });
    const full = { ...latest, rolloutPercent: 100 };
    expect(await Effect.runPromise(decide([full, control], request))).toEqual({ kind: "manifest", update: full });
  });
});
