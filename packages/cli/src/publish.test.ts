import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { Run } from "./expo.ts";
import { publish, rollbackToEmbedded } from "./publish.ts";
import type { Server } from "./server.ts";

const iosBundle = "ios bundle bytes";
const androidBundle = "android bundle bytes";
const image = "png bytes";
const olderIosBundle = "older ios bundle bytes";

const sha = (content: string) => createHash("sha256").update(content).digest("base64url");
const md5 = (content: string) => createHash("md5").update(content).digest("hex");

const dirs: Array<string> = [];
afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

const makeDist = async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ota-cli-"));
  dirs.push(dir);
  await mkdir(path.join(dir, "_expo/static/js/ios"), { recursive: true });
  await mkdir(path.join(dir, "_expo/static/js/android"), { recursive: true });
  await mkdir(path.join(dir, "assets"), { recursive: true });
  await writeFile(path.join(dir, "_expo/static/js/ios/index.hbc"), iosBundle);
  await writeFile(path.join(dir, "_expo/static/js/android/index.hbc"), androidBundle);
  await writeFile(path.join(dir, "assets/logo"), image);
  await writeFile(
    path.join(dir, "metadata.json"),
    JSON.stringify({
      version: 0,
      bundler: "metro",
      fileMetadata: {
        ios: { bundle: "_expo/static/js/ios/index.hbc", assets: [{ path: "assets/logo", ext: "png" }] },
        android: { bundle: "_expo/static/js/android/index.hbc", assets: [{ path: "assets/logo", ext: "png" }] },
      },
    }),
  );
  return dir;
};

const fakeRun: Run = async (command, args) => {
  if (command === "git") return "cafebabe\n";
  if (args.includes("runtimeversion:resolve")) {
    const platform = args[args.indexOf("--platform") + 1];
    return `Resolving fingerprint\n{"runtimeVersion":"rt-${platform}"}\n`;
  }
  if (args.includes("config")) return `noise\n${JSON.stringify({ slug: "acme" })}\n`;
  return "";
};

interface Call {
  method: string;
  url: string;
  contentType: string | undefined;
  body: string;
}

interface ServerOptions {
  group?: { status: number; body: string };
  // Newest launch assets the branch already has, per platform, and their bytes.
  bundles?: Record<string, ReadonlyArray<{ updateId: string; hash: string }>>;
  contents?: Record<string, string>;
}

const makeServer = (missing: ReadonlyArray<string>, options: ServerOptions = {}) => {
  const calls: Array<Call> = [];
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const body = init?.body;
    calls.push({
      method: init?.method ?? "GET",
      url,
      contentType: headers["content-type"],
      body: body === undefined ? "" : typeof body === "string" ? body : Buffer.from(body as Uint8Array).toString(),
    });
    if (url.endsWith("/publish/assets/missing")) {
      return Response.json({ missing });
    }
    if (url.includes("/publish/assets/")) {
      return Response.json({ ok: true });
    }
    if (url.includes("/publish/branches/")) {
      const platform = new URL(url).searchParams.get("platform") ?? "";
      return Response.json({ bundles: options.bundles?.[platform] ?? [] });
    }
    if (url.includes("/publish/patches/")) {
      return Response.json({ ok: true });
    }
    if (url.endsWith("/publish/groups")) {
      if (options.group !== undefined) {
        return new Response(options.group.body, { status: options.group.status });
      }
      return Response.json(
        { groupId: "group-1", updates: [{ id: "update-1", platform: "ios", runtimeVersion: "rt-ios" }] },
        { status: 201 },
      );
    }
    const content = options.contents?.[url.slice(url.lastIndexOf("/") + 1)];
    if (url.includes("/assets/") && content !== undefined) {
      return new Response(content);
    }
    throw new Error(`unexpected request ${url}`);
  };
  const server: Server = { url: "https://ota.test", token: "secret", fetch: fetchImpl as typeof fetch };
  return { server, calls };
};

const options = (distDir: string, server: Server) => ({
  branch: "staging",
  message: undefined,
  rolloutPercent: undefined,
  platforms: ["ios", "android"] as const,
  projectDir: distDir,
  distDir,
  skipExport: true,
  noPatches: false,
  server,
  run: fakeRun,
  log: () => {},
});

