import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { sign } from "node:crypto";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";

const exec = promisify(execFile);
const cli = fileURLToPath(new URL("./cli.ts", import.meta.url));
const certificate = fileURLToPath(new URL("./fixtures/test-certificate.pem", import.meta.url));
const key = readFileSync(new URL("../../../apps/updates/src/fixtures/test-private-key.pem", import.meta.url));
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

const fixture = async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ota-setup-"));
  const state = { authorized: true, validSignature: true, activeRollout: false };
  const requests: string[] = [];
  const server = createServer((req, res) => {
    requests.push(req.url!);
    req.resume();
    if (!state.authorized) {
      res.writeHead(401);
      res.end();
      return;
    }
    if (req.url === "/manifest") {
      expect(req.headers["eas-client-id"]).toBeUndefined();
      const payload = JSON.stringify({ type: "noUpdateAvailable" });
      const signature = sign(
        "RSA-SHA256",
        Buffer.from(state.validSignature ? payload : "different payload"),
        key,
      ).toString("base64");
      res.setHeader("content-type", 'multipart/mixed; boundary="probe"');
      res.end(
        `--probe\r\ncontent-disposition: form-data; name="directive"\r\nexpo-signature: sig="${signature}", keyid="main"\r\n\r\n${payload}\r\n--probe--\r\n`,
      );
      return;
    }
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify(
        req.url === "/admin/overview"
          ? {
              channels: [{ name: "staging", branch: "staging" }],
              latest: state.activeRollout
                ? [{ branch: "staging", platform: "ios", runtimeVersion: "runtime-ios", rolloutPercent: 10 }]
                : [],
            }
          : { runtimes: [] },
      ),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing server port");
  const url = `http://127.0.0.1:${address.port}`;
  const original = JSON.stringify(
    {
      expo: {
        name: "My app",
        slug: "my-app",
        ios: { bundleIdentifier: "com.test.app" },
        updates: { fallbackToCacheTimeout: 42, requestHeaders: { custom: "preserved" } },
      },
    },
    null,
    2,
  );
  await writeFile(path.join(dir, "app.json"), original);
  await writeFile(
    path.join(dir, "npx"),
    `#!${process.execPath}
const fs = require('node:fs');
fs.appendFileSync('commands.log', JSON.stringify(process.argv) + '\\n');
console.log(JSON.stringify(process.argv.includes('config') ? JSON.parse(fs.readFileSync('app.json', 'utf8')).expo : {runtimeVersion: 'runtime-ios'}));
`,
  );
  await chmod(path.join(dir, "npx"), 0o755);
  const run = (command: string, extra: string[] = []) =>
    exec(
      process.execPath,
      [
        cli,
        command,
        "--project",
        dir,
        "--server",
        url,
        "--token",
        "test-secret",
        "--platform",
        "ios",
        "--json",
        ...extra,
      ],
      { env: { ...process.env, PATH: `${dir}${path.delimiter}${process.env.PATH}`, CI: "1" } },
    );
  const init = () => run("init", ["--channel", "staging", "--certificate", certificate]);
  return { dir, state, requests, original, run, init };
};

it("configures static apps with a backup, preserves unrelated fields and supports reruns", async () => {
  const f = await fixture();
  const { stdout, stderr } = await f.init();
  expect(JSON.parse(stdout)).toMatchObject({
    mode: "configured",
    checks: { channel: "staging", runtimes: [{ platform: "ios", devices: 0, outcome: "no-update" }] },
  });
  expect(stderr).toContain("No ios devices observed");
  expect(await readFile(path.join(f.dir, "app.json.open-ota.bak"), "utf8")).toBe(f.original);
  expect(JSON.parse(await readFile(path.join(f.dir, "app.json"), "utf8"))).toMatchObject({
    expo: {
      name: "My app",
      ios: { bundleIdentifier: "com.test.app" },
      runtimeVersion: { policy: "fingerprint" },
      updates: { fallbackToCacheTimeout: 42, requestHeaders: { custom: "preserved", "expo-channel-name": "staging" } },
    },
  });
  expect(JSON.parse((await f.init()).stdout).mode).toBe("configured");
  expect(JSON.parse((await f.run("doctor")).stdout).runtimes[0].outcome).toBe("no-update");
  await expect(f.run("doctor", ["--channel", "production"])).rejects.toMatchObject({
    code: 1,
    stdout: "",
    stderr: expect.stringContaining("requested channel must match"),
  });
}, 15_000);

it("returns a snippet for dynamic config without changing app files", async () => {
  const f = await fixture();
  await writeFile(path.join(f.dir, "app.config.ts"), "export default ({config}) => config;\n");
  const { stdout } = await f.init();
  expect(JSON.parse(stdout)).toMatchObject({
    mode: "snippet",
    file: "app.config.ts",
    config: { runtimeVersion: { policy: "fingerprint" } },
  });
  expect(await readFile(path.join(f.dir, "app.json"), "utf8")).toBe(f.original);
  await expect(readFile(path.join(f.dir, "app.json.open-ota.bak"))).rejects.toMatchObject({ code: "ENOENT" });
});

it.each(["credentials", "signature"])("leaves config untouched when %s verification fails", async (failure) => {
  const f = await fixture();
  if (failure === "credentials") f.state.authorized = false;
  else f.state.validSignature = false;
  await expect(f.init()).rejects.toMatchObject({
    code: 1,
    stdout: "",
    stderr: expect.stringContaining(failure === "credentials" ? "Authentication failed" : "signature does not match"),
  });
  expect(await readFile(path.join(f.dir, "app.json"), "utf8")).toBe(f.original);
  await expect(readFile(path.join(f.dir, "app.json.open-ota.bak"))).rejects.toMatchObject({ code: "ENOENT" });
});

it("refuses to overwrite an existing backup", async () => {
  const f = await fixture();
  await writeFile(path.join(f.dir, "app.json.open-ota.bak"), "keep this");
  await expect(f.init()).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining("existing backup") });
  expect(await readFile(path.join(f.dir, "app.json.open-ota.bak"), "utf8")).toBe("keep this");
  expect(await readFile(path.join(f.dir, "app.json"), "utf8")).toBe(f.original);
});

it("blocks publishing before export when credentials or an active rollout fail preflight", async () => {
  const f = await fixture();
  await f.init();
  await writeFile(path.join(f.dir, "commands.log"), "");
  f.state.authorized = false;
  await expect(f.run("publish", ["--branch", "staging"])).rejects.toMatchObject({
    code: 1,
    stderr: expect.stringContaining("Authentication failed"),
  });
  f.state.authorized = true;
  f.state.activeRollout = true;
  await expect(f.run("publish", ["--branch", "staging"])).rejects.toMatchObject({
    code: 1,
    stderr: expect.stringContaining("active rollout exists"),
  });
  expect(await readFile(path.join(f.dir, "commands.log"), "utf8")).not.toContain('"export"');
  expect(f.requests.some((url) => url.startsWith("/publish/"))).toBe(false);
}, 15_000);
