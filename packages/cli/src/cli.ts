#!/usr/bin/env node
import path from "node:path";
import { parseArgs } from "node:util";
import { run, type Platform } from "./expo.ts";
import { publish, rollbackToEmbedded } from "./publish.ts";
import type { Server } from "./server.ts";

const usage = `open-ota - publish Expo updates to a self-hosted Expo OTA server

Usage:
  open-ota publish --branch <name> [options]
  open-ota rollback-to-embedded --branch <name> [options]

Commands:
  publish                Export the project and publish an update group.
  rollback-to-embedded   Publish a group that sends clients back to their embedded update.

Options:
  --branch <name>        Branch to publish to. Required.
  --message <text>       Message stored with the group.
  --rollout <0-100>      Percent of clients that get the update. Publish only.
  --platform <name>      ios or android. Repeatable. Defaults to both.
  --dist <dir>           Export output directory, relative to the project. Publish only. Defaults to dist.
  --skip-export          Reuse an existing export instead of running expo export. Publish only.
  --no-patches           Skip the bsdiff delta patches built after publishing. Publish only.
  --project <dir>        Expo project directory. Defaults to the working directory.
  --server <url>         Server origin. Overrides OTA_URL.
  --token <token>        Publish token. Overrides OTA_PUBLISH_TOKEN.
  -h, --help             Show this help.

Environment:
  OTA_URL                Server origin, for example https://u.example.com
  OTA_PUBLISH_TOKEN      Bearer token for the publish endpoints, the OTA_PUBLISH_TOKEN the server was deployed with.
  OTA_ACTOR              Who to credit the publish to. Defaults to the commit author.
`;

const main = async () => {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      branch: { type: "string" },
      message: { type: "string" },
      rollout: { type: "string" },
      platform: { type: "string", multiple: true },
      dist: { type: "string" },
      "skip-export": { type: "boolean" },
      "no-patches": { type: "boolean" },
      project: { type: "string" },
      server: { type: "string" },
      token: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });

  const command = positionals[0];
  if (values.help === true || command === undefined) {
    process.stdout.write(usage);
    return;
  }
  if (command !== "publish" && command !== "rollback-to-embedded") {
    throw new Error(`Unknown command "${command}". Run open-ota --help.`);
  }
  if (values.branch === undefined || values.branch === "") {
    throw new Error("--branch is required.");
  }

  const platforms: Array<Platform> = [];
  for (const platform of values.platform ?? []) {
    if (platform !== "ios" && platform !== "android") {
      throw new Error(`--platform must be ios or android, got "${platform}".`);
    }
    if (!platforms.includes(platform)) {
      platforms.push(platform);
    }
  }
  if (platforms.length === 0) {
    platforms.push("ios", "android");
  }

  let rolloutPercent: number | undefined;
  if (values.rollout !== undefined) {
    rolloutPercent = Number(values.rollout);
    if (!Number.isInteger(rolloutPercent) || rolloutPercent < 0 || rolloutPercent > 100) {
      throw new Error(`--rollout must be a whole number between 0 and 100, got "${values.rollout}".`);
    }
  }

  const url = values.server ?? process.env["OTA_URL"];
  const token = values.token ?? process.env["OTA_PUBLISH_TOKEN"];
  if (url === undefined || url === "" || token === undefined || token === "") {
    throw new Error("Set OTA_URL and OTA_PUBLISH_TOKEN, or pass --server and --token. Run open-ota --help.");
  }

  const server: Server = { url: url.replace(/\/+$/, ""), token, fetch };
  const projectDir = path.resolve(values.project ?? process.cwd());
  const common = {
    branch: values.branch,
    message: values.message,
    platforms,
    projectDir,
    server,
    run,
    log: (message: string) => process.stdout.write(`${message}\n`),
  };

  if (command === "rollback-to-embedded") {
    await rollbackToEmbedded(common);
    return;
  }
  await publish({
    ...common,
    rolloutPercent,
    distDir: path.resolve(projectDir, values.dist ?? "dist"),
    skipExport: values["skip-export"] === true,
    noPatches: values["no-patches"] === true,
  });
};

try {
  await main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