const groupBody = (calls: ReadonlyArray<Call>) =>
  JSON.parse(calls.find((call) => call.url.endsWith("/publish/groups"))!.body) as Record<string, any>;

describe("publish", () => {
  it("hashes assets the way the server does and uploads only the missing ones", async () => {
    const dist = await makeDist();
    const { server, calls } = makeServer([sha(iosBundle), sha(image)]);

    await publish(options(dist, server));

    const asked = JSON.parse(calls.find((call) => call.url.endsWith("/assets/missing"))!.body) as {
      hashes: Array<string>;
    };
    expect(asked.hashes.sort()).toEqual([sha(androidBundle), sha(image), sha(iosBundle)].sort());

    const puts = calls.filter((call) => call.method === "PUT");
    expect(puts.map((call) => call.url).sort()).toEqual(
      [`https://ota.test/publish/assets/${sha(iosBundle)}`, `https://ota.test/publish/assets/${sha(image)}`].sort(),
    );
    expect(puts.find((call) => call.url.endsWith(sha(iosBundle)))?.contentType).toBe("application/javascript");
    expect(puts.find((call) => call.url.endsWith(sha(image)))?.contentType).toBe("image/png");
    expect(puts.find((call) => call.url.endsWith(sha(image)))?.body).toBe(image);

    const body = groupBody(calls);
    expect(body["updates"].ios.launchAsset).toEqual({
      hash: sha(iosBundle),
      key: md5(iosBundle),
      contentType: "application/javascript",
      fileExtension: ".bundle",
    });
    expect(body["updates"].ios.assets).toEqual([
      { hash: sha(image), key: md5(image), contentType: "image/png", fileExtension: ".png" },
    ]);
  });

  it("sends a group for both platforms and omits rolloutPercent unless asked", async () => {
    const dist = await makeDist();
    const plain = makeServer([]);
    await publish(options(dist, plain.server));

    const body = groupBody(plain.calls);
    expect(body["branch"]).toBe("staging");
    expect(body["gitCommit"]).toBe("cafebabe");
    expect(body["expoConfig"]).toEqual({ slug: "acme" });
    expect(body["updates"].ios.runtimeVersion).toBe("rt-ios");
    expect(body["updates"].android.runtimeVersion).toBe("rt-android");
    expect(body["updates"].android.launchAsset.hash).toBe(sha(androidBundle));
    expect(body).not.toHaveProperty("rolloutPercent");
    expect(body).not.toHaveProperty("message");

    const rollout = makeServer([]);
    await publish({ ...options(dist, rollout.server), rolloutPercent: 25, message: "ship it" });
    expect(groupBody(rollout.calls)["rolloutPercent"]).toBe(25);
    expect(groupBody(rollout.calls)["message"]).toBe("ship it");
  });

  it("publishes a rollback group with no assets", async () => {
    const dist = await makeDist();
    const { server, calls } = makeServer([]);

    await rollbackToEmbedded({
      branch: "staging",
      message: undefined,
      platforms: ["ios", "android"],
      projectDir: dist,
      server,
      run: fakeRun,
      log: () => {},
    });

    expect(calls.map((call) => call.url)).toEqual(["https://ota.test/publish/groups"]);
    const body = groupBody(calls);
    expect(body["updates"]).toEqual({
      ios: { runtimeVersion: "rt-ios", rollbackToEmbedded: true },
      android: { runtimeVersion: "rt-android", rollbackToEmbedded: true },
    });
    expect(body).not.toHaveProperty("expoConfig");
  });

  it("fails with the status and body of a rejected request", async () => {
    const dist = await makeDist();
    const { server } = makeServer([], { group: { status: 400, body: "Assets not uploaded: abc" } });

    await expect(publish(options(dist, server))).rejects.toThrow(/400.*Assets not uploaded: abc/s);
  });
});

interface Diff {
  command: string;
  args: ReadonlyArray<string>;
  cwd: string;
  base: string;
  target: string;
}

