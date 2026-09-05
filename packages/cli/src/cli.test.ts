import { sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const exec = promisify(execFile);
const cli = fileURLToPath(new URL("./cli.ts", import.meta.url));

it("keeps JSON stdout parseable through a real CLI publish against a local server", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ota-cli-process-"));
  const calls: Array<string> = [];
  const key = readFileSync(new URL("../../../apps/updates/src/fixtures/test-private-key.pem", import.meta.url));
  const payload = JSON.stringify({ type: "noUpdateAvailable" });
  const signature = sign("RSA-SHA256", Buffer.from(payload), key).toString("base64");
  const server = createServer((req, res) => {
    calls.push(req.url!);
    req.resume();
    if (req.url === "/manifest") {
      res.setHeader("content-type", "multipart/mixed; boundary=test");
      res.end(
        `--test\r\ncontent-disposition: form-data; name="directive"\r\nexpo-signature: sig="${signature}", keyid="main"\r\n\r\n${payload}\r\n--test--\r\n`,
      );
      return;
    }
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify(
        req.url === "/admin/overview"
          ? { channels: [{ name: "staging", branch: "staging" }], latest: [] }
          : req.url === "/admin/metrics"
            ? { runtimes: [] }
            : req.url === "/publish/assets/missing"
              ? { missing: [] }
              : {
                  groupId: "group-test",
                  updates: [{ id: "update-test", platform: "ios", runtimeVersion: "runtime-test" }],
                },
      ),
    );
  });
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected local server port");
    await mkdir(path.join(dir, "dist"));
    await writeFile(path.join(dir, "dist/bundle.js"), "bundle");
    await writeFile(
      path.join(dir, "dist/metadata.json"),
      JSON.stringify({ fileMetadata: { ios: { bundle: "bundle.js", assets: [] } } }),
    );
    const config = {
      slug: "test",
      updates: {
        url: `http://127.0.0.1:${address.port}/manifest`,
        codeSigningCertificate: fileURLToPath(new URL("./fixtures/test-certificate.pem", import.meta.url)),
        codeSigningMetadata: { keyid: "main", alg: "rsa-v1_5-sha256" },
        requestHeaders: { "expo-channel-name": "staging" },
      },
    };
    const npx = path.join(dir, "npx");
    await writeFile(
      npx,
      `#!${process.execPath}\nconsole.log(JSON.stringify(process.argv.includes('config') ? ${JSON.stringify(config)} : {runtimeVersion: 'runtime-test'}));\n`,
    );
    await chmod(npx, 0o755);
    const { stdout, stderr } = await exec(
      process.execPath,
      [
        cli,
        "publish",
        "--branch",
        "staging",
        "--platform",
        "ios",
        "--project",
        dir,
        "--server",
        `http://127.0.0.1:${address.port}`,
        "--token",
        "test-secret",
        "--rollout",
        "10",
        "--skip-export",
        "--no-patches",
        "--json",
      ],
      { env: { ...process.env, PATH: `${dir}${path.delimiter}${process.env.PATH}`, CI: "1" } },
    );
    expect(JSON.parse(stdout)).toMatchObject({
      command: "publish",
      branch: "staging",
      rolloutPercent: 10,
      groupId: "group-test",
    });
    expect(stderr).toContain("Reusing 1 asset");
    expect(stderr).toContain("Published group group-test");
    expect(stderr).not.toContain("test-secret");
    expect(stderr).not.toMatch(/[\r\x1b]/);
    expect(calls).toEqual([
      "/admin/overview",
      "/admin/metrics",
      "/manifest",
      "/publish/assets/missing",
      "/publish/groups",
    ]);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});

it("rejects rollback rollout flags with a nonzero exit before invoking Expo", async () => {
  await expect(
    exec(process.execPath, [cli, "rollback-to-embedded", "--branch", "staging", "--rollout", "10"], {
      env: { PATH: "", CI: "1" },
    }),
  ).rejects.toMatchObject({ code: 1, stdout: "", stderr: expect.stringContaining("Unrecognized flag: --rollout") });
});

it("shows root help on stdout with a successful exit when no command is given", async () => {
  const { stdout, stderr } = await exec(process.execPath, [cli], { env: { PATH: "", CI: "1" } });
  expect(stdout).toContain("SUBCOMMANDS");
  expect(stderr).toBe("");
});
