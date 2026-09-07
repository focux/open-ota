import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import { BsdiffError } from "./index.ts";
import { loadBsdiff, wasmPath } from "./node.ts";

const fixtures = new URL("../fixtures/", import.meta.url);
const fixture = async (name: string) => new Uint8Array(await readFile(new URL(name, fixtures)));
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

// Deterministic pseudo-random bytes, so a failure reproduces.
const random = (seed: number, length: number) => {
  const out = new Uint8Array(length);
  let state = seed >>> 0;
  for (let i = 0; i < length; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    out[i] = state >>> 24;
  }
  return out;
};

const mutate = (source: Uint8Array, seed: number) => {
  const out = Array.from(source);
  const noise = random(seed, 64);
  for (let i = 0; i < noise.length; i += 4) {
    const at = ((noise[i]! << 8) | noise[i + 1]!) % Math.max(1, out.length);
    switch (noise[i + 2]! % 3) {
      case 0:
        out[at] = noise[i + 3]!;
        break;
      case 1:
        out.splice(at, 0, noise[i + 3]!);
        break;
      default:
        out.splice(at, 1);
    }
  }
  return Uint8Array.from(out);
};

const dirs: Array<string> = [];
afterAll(() => Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true }))));

describe("bsdiff", () => {
  it("ships the module next to the package", async () => {
    const bytes = await readFile(wasmPath);
    expect(Array.from(bytes.subarray(0, 4))).toEqual([0, 0x61, 0x73, 0x6d]);
  });

  it("applies a patch produced by the reference bsdiff", async () => {
    const engine = await loadBsdiff();
    const [v1, v2, reference] = await Promise.all([fixture("v1.hbc"), fixture("v2.hbc"), fixture("v1-to-v2.patch")]);
    expect(sha256(engine.patch(v1, reference))).toBe(sha256(v2));
  });

  it("produces a patch that rebuilds the target and is smaller than it", async () => {
    const engine = await loadBsdiff();
    const [v1, v2] = await Promise.all([fixture("v1.hbc"), fixture("v2.hbc")]);
    const delta = engine.diff(v1, v2);
    expect(delta.subarray(0, 8)).toEqual(new TextEncoder().encode("BSDIFF40"));
    expect(delta.length).toBeLessThan(v2.length);
    expect(sha256(engine.patch(v1, delta))).toBe(sha256(v2));
  });

  it("round-trips edge cases and mutated inputs", async () => {
    const engine = await loadBsdiff();
    const empty = new Uint8Array();
    const cases: Array<[Uint8Array, Uint8Array]> = [
      [empty, empty],
      [empty, random(1, 300)],
      [random(2, 300), empty],
      [random(3, 5000), random(3, 5000)],
      [new Uint8Array(70_000), new Uint8Array(70_001)],
    ];
    for (let seed = 10; seed < 30; seed++) {
      const base = random(seed, 20_000 + seed * 100);
      cases.push([base, mutate(base, seed * 31)]);
    }
    for (const [old, target] of cases) {
      const delta = engine.diff(old, target);
      expect(engine.patch(old, delta)).toEqual(target);
    }
  });

  it("rejects corrupt patches with a typed error", async () => {
    const engine = await loadBsdiff();
    const [v1, reference] = await Promise.all([fixture("v1.hbc"), fixture("v1-to-v2.patch")]);
    expect(() => engine.patch(v1, new TextEncoder().encode("BSDIFF40"))).toThrow(BsdiffError);
    const truncated = reference.subarray(0, 200);
    expect(() => engine.patch(v1, truncated)).toThrow(expect.objectContaining({ code: "corrupt-patch" }));
    const wrongMagic = Uint8Array.from(reference);
    wrongMagic[0] = 0x41;
    expect(() => engine.patch(v1, wrongMagic)).toThrow(expect.objectContaining({ code: "corrupt-patch" }));
  });

  it("keeps working after large inputs grew the memory", async () => {
    const engine = await loadBsdiff();
    const big = random(99, 3_000_000);
    const changed = mutate(big, 7);
    const delta = engine.diff(big, changed);
    expect(engine.patch(big, delta)).toEqual(changed);
    const [v1, v2] = await Promise.all([fixture("v1.hbc"), fixture("v2.hbc")]);
    expect(engine.patch(v1, engine.diff(v1, v2))).toEqual(v2);
  });

  // The conformance check that matters: a patch we wrote, applied by an
  // independent bspatch. Skipped where the binary is not installed.
  it("is applied correctly by the system bspatch", async () => {
    const exec = promisify(execFile);
    const available = await exec("bspatch", []).then(() => true, (error: { code?: string }) => error.code !== "ENOENT");
    if (!available) return;
    const engine = await loadBsdiff();
    const [v1, v2] = await Promise.all([fixture("v1.hbc"), fixture("v2.hbc")]);
    const dir = await mkdtemp(path.join(tmpdir(), "open-ota-bsdiff-"));
    dirs.push(dir);
    await writeFile(path.join(dir, "old"), v1);
    await writeFile(path.join(dir, "delta"), engine.diff(v1, v2));
    await exec("bspatch", [path.join(dir, "old"), path.join(dir, "new"), path.join(dir, "delta")]);
    expect(sha256(await readFile(path.join(dir, "new")))).toBe(sha256(v2));
  });
});
