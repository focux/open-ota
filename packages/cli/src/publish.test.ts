import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { NodeServices } from "@effect/platform-node";
import { loadBsdiff } from "@open-ota/bsdiff/node";
import { Effect, Layer, Redacted } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { Processes } from "./expo.ts";
import { CliFailure, ProcessFailure } from "./errors.ts";
import { Progress, type Report } from "./output.ts";
import { Differ } from "./patches.ts";
type Run = (command: string, args: ReadonlyArray<string>, cwd: string) => Promise<string>;
interface TestServer {
  url: string;
  token: string;
  fetch: typeof fetch;
}
import {
  backfillPatches as backfillEffect,
  publish as publishEffect,
  registerEmbedded as registerEffect,
  rollbackToEmbedded as rollbackEffect,
  type BackfillOptions,
  type EmbeddedOptions,
  type PublishOptions,
  type RollbackOptions,
} from "./publish.ts";
import { Server } from "./server.ts";

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
  bytes: Uint8Array | undefined;
}

interface Base {
  hash: string;
  source: "fleet" | "embedded" | "recent";
  updateId: string | null;
  devices: number;
}

interface ServerOptions {
  group?: { status: number; body: string };
  // Newest launch assets the branch already has, per platform, and their bytes.
  bundles?: Record<string, ReadonlyArray<{ updateId: string; hash: string }>>;
  // What the server ranks as worth diffing against, per platform.
  bases?: Record<string, ReadonlyArray<Base>>;
  maxRatio?: number;
  maxBundleBytes?: number;
  // Bases that already have a patch toward the newest bundle.
  covered?: ReadonlyArray<string>;
  decline?: string;
  contents?: Record<string, string>;
}

