import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import type { RollbackUpdate } from "./model.ts";
import { decide, parseFailedUpdateIds, type ManifestHeaders } from "./protocol.ts";

const ids = Array.from({ length: 6 }, (_, i) => `abcdef00-0000-4000-8000-${String(i).padStart(12, "0")}`);

describe("failed update reports", () => {
  it("ignores missing, empty, and malformed entries", () => {
    for (const header of [undefined, "", '"", "not-a-uuid", "123"', '"' + "x".repeat(10_000)]) {
      expect(parseFailedUpdateIds(header)).toEqual([]);
    }
  });

  it("normalizes and deduplicates UUIDs while preserving report order", () => {
    expect(parseFailedUpdateIds(`"${ids[0]!.toUpperCase()}", "${ids[1]}", "${ids[0]}"`)).toEqual(ids.slice(0, 2));
  });

  it("limits each report to five unique updates", () => {
    expect(parseFailedUpdateIds(ids.map((id) => `"${id}"`).join(", "))).toEqual(ids.slice(0, 5));
  });

  it("bounds the raw input even if it consists of invalid entries", () => {
    expect(parseFailedUpdateIds(`${'"invalid",'.repeat(1000)}"${ids[0]}"`)).toEqual([]);
    expect(parseFailedUpdateIds(`"${ids[0]}",${" ".repeat(512)}"${ids[1]}"`)).toEqual([ids[0]]);
  });
});

describe("rollback directives", () => {
  const rollback: RollbackUpdate = {
    kind: "rollback", id: "rollback", groupId: "group", branch: "staging", platform: "ios",
    runtimeVersion: "rt-1", rolloutPercent: 100, createdAt: "2026-09-04T00:00:00.000Z",
  };
  const required: ManifestHeaders = {
    "expo-protocol-version": "1", "expo-platform": "ios",
    "expo-runtime-version": "rt-1", "expo-channel-name": "staging",
  };

  it.each([
    {},
    { "expo-current-update-id": "installed" },
    { "expo-embedded-update-id": "embedded" },
    { "expo-current-update-id": "", "expo-embedded-update-id": "" },
  ])("does not infer that a device is embedded from missing ids: %j", async (optional) => {
    expect(await Effect.runPromise(decide([rollback], { ...required, ...optional }))).toEqual({ kind: "rollback", update: rollback });
  });

  it("stops sending the directive once the current id matches embedded", async () => {
    expect(await Effect.runPromise(decide([rollback], {
      ...required, "expo-current-update-id": ids[0]!.toUpperCase(), "expo-embedded-update-id": ids[0],
    }))).toEqual({ kind: "none" });
  });
});
