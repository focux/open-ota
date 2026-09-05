#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Cause, Console, Effect, FileSystem, Layer, Redacted, Schema } from "effect";
import { Command } from "effect/unstable/cli";
import { FetchHttpClient } from "effect/unstable/http";
import { makeCommand, type CommandInput } from "./commands.ts";
import { doctor } from "./doctor.ts";
import { initialize } from "./setup.ts";
import { Processes } from "./expo.ts";
import { Progress } from "./output.ts";
import { publish, rollbackToEmbedded } from "./publish.ts";
import { Server } from "./server.ts";

const execute = Effect.fn("cli.execute")(function* (args: CommandInput) {
  const progress = yield* Progress;
  let publicationComplete = false;
  const reporter = Progress.of({
    ...progress,
    report: Effect.fn("cli.report")(function* (event) {
      if (event.type === "published") publicationComplete = true;
      yield* progress.report(event);
    }),
  });
  const workflow = Effect.gen(function* () {
    yield* progress.report({ type: "info", message: `open-ota ${args.command}` });
    yield* progress.report({ type: "info", message: `Server: ${args.url}` });
    const projectDir = path.resolve(args.project ?? process.cwd());
    if (args.command === "doctor") {
      const result = yield* doctor({ projectDir, url: args.url, channel: args.channel, platforms: args.platforms });
      if (args.json) yield* Console.log(JSON.stringify(result));
      return;
    }
    if (args.command === "init") {
      const result = yield* initialize({
        projectDir,
        url: args.url,
        channel: args.channel,
        certificate: args.certificate,
        platforms: args.platforms,
      });
      if (args.json) yield* Console.log(JSON.stringify(result));
      else if (result.mode === "snippet") yield* Console.log(JSON.stringify(result.config, null, 2));
      return;
    }
    if (args.command === "publish")
      yield* doctor({ projectDir, url: args.url, platforms: args.platforms, branch: args.branch });

    yield* progress.report({
      type: "info",
      message: `Branch: ${args.branch} | Platforms: ${args.platforms.join(", ")}${args.command === "publish" ? ` | Rollout: ${args.rolloutPercent ?? 100}%` : " | Target: embedded update for matching runtimes"}`,
    });
    const common = { branch: args.branch, message: args.message, platforms: args.platforms, projectDir };
    const published =
      args.command === "publish"
        ? yield* publish({
            ...common,
            rolloutPercent: args.rolloutPercent,
            distDir: path.resolve(projectDir, args.dist),
            skipExport: args.skipExport,
            noPatches: args.noPatches,
          })
        : yield* rollbackToEmbedded(common);
    yield* progress.close;
    if (args.json) {
      yield* Console.log(
        JSON.stringify({
          command: args.command,
          server: args.url,
          branch: args.branch,
          message: args.message ?? null,
          ...(args.command === "publish" && { rolloutPercent: args.rolloutPercent ?? 100 }),
          ...published,
        }),
      );
    } else {
      yield* progress.report({ type: "info", message: "" });
      yield* progress.report({
        type: "info",
        message:
          args.command === "publish"
            ? `Published to ${args.branch} | ${args.rolloutPercent ?? 100}% rollout`
            : `Rollback published to ${args.branch}. Matching builds will return to their embedded update when they check for updates.`,
      });
      yield* progress.report({ type: "info", message: `Server: ${args.url}` });
      yield* progress.report({ type: "info", message: `Group: ${published.groupId}` });
      if (args.message) yield* progress.report({ type: "info", message: `Message: ${args.message}` });
      for (const update of published.updates) {
        yield* progress.report({
          type: "info",
          message: `${update.platform}: ${update.id} | Runtime: ${update.runtimeVersion}`,
        });
      }
    }
  });
  yield* workflow.pipe(
    Effect.provideService(Progress, reporter),
    Effect.onInterrupt(() =>
      progress.fail(
        publicationComplete
          ? "Update was published. Optional delta patch preparation was cancelled."
          : "Cancelled. If publication was in progress, check the dashboard before retrying.",
      ),
    ),
    Effect.catch((error) =>
      Effect.gen(function* () {
        yield* progress.fail(error.message);
        if (args.command === "init")
          yield* progress.report({
            type: "info",
            message: "If app.json was updated, review its diff or restore app.json.open-ota.bak before retrying.",
          });
        if (args.verbose) yield* progress.report({ type: "detail", message: String(error.cause ?? error) });
        process.exitCode = 1;
      }),
    ),
  );
});

const handle = Effect.fn("cli.handle")((args: CommandInput) =>
  execute(args).pipe(
    Effect.provide(Layer.mergeAll(Processes.layer, Server.layer(args.url, args.token))),
    Effect.provide(
      Progress.layer({
        write: (text) => process.stderr.write(text.replaceAll(Redacted.value(args.token), "[redacted]")),
        interactive:
          process.stderr.isTTY === true &&
          !process.env["CI"] &&
          !args.verbose &&
          !args.json &&
          process.env["TERM"] !== "dumb",
        color: process.stderr.isTTY === true && process.env["NO_COLOR"] === undefined && process.env["TERM"] !== "dumb",
        verbose: args.verbose,
        columns: process.stderr.columns,
      }),
    ),
  ),
);

const main = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const pkg = yield* fs
    .readFileString(fileURLToPath(new URL("../package.json", import.meta.url)))
    .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Struct({ version: Schema.String })))));
  const console = yield* Console.Console;
  const messages: Array<string> = [];
  let invalid = false;
  yield* Command.run(
    makeCommand((args) => handle(args).pipe(Effect.provideService(Console.Console, console))),
    { version: pkg.version },
  ).pipe(
    Effect.provideService(Console.Console, {
      ...console,
      log: (...args) => {
        messages.push(args.join(" "));
      },
    }),
    Effect.catchTag("ShowHelp", (error) =>
      Effect.sync(() => {
        invalid = error.errors.length > 0;
        if (invalid) process.exitCode = 1;
      }),
    ),
    Effect.ensuring(
      Effect.sync(() => {
        for (const message of messages) {
          if (invalid) console.error(message);
          else console.log(message);
        }
      }),
    ),
  );
}).pipe(
  Effect.provide(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer)),
  Effect.catchCause((cause) =>
    Cause.hasInterruptsOnly(cause)
      ? Effect.failCause(cause)
      : Console.error(Cause.pretty(cause)).pipe(
          Effect.andThen(
            Effect.sync(() => {
              process.exitCode = 1;
            }),
          ),
        ),
  ),
);

NodeRuntime.runMain(main, { disableErrorReporting: true });