const makeServer = (missing: ReadonlyArray<string>, options: ServerOptions = {}) => {
  const calls: Array<Call> = [];
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const body = init?.body;
    const bytes = body === undefined || typeof body === "string" ? undefined : new Uint8Array(body as Uint8Array);
    calls.push({
      method: init?.method ?? "GET",
      url,
      contentType: headers["content-type"],
      body: body === undefined ? "" : typeof body === "string" ? body : Buffer.from(bytes!).toString(),
      bytes,
    });
    if (url.endsWith("/publish/assets/missing")) {
      return Response.json({ missing });
    }
    if (url.includes("/publish/assets/")) {
      return Response.json({ ok: true });
    }
    if (url.includes("/patch-bases")) {
      const platform = new URL(url).searchParams.get("platform") ?? "";
      return Response.json({
        bases: options.bases?.[platform] ?? [],
        maxRatio: options.maxRatio ?? 100,
        maxBundleBytes: options.maxBundleBytes ?? 32 * 1024 * 1024,
      });
    }
    if (url.includes("/publish/branches/")) {
      const platform = new URL(url).searchParams.get("platform") ?? "";
      return Response.json({ bundles: options.bundles?.[platform] ?? [] });
    }
    if (url.includes("/publish/patches/")) {
      const size = bytes?.length ?? 0;
      return Response.json(
        options.decline === undefined
          ? { stored: true, size, wireSize: 100, ratio: size / 100 }
          : { stored: false, reason: options.decline, size, wireSize: 100, ratio: size / 100, maxRatio: 0.3 },
      );
    }
    if (url.includes("/admin/updates/")) {
      return Response.json({ patches: (options.covered ?? []).map((baseHash) => ({ baseHash, size: 1 })) });
    }
    if (url.endsWith("/publish/embedded")) {
      const text = bytes === undefined ? (body as string) : Buffer.from(bytes).toString();
      return Response.json({ updateId: (JSON.parse(text) as { updateId: string }).updateId.toLowerCase() }, { status: 201 });
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
  const server: TestServer = { url: "https://ota.test", token: "secret", fetch: fetchImpl as typeof fetch };
  return { server, calls };
};

const options = (distDir: string, server: TestServer) => ({
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
  report: () => {},
});

type TestOptions = { server: TestServer; run: Run; report: Report; differ?: Layer.Layer<Differ> };
const runWith = <A, E>(
  program: Effect.Effect<A, E, Server | Processes | Progress | Differ | import("effect").FileSystem.FileSystem>,
  options: TestOptions,
) =>
  Effect.runPromise(
    program.pipe(
      Effect.provide(options.differ ?? Differ.layer),
      Effect.provide(
        Server.layer(options.server.url, Redacted.make(options.server.token)).pipe(
          Layer.provide(FetchHttpClient.layer),
          Layer.provide(Layer.succeed(FetchHttpClient.Fetch, options.server.fetch)),
        ),
      ),
      Effect.provide(
        Layer.succeed(Processes, {
          run: (command, args, cwd) =>
            Effect.tryPromise({
              try: () => options.run(command, args, cwd),
              catch: (cause) =>
                new ProcessFailure({
                  command,
                  missing: String(cause).includes("command not found"),
                  message: cause instanceof Error ? cause.message : String(cause),
                  cause,
                }),
            }),
        }),
      ),
      Effect.provide(
        Layer.succeed(Progress, {
          report: (event) => Effect.sync(() => options.report(event)),
          fail: () => Effect.void,
          close: Effect.void,
        }),
      ),
      Effect.provide(NodeServices.layer),
    ),
  );
const publish = (options: PublishOptions & TestOptions) => runWith(publishEffect(options), options);
const rollbackToEmbedded = (options: RollbackOptions & TestOptions) => runWith(rollbackEffect(options), options);
const registerEmbedded = (options: EmbeddedOptions & TestOptions) => runWith(registerEffect(options), options);
const backfillPatches = (options: BackfillOptions & TestOptions) => runWith(backfillEffect(options), options);

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
      report: () => {},
    });

    expect(calls.map((call) => call.url)).toEqual(["https://ota.test/publish/groups"]);
    const body = groupBody(calls);
    expect(body["updates"]).toEqual({
      ios: { runtimeVersion: "rt-ios", rollbackToEmbedded: true },
      android: { runtimeVersion: "rt-android", rollbackToEmbedded: true },
    });
    expect(body).not.toHaveProperty("expoConfig");
  });

  it("rejects a malformed publish response instead of reporting success", async () => {
    const dist = await makeDist();
    const { server, calls } = makeServer([], { group: { status: 201, body: "{}" } });
    await expect(publish(options(dist, server))).rejects.toThrow("Invalid response");
    // Patches are prepared first, so the failed group submit is the last call.
    expect(calls.at(-1)?.url).toBe("https://ota.test/publish/groups");
  });

  it("fails with the status and body of a rejected request", async () => {
    const dist = await makeDist();
    const { server } = makeServer([], { group: { status: 400, body: "Assets not uploaded: abc" } });

    await expect(publish(options(dist, server))).rejects.toThrow(/400.*Assets not uploaded: abc/s);
  });
});

const bytes = (text: string) => new TextEncoder().encode(text);
const short = (hash: string) => hash.slice(0, 7);