// Stands in for the bsdiff binary: records the argv it was given, reads back the
// two inputs, and writes the patch the CLI then uploads.
const diffRun = (diffs: Array<Diff>, patch: string | Error): Run => async (command, args, cwd) => {
  if (command !== "bsdiff") return fakeRun(command, args, cwd);
  diffs.push({
    command,
    args,
    cwd,
    base: await readFile(args[0]!, "utf8"),
    target: await readFile(args[1]!, "utf8"),
  });
  if (patch instanceof Error) throw patch;
  await writeFile(args[2]!, patch);
  return "";
};

describe("patches", () => {
  const patchServer = () =>
    makeServer([], {
      bundles: {
        ios: [
          { updateId: "ios-new", hash: sha(iosBundle) },
          { updateId: "ios-old", hash: sha(olderIosBundle) },
        ],
        android: [{ updateId: "android-new", hash: sha(androidBundle) }],
      },
      contents: { [sha(olderIosBundle)]: olderIosBundle },
    });

  it("diffs the new bundle against the older ones on the branch and uploads the patches", async () => {
    const dist = await makeDist();
    const { server, calls } = patchServer();
    const diffs: Array<Diff> = [];
    const logs: Array<string> = [];

    await publish({ ...options(dist, server), run: diffRun(diffs, "patch bytes"), log: (line) => logs.push(line) });

    expect(calls.filter((call) => call.url.includes("/publish/branches/")).map((call) => call.url)).toEqual([
      "https://ota.test/publish/branches/staging/bundles?platform=ios&runtime=rt-ios&limit=3",
      "https://ota.test/publish/branches/staging/bundles?platform=android&runtime=rt-android&limit=3",
    ]);
    expect(calls.filter((call) => call.url.startsWith("https://ota.test/assets/")).map((call) => call.url)).toEqual([
      `https://ota.test/assets/${sha(olderIosBundle)}`,
    ]);

    expect(diffs).toHaveLength(1);
    const diff = diffs[0]!;
    expect(diff.args).toHaveLength(3);
    expect(diff.args.map((arg) => path.dirname(arg))).toEqual([diff.cwd, diff.cwd, diff.cwd]);
    expect(diff.args.map((arg) => path.basename(arg))).toEqual([
      `${sha(olderIosBundle)}.bundle`,
      "target.bundle",
      `${sha(olderIosBundle)}.patch`,
    ]);
    expect(diff.base).toBe(olderIosBundle);
    expect(diff.target).toBe(iosBundle);
    expect(existsSync(diff.cwd)).toBe(false);

    const put = calls.find((call) => call.url.includes("/publish/patches/"))!;
    expect(put.method).toBe("PUT");
    expect(put.url).toBe(`https://ota.test/publish/patches/${sha(olderIosBundle)}/${sha(iosBundle)}`);
    expect(put.contentType).toBe("application/octet-stream");
    expect(put.body).toBe("patch bytes");
    expect(logs).toContain(`patch ${sha(olderIosBundle).slice(0, 7)}..${sha(iosBundle).slice(0, 7)} 11`);
  });

  it("warns and keeps the publish when bsdiff fails", async () => {
    const dist = await makeDist();
    const { server, calls } = patchServer();
    const diffs: Array<Diff> = [];
    const logs: Array<string> = [];

    const published = await publish({
      ...options(dist, server),
      run: diffRun(diffs, new Error("bsdiff: command not found")),
      log: (line) => logs.push(line),
    });

    expect(published.groupId).toBe("group-1");
    expect(calls.some((call) => call.url.includes("/publish/patches/"))).toBe(false);
    expect(logs).toContain(`warning: no patch from ${sha(olderIosBundle).slice(0, 7)}: bsdiff: command not found`);
  });

  it("skips patching entirely with --no-patches", async () => {
    const dist = await makeDist();
    const { server, calls } = patchServer();
    const diffs: Array<Diff> = [];

    await publish({ ...options(dist, server), noPatches: true, run: diffRun(diffs, "patch bytes") });

    expect(calls.some((call) => call.url.includes("/publish/branches/"))).toBe(false);
    expect(diffs).toEqual([]);
  });
});
