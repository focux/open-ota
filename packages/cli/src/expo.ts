import { Config, Context, Effect, Layer, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { CliFailure, ProcessFailure } from "./errors.ts";
import { Progress } from "./output.ts";

export type Platform = "ios" | "android";

export class Processes extends Context.Service<
  Processes,
  {
    run(command: string, args: ReadonlyArray<string>, cwd: string): Effect.Effect<string, ProcessFailure>;
  }
>()("cli/Processes") {
  static readonly layer = Layer.effect(
    Processes,
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const progress = yield* Progress;
      return Processes.of({
        run: Effect.fn("processes.run")(function* (command, args, cwd) {
          return yield* Effect.gen(function* () {
            const child = yield* spawner.spawn(ChildProcess.make(command, args, { cwd }));
            let stderr = "";
            const [stdout, , code] = yield* Effect.all(
              [
                child.stdout.pipe(
                  Stream.decodeText(),
                  Stream.tap((message) => progress.report({ type: "detail", message })),
                  Stream.runFoldEffect(
                    () => "",
                    (text, chunk) =>
                      text.length + chunk.length > 64 * 1024 * 1024
                        ? Effect.fail(
                            new ProcessFailure({
                              command,
                              missing: false,
                              message: `${command} output exceeded 64 MiB. Run the command directly to diagnose.`,
                            }),
                          )
                        : Effect.succeed(text + chunk),
                  ),
                ),
                child.stderr.pipe(
                  Stream.decodeText(),
                  Stream.runForEach((message) =>
                    Effect.gen(function* () {
                      stderr = (stderr + message).slice(-4000);
                      yield* progress.report({ type: "detail", message });
                    }),
                  ),
                ),
                child.exitCode,
              ],
              { concurrency: "unbounded" },
            );
            if (code !== 0) {
              return yield* new ProcessFailure({
                command,
                missing: false,
                message: `${command} ${args.join(" ")} exited with code ${code}. Run it in ${cwd} to diagnose. ${(stderr || stdout).trim().slice(-4000)}`,
              });
            }
            return stdout;
          }).pipe(
            Effect.scoped,
            Effect.mapError((cause) =>
              cause._tag === "ProcessFailure"
                ? cause
                : new ProcessFailure({
                    command,
                    missing: cause.reason._tag === "NotFound",
                    message: cause.message,
                    cause,
                  }),
            ),
          );
        }),
      });
    }),
  );
}

export const exportProject = Effect.fn("expo.exportProject")(function* (
  projectDir: string,
  distDir: string,
  platforms: ReadonlyArray<Platform>,
) {
  const processes = yield* Processes;
  yield* processes.run(
    "npx",
    ["expo", "export", ...platforms.flatMap((platform) => ["--platform", platform]), "--output-dir", distDir],
    projectDir,
  );
});

export const publicConfig = Effect.fn("expo.publicConfig")(function* (projectDir: string) {
  const processes = yield* Processes;
  const stdout = yield* processes.run("npx", ["expo", "config", "--type", "public", "--json"], projectDir);
  const json = stdout.slice(stdout.indexOf("{"), stdout.lastIndexOf("}") + 1);
  return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)))(
    json,
  ).pipe(
    Effect.mapError(
      (cause) =>
        new CliFailure({
          message: "Could not read public Expo configuration. Run npx expo config --type public --json to diagnose.",
          cause,
        }),
    ),
  );
});

export const resolveRuntimeVersion = Effect.fn("expo.resolveRuntimeVersion")(function* (
  projectDir: string,
  platform: Platform,
) {
  const processes = yield* Processes;
  const stdout = yield* processes.run(
    "npx",
    ["--no-install", "expo-updates", "runtimeversion:resolve", "--platform", platform],
    projectDir,
  );
  const last =
    stdout
      .split("\n")
      .filter((line) => line.trim() !== "")
      .at(-1) ?? "";
  const parsed = yield* Schema.decodeUnknownEffect(
    Schema.fromJsonString(Schema.Struct({ runtimeVersion: Schema.String })),
  )(last).pipe(
    Effect.mapError(
      (cause) =>
        new CliFailure({
          message: `Could not resolve the ${platform} runtime version. Run npx expo-updates runtimeversion:resolve --platform ${platform} to diagnose.`,
          cause,
        }),
    ),
  );
  return parsed.runtimeVersion;
});

export const gitCommit = Effect.fn("expo.gitCommit")(function* (projectDir: string) {
  const processes = yield* Processes;
  return yield* processes.run("git", ["rev-parse", "HEAD"], projectDir).pipe(
    Effect.map((text) => text.trim() || undefined),
    Effect.catchTag("ProcessFailure", () => Effect.succeed(undefined)),
  );
});

export const actor = Effect.fn("expo.actor")(function* (projectDir: string) {
  const fromEnv = yield* Config.string("OTA_ACTOR").pipe(Config.withDefault(""));
  if (fromEnv) return fromEnv;
  const processes = yield* Processes;
  return yield* processes.run("git", ["log", "-1", "--format=%ae"], projectDir).pipe(
    Effect.map((text) => text.trim() || undefined),
    Effect.catchTag("ProcessFailure", () => Effect.succeed(undefined)),
  );
});