describe("patches", () => {
  const older: Base = { hash: sha(olderIosBundle), source: "fleet", updateId: "ios-old", devices: 3 };
  const patchServer = (options: ServerOptions = {}) =>
    makeServer([], {
      bases: { ios: [older], android: [] },
      contents: { [sha(olderIosBundle)]: olderIosBundle },
      ...options,
    });
  const patchCalls = (calls: ReadonlyArray<Call>) => calls.filter((call) => call.url.includes("/publish/patches/"));

  it("diffs the new bundle against the bases the server ranks and uploads verified patches first", async () => {
    const dist = await makeDist();
    const { server, calls } = patchServer();
    const logs: Array<string> = [];

    await publish({ ...options(dist, server), report: (event) => logs.push(event.message) });

    expect(calls.filter((call) => call.url.includes("/patch-bases")).map((call) => call.url)).toEqual([
      `https://ota.test/publish/branches/staging/patch-bases?platform=ios&runtime=rt-ios&target=${sha(iosBundle)}`,
      `https://ota.test/publish/branches/staging/patch-bases?platform=android&runtime=rt-android&target=${sha(androidBundle)}`,
    ]);
    expect(calls.filter((call) => call.url.startsWith("https://ota.test/assets/")).map((call) => call.url)).toEqual([
      `https://ota.test/assets/${sha(olderIosBundle)}`,
    ]);

    const [put] = patchCalls(calls);
    expect(put?.method).toBe("PUT");
    expect(put?.url).toBe(`https://ota.test/publish/patches/${sha(olderIosBundle)}/${sha(iosBundle)}`);
    expect(put?.contentType).toBe("application/octet-stream");
    // The uploaded bytes are a real BSDIFF40 patch that rebuilds the new bundle.
    const engine = await loadBsdiff();
    expect(Buffer.from(put!.bytes!.subarray(0, 8)).toString()).toBe("BSDIFF40");
    expect(Buffer.from(engine.patch(bytes(olderIosBundle), put!.bytes!)).toString()).toBe(iosBundle);
    expect(logs.some((line) => line.startsWith(`ios: patch ${short(sha(olderIosBundle))} to ${short(sha(iosBundle))}, ${put!.bytes!.length} bytes`) && line.endsWith("(3 devices run it)"))).toBe(true);
    expect(logs).toContain("Delta patches: 1 uploaded, 0 skipped, 0 failed");

    // No device can ask for the new bundle until the group exists, so the patch
    // must already be on the server by then.
    const patchIndex = calls.findIndex((call) => call.url.includes("/publish/patches/"));
    const groupIndex = calls.findIndex((call) => call.url.endsWith("/publish/groups"));
    expect(patchIndex).toBeGreaterThanOrEqual(0);
    expect(groupIndex).toBeGreaterThan(patchIndex);
  });

  it("warns and keeps the publish when the engine fails", async () => {
    const dist = await makeDist();
    const { server, calls } = patchServer();
    const logs: Array<string> = [];
    const broken = Layer.succeed(Differ, {
      diff: () => Effect.fail(new CliFailure({ message: "bsdiff failed: engine exploded" })),
      patch: () => Effect.fail(new CliFailure({ message: "unreachable" })),
    });

    const published = await publish({ ...options(dist, server), differ: broken, report: (event) => logs.push(event.message) });

    expect(published.groupId).toBe("group-1");
    expect(patchCalls(calls)).toHaveLength(0);
    expect(logs).toContain(`Patch from ${short(sha(olderIosBundle))} failed: bsdiff failed: engine exploded`);
    expect(logs).toContain("Delta patches: 0 uploaded, 0 skipped, 1 failed");
  });

  it("never uploads a patch that does not rebuild the bundle locally", async () => {
    const dist = await makeDist();
    const { server, calls } = patchServer();
    const logs: Array<string> = [];
    const lying = Layer.succeed(Differ, {
      diff: () => Effect.succeed(bytes("BSDIFF40 but wrong")),
      patch: () => Effect.succeed(bytes("not the target")),
    });

    await publish({ ...options(dist, server), differ: lying, report: (event) => logs.push(event.message) });

    expect(patchCalls(calls)).toHaveLength(0);
    expect(logs).toContain(`Patch from ${short(sha(olderIosBundle))} failed: the patch does not rebuild the target bundle`);
  });

  it.each(["../../outside", "/tmp/outside", "..\\outside", "not-a-hash"])(
    "rejects an unsafe server base hash %j before downloading it",
    async (hash) => {
      const dist = await makeDist();
      const { server, calls } = makeServer([], { bases: { ios: [{ ...older, hash }] } });
      const logs: Array<string> = [];
      const published = await publish({ ...options(dist, server), report: (event) => logs.push(event.message) });
      expect(published.groupId).toBe("group-1");
      expect(calls.some((call) => new URL(call.url).pathname.startsWith("/assets/"))).toBe(false);
      expect(logs.some((message) => message.includes("Invalid response"))).toBe(true);
    },
  );

  it("patches every base the server lists before publishing the new bundle", async () => {
    const dist = await makeDist();
    const contents = ["older one", "older two", "older three"];
    const { server, calls } = makeServer([], {
      bases: {
        ios: [
          { hash: sha(contents[0]!), source: "fleet", updateId: "a", devices: 9 },
          { hash: sha(contents[1]!), source: "embedded", updateId: "b", devices: 0 },
          { hash: sha(contents[2]!), source: "recent", updateId: "c", devices: 0 },
        ],
      },
      contents: Object.fromEntries(contents.map((content) => [sha(content), content])),
    });
    const logs: Array<string> = [];

    await publish({ ...options(dist, server), report: (event) => logs.push(event.message) });

    expect(patchCalls(calls).map((call) => call.url)).toEqual(
      contents.map((content) => `https://ota.test/publish/patches/${sha(content)}/${sha(iosBundle)}`),
    );
    expect(logs.filter((line) => line.startsWith("ios: patch ")).map((line) => line.slice(line.lastIndexOf("(")))).toEqual([
      "(9 devices run it)",
      "(embedded in a build)",
      "(recently published)",
    ]);
  });

  it("skips a patch above the server's share of the compressed bundle without uploading it", async () => {
    const dist = await makeDist();
    const { server, calls } = patchServer({ maxRatio: 0.01 });
    const logs: Array<string> = [];

    const published = await publish({ ...options(dist, server), report: (event) => logs.push(event.message) });

    expect(published.groupId).toBe("group-1");
    expect(patchCalls(calls)).toHaveLength(0);
    expect(logs.some((line) => line.startsWith(`Skipped patch from ${short(sha(olderIosBundle))}:`) && line.includes("over the 1% limit"))).toBe(true);
    expect(logs).toContain("Delta patches: 0 uploaded, 1 skipped, 0 failed");
  });

  it("reports a patch the server declined as skipped, not failed", async () => {
    const dist = await makeDist();
    const { server, calls } = patchServer({ decline: "too-large" });
    const logs: Array<string> = [];

    await publish({ ...options(dist, server), report: (event) => logs.push(event.message) });

    expect(patchCalls(calls)).toHaveLength(1);
    expect(logs.some((line) => line.startsWith(`Server declined patch from ${short(sha(olderIosBundle))}: too-large`))).toBe(true);
    expect(logs).toContain("Delta patches: 0 uploaded, 1 skipped, 0 failed");
  });

  it("does not download bases for a bundle above the server's size limit", async () => {
    const dist = await makeDist();
    const { server, calls } = patchServer({ maxBundleBytes: 4 });
    const logs: Array<string> = [];

    await publish({ ...options(dist, server), report: (event) => logs.push(event.message) });

    expect(calls.some((call) => new URL(call.url).pathname.startsWith("/assets/"))).toBe(false);
    expect(logs).toContain(`ios: bundle is ${iosBundle.length} bytes, above the server's 4-byte patch limit`);
  });

  it("skips patching entirely with --no-patches", async () => {
    const dist = await makeDist();
    const { server, calls } = patchServer();

    await publish({ ...options(dist, server), noPatches: true });

    expect(calls.some((call) => call.url.includes("/patch-bases"))).toBe(false);
    expect(patchCalls(calls)).toHaveLength(0);
  });
});

