import { describe, expect, it } from "vitest";
import { NodeServices } from "@effect/platform-node";
import { ConfigProvider, Console, Effect, Redacted } from "effect";
import { Command } from "effect/unstable/cli";
import { makeCommand, type CommandInput } from "./commands.ts";

const parseCommand = async (args: Array<string>, env: NodeJS.ProcessEnv) => {
  let input: CommandInput | undefined;
  const logs: Array<string> = [];
  const errors: Array<string> = [];
  const command = makeCommand((value) =>
    Effect.sync(() => {
      input = value;
    }),
  );
  const result = await Effect.runPromise(
    Command.runWith(command, { version: "0.1.1" })(args).pipe(
      Effect.result,
      Effect.provideService(Console.Console, {
        ...console,
        log: (...args) => {
          logs.push(args.join(" "));
        },
        error: (...args) => {
          errors.push(args.join(" "));
        },
      }),
      Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env))),
      Effect.provide(NodeServices.layer),
    ),
  );
  if (result._tag === "Failure") throw new Error(errors.join("\n"));
  return input ?? { kind: "help" as const, text: logs.join("\n") };
};

const env = { OTA_URL: "https://ota.test", OTA_PUBLISH_TOKEN: "secret" };

describe("command validation", () => {
  it.each([["--rollout", "10"], ["--dist", "build"], ["--skip-export"], ["--no-patches"]])(
    "rejects publish-only flag %s on rollback",
    async (...flags) => {
      await expect(parseCommand(["rollback-to-embedded", "--branch", "staging", ...flags], env)).rejects.toThrow(
        "Unrecognized flag",
      );
    },
  );

  it("rejects unexpected positional arguments", async () => {
    await expect(parseCommand(["publish", "oops", "--branch", "staging"], env)).rejects.toThrow("Unexpected");
  });

  it.each(["", " ", "1.5", "1e2", "-1", "101"])("rejects ambiguous or invalid rollout %j", async (rollout) => {
    await expect(parseCommand(["publish", "--branch", "staging", `--rollout=${rollout}`], env)).rejects.toThrow(
      "whole number",
    );
  });

  it.each(["0", "10", "100"])("accepts rollout %s", async (rollout) => {
    expect(await parseCommand(["publish", "--branch", "staging", "--rollout", rollout], env)).toMatchObject({
      rolloutPercent: Number(rollout),
    });
  });

  it("shows rollback-specific help without requiring credentials", async () => {
    const result = await parseCommand(["rollback-to-embedded", "--help"], {});
    expect("kind" in result ? result.kind : undefined).toBe("help");
    if (!("kind" in result)) throw new Error("Expected help");
    expect(result.text).not.toContain("--rollout");
    expect(result.text).not.toContain("--skip-export");
    expect(result.text).toContain("Other runtime versions are unaffected");
  });

  it("keeps credentials optional for version and names the missing setting", async () => {
    expect(await parseCommand(["--version"], {})).toMatchObject({ text: expect.stringContaining("0.1.1") });
    await expect(parseCommand(["publish", "--branch", "staging"], {})).rejects.toThrow("--server");
    await expect(parseCommand(["publish", "--branch", "staging"], { OTA_URL: env.OTA_URL })).rejects.toThrow("--token");
  });

  it("uses environment credentials and keeps omitted boolean flags false", async () => {
    expect(await parseCommand(["publish", "--branch", "staging"], env)).toMatchObject({
      command: "publish",
      url: env.OTA_URL,
      token: Redacted.make(env.OTA_PUBLISH_TOKEN),
      platforms: ["ios", "android"],
      verbose: false,
      json: false,
      skipExport: false,
      noPatches: false,
    });
  });

  it("generates completions without dispatching a publish", async () => {
    const result = await parseCommand(["--completions", "bash"], {});
    expect(result).toMatchObject({ kind: "help", text: expect.stringContaining("rollback-to-embedded") });
  });

  it("preserves flag precedence and deduplicates platforms", async () => {
    expect(
      await parseCommand(
        [
          "publish",
          "--branch",
          "staging",
          "--server",
          "https://other.test/",
          "--token",
          "override",
          "--platform",
          "ios",
          "--platform",
          "ios",
        ],
        env,
      ),
    ).toMatchObject({ url: "https://other.test", token: Redacted.make("override"), platforms: ["ios"] });
  });

  it.each(["invalid", "ftp://ota.test", "https://ota.test/manifest", "https://user:pass@ota.test"])(
    "rejects invalid origin %s",
    async (url) => {
      await expect(parseCommand(["publish", "--branch", "staging", "--server", url], env)).rejects.toThrow(/origin/);
    },
  );
});
