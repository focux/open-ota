import { Config, Effect, Option, Redacted, Schema } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import type { Platform } from "./expo.ts";

const common = {
  branch: Flag.string("branch").pipe(
    Flag.withSchema(Schema.String.check(Schema.isPattern(/\S/, { message: "Branch must not be empty" }))),
    Flag.withDescription("Branch to publish to"),
  ),
  message: Flag.string("message").pipe(
    Flag.withDescription("Message stored with the group"),
    Flag.optional,
    Flag.map(Option.getOrUndefined),
  ),
  platforms: Flag.choice("platform", ["ios", "android"]).pipe(
    Flag.withDescription("Repeat for each platform; defaults to both"),
    Flag.atLeast(0),
    Flag.map((platforms): Array<Platform> => (platforms.length ? [...new Set(platforms)] : ["ios", "android"])),
  ),
  project: Flag.string("project").pipe(
    Flag.withDescription("Expo project directory; defaults to the working directory"),
    Flag.optional,
    Flag.map(Option.getOrUndefined),
  ),
  url: Flag.string("server").pipe(
    Flag.withDescription("Server origin; overrides OTA_URL"),
    Flag.withFallbackConfig(Config.string("OTA_URL")),
    Flag.mapTryCatch(
      (value) => {
        const url = new URL(value);
        if (
          !["http:", "https:"].includes(url.protocol) ||
          url.username ||
          url.password ||
          url.search ||
          url.hash ||
          url.pathname !== "/"
        ) {
          throw new Error("Invalid origin");
        }
        return url.origin;
      },
      () => "Server must be an HTTP or HTTPS origin without credentials, a path, query, or fragment",
    ),
  ),
  token: Flag.redacted("token").pipe(
    Flag.withDescription("Publish token; overrides OTA_PUBLISH_TOKEN"),
    Flag.withFallbackConfig(Config.redacted("OTA_PUBLISH_TOKEN")),
    Flag.mapTryCatch(
      (value) => {
        const token = Redacted.value(value);
        if (!token.trim()) throw new Error("Empty token");
        return value;
      },
      () => "Publish token is empty. Set OTA_PUBLISH_TOKEN or pass --token",
    ),
  ),
  verbose: Flag.boolean("verbose").pipe(
    Flag.withDefault(false),
    Flag.withDescription("Stream subprocess output and show patch diagnostics"),
  ),
  json: Flag.boolean("json").pipe(Flag.withDefault(false), Flag.withDescription("Write the result as JSON to stdout")),
};

const publishFlags = {
  ...common,
  rolloutPercent: Flag.string("rollout").pipe(
    Flag.withDescription("Percentage of clients receiving this update (0-100); defaults to 100"),
    Flag.withSchema(
      Schema.String.check(
        Schema.makeFilter(
          (value) =>
            (/^\d+$/.test(value) && Number(value) <= 100) || "Rollout must be a whole number between 0 and 100",
        ),
      ),
    ),
    Flag.map(Number),
    Flag.optional,
    Flag.map(Option.getOrUndefined),
  ),
  dist: Flag.string("dist").pipe(
    Flag.withDescription("Export output directory, relative to the project"),
    Flag.withDefault("dist"),
  ),
  skipExport: Flag.boolean("skip-export").pipe(
    Flag.withDefault(false),
    Flag.withDescription("Reuse an existing export"),
  ),
  noPatches: Flag.boolean("no-patches").pipe(
    Flag.withDefault(false),
    Flag.withDescription("Skip optional delta patches after publishing"),
  ),
};

const connection = {
  url: common.url,
  token: common.token,
  project: common.project,
  platforms: common.platforms,
  verbose: common.verbose,
  json: common.json,
};
const doctorFlags = {
  ...connection,
  channel: Flag.string("channel").pipe(
    Flag.withDescription("Channel to check; defaults to the app configuration"),
    Flag.optional,
    Flag.map(Option.getOrUndefined),
  ),
};
const initFlags = {
  ...connection,
  channel: Flag.string("channel").pipe(
    Flag.withDescription("Existing server channel for this app"),
    Flag.withSchema(Schema.String.check(Schema.isPattern(/\S/))),
  ),
  certificate: Flag.string("certificate").pipe(
    Flag.withDescription("Path to the server's public signing certificate, relative to the app"),
    Flag.withDefault("./certs/certificate.pem"),
  ),
};

type FlagValues<T> = { [K in keyof T]: T[K] extends Flag.Flag<infer A> ? A : never };
export type CommandInput =
  | (FlagValues<typeof publishFlags> & { command: "publish" })
  | (FlagValues<typeof common> & { command: "rollback-to-embedded" })
  | (FlagValues<typeof doctorFlags> & { command: "doctor" })
  | (FlagValues<typeof initFlags> & { command: "init" });

export const makeCommand = <E, R>(handle: (input: CommandInput) => Effect.Effect<void, E, R>) => {
  const publish = Command.make(
    "publish",
    publishFlags,
    Effect.fn("cli.publish")(function* (input) {
      yield* handle({ ...input, command: "publish" });
    }),
  ).pipe(
    Command.withDescription(
      "Export the project and publish an update group. OTA_ACTOR overrides the commit author credited for the publish.",
    ),
    Command.withExamples([
      {
        command: 'open-ota publish --branch staging --message "Fix payment sheet"',
        description: "Publish both platforms to staging",
      },
    ]),
  );
  const rollback = Command.make(
    "rollback-to-embedded",
    common,
    Effect.fn("cli.rollbackToEmbedded")(function* (input) {
      yield* handle({ ...input, command: "rollback-to-embedded" });
    }),
  ).pipe(
    Command.withDescription(
      "Send matching platform/runtime builds back to their embedded update. Other runtime versions are unaffected. OTA_ACTOR overrides the commit author.",
    ),
    Command.withExamples([
      {
        command: "open-ota rollback-to-embedded --branch staging",
        description: "Roll back matching builds on staging",
      },
    ]),
  );
  const doctor = Command.make(
    "doctor",
    doctorFlags,
    Effect.fn("cli.doctor")(function* (input) {
      yield* handle({ ...input, command: "doctor" });
    }),
  ).pipe(Command.withDescription("Check configuration, channel mapping, credentials, runtimes and signed delivery"));
  const init = Command.make(
    "init",
    initFlags,
    Effect.fn("cli.init")(function* (input) {
      yield* handle({ ...input, command: "init" });
    }),
  ).pipe(
    Command.withDescription(
      "Configure app.json with a backup, or generate a snippet for dynamic config; requires expo-updates and the public signing certificate",
    ),
  );
  return Command.make("open-ota").pipe(
    Command.withDescription("Publish Expo updates to a self-hosted Open OTA server"),
    Command.withSubcommands([publish, rollback, doctor, init]),
  );
};