describe("register-embedded", () => {
  it("uploads the build's bundle if needed and registers it under the build's update id", async () => {
    const dist = await makeDist();
    const id = "1B4E28BA-2FA1-11D2-883F-B9A761BDE3FB";
    const manifestPath = path.join(dist, "app.manifest");
    await writeFile(manifestPath, JSON.stringify({ id, assets: [] }));
    const { server, calls } = makeServer([sha(iosBundle)]);

    const result = await registerEmbedded({
      projectDir: dist,
      platform: "ios",
      manifestPath,
      bundlePath: path.join(dist, "_expo/static/js/ios/index.hbc"),
      runtimeVersion: undefined,
      server,
      run: fakeRun,
      report: () => {},
    });

    expect(result).toEqual({ updateId: id.toLowerCase(), platform: "ios", runtimeVersion: "rt-ios", hash: sha(iosBundle) });
    expect(calls.map((call) => [call.method, new URL(call.url).pathname])).toEqual([
      ["POST", "/publish/assets/missing"],
      ["PUT", `/publish/assets/${sha(iosBundle)}`],
      ["POST", "/publish/embedded"],
    ]);
    expect(JSON.parse(calls[2]!.body)).toEqual({
      updateId: id,
      platform: "ios",
      runtimeVersion: "rt-ios",
      launchAsset: { hash: sha(iosBundle), key: md5(iosBundle), contentType: "application/javascript", fileExtension: ".bundle" },
    });
  });

  it("takes the runtime from the flag before asking the project", async () => {
    const dist = await makeDist();
    const manifestPath = path.join(dist, "app.manifest");
    await writeFile(manifestPath, JSON.stringify({ id: crypto.randomUUID() }));
    const { server, calls } = makeServer([]);
    const runs: Array<string> = [];

    const result = await registerEmbedded({
      projectDir: dist,
      platform: "android",
      manifestPath,
      bundlePath: path.join(dist, "_expo/static/js/android/index.hbc"),
      runtimeVersion: "1.2.3",
      server,
      run: (command, args, cwd) => {
        runs.push(args.join(" "));
        return fakeRun(command, args, cwd);
      },
      report: () => {},
    });

    expect(result.runtimeVersion).toBe("1.2.3");
    expect(runs).toEqual([]);
    expect(calls.map((call) => call.method)).toEqual(["POST", "POST"]);
  });

  it("explains a manifest that is not an embedded update manifest", async () => {
    const dist = await makeDist();
    const manifestPath = path.join(dist, "app.manifest");
    await writeFile(manifestPath, JSON.stringify({ hello: "world" }));
    const { server } = makeServer([]);
    await expect(
      registerEmbedded({
        projectDir: dist,
        platform: "ios",
        manifestPath,
        bundlePath: path.join(dist, "_expo/static/js/ios/index.hbc"),
        runtimeVersion: undefined,
        server,
        run: fakeRun,
        report: () => {},
      }),
    ).rejects.toThrow("Point --manifest at the app.manifest");
  });
});

describe("patches command", () => {
  it("backfills only the bases the newest bundle is still missing", async () => {
    const dist = await makeDist();
    const embeddedBundle = "embedded ios bundle bytes";
    const { server, calls } = makeServer([], {
      bundles: { ios: [{ updateId: "ios-new", hash: sha(iosBundle) }], android: [] },
      bases: {
        ios: [
          { hash: sha(olderIosBundle), source: "fleet", updateId: "ios-old", devices: 2 },
          { hash: sha(embeddedBundle), source: "embedded", updateId: "build", devices: 0 },
        ],
      },
      covered: [sha(olderIosBundle)],
      contents: { [sha(iosBundle)]: iosBundle, [sha(olderIosBundle)]: olderIosBundle, [sha(embeddedBundle)]: embeddedBundle },
    });
    const logs: Array<string> = [];

    const result = await backfillPatches({
      branch: "staging",
      platforms: ["ios", "android"],
      projectDir: dist,
      server,
      run: fakeRun,
      report: (event) => logs.push(event.message),
    });

    expect(result).toEqual({
      uploaded: 1,
      skipped: 0,
      failed: 0,
      targets: [{ platform: "ios", runtimeVersion: "rt-ios", hash: sha(iosBundle) }],
    });
    expect(calls.filter((call) => call.url.includes("/admin/updates/")).map((call) => call.url)).toEqual([
      "https://ota.test/admin/updates/ios-new/patches",
    ]);
    expect(calls.filter((call) => call.url.includes("/publish/patches/")).map((call) => call.url)).toEqual([
      `https://ota.test/publish/patches/${sha(embeddedBundle)}/${sha(iosBundle)}`,
    ]);
    expect(logs).toContain("android: nothing published on staging for runtime rt-android");
  });
});
