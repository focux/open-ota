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
    Flag.withDescription("Publish without delta patches; `open-ota patches` can add them later"),
  ),
};
const buildFlags = {
  url: common.url,
  token: common.token,
  project: common.project,
  verbose: common.verbose,
  json: common.json,
  platform: Flag.choice("platform", ["ios", "android"]).pipe(Flag.withDescription("Platform of the build")),
  profile: Flag.string("profile").pipe(
    Flag.withSchema(Schema.String.check(Schema.isPattern(/\S/, { message: "Profile must not be empty" }))),
    Flag.withDescription("EAS build profile"),
  ),
  distribution: Flag.choice("distribution", ["store", "internal", "simulator"]).pipe(
    Flag.withDefault("store"),
    Flag.withDescription("Build distribution; defaults to store"),
  ),
  channel: Flag.string("channel").pipe(
    Flag.withSchema(Schema.String.check(Schema.isPattern(/\S/, { message: "Channel must not be empty" }))),
    Flag.withDescription("Update channel configured in the build"),
    Flag.optional,
    Flag.map(Option.getOrUndefined),
  ),
  runtime: Flag.string("runtime").pipe(
    Flag.withDescription("Runtime version; defaults to resolving it from the project"),
    Flag.optional,
    Flag.map(Option.getOrUndefined),
  ),
};
const buildGetFlags = {
  ...buildFlags,
  includeInactive: Flag.boolean("include-inactive").pipe(
    Flag.withDefault(false),
    Flag.withDescription("Also match deactivated builds"),
  ),
};
const buildIdFlags = {
  url: common.url,
  token: common.token,
  project: common.project,
  verbose: common.verbose,
  json: common.json,
  id: Flag.string("id").pipe(
    Flag.withSchema(Schema.String.check(Schema.isPattern(/\S/, { message: "Build id must not be empty" }))),
    Flag.withDescription("Id of a registered build, as returned by build register or build get"),
  ),
};
const buildRegisterFlags = {
  ...buildFlags,
  manifest: Flag.string("manifest").pipe(
    Flag.withDescription("Path to the app.manifest expo-updates generated for the build"),
  ),
  bundle: Flag.string("bundle").pipe(Flag.withDescription("Path to the JS bundle embedded in the build")),
};
const patchesFlags = {
  branch: common.branch,
  platforms: common.platforms,
  project: common.project,
  url: common.url,
  token: common.token,
  verbose: common.verbose,
  json: common.json,
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
  | (FlagValues<typeof initFlags> & { command: "init" })
  | (FlagValues<typeof buildRegisterFlags> & { command: "build-register" })
  | (FlagValues<typeof buildGetFlags> & { command: "build-get" })
  | (FlagValues<typeof buildIdFlags> & { command: "build-activate" })
  | (FlagValues<typeof buildIdFlags> & { command: "build-deactivate" })
  | (FlagValues<typeof patchesFlags> & { command: "patches" });

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
  const buildRegister = Command.make(
    "register",
    buildRegisterFlags,
    Effect.fn("cli.build.register")(function* (input) {
      yield* handle({ ...input, command: "build-register" });
    }),
  ).pipe(
    Command.withDescription(
      "Register a native build for compatibility checks and fresh-install delta patches",
    ),
    Command.withExamples([
      {
        command:
          "open-ota build register --platform ios --profile production --manifest build/YourApp.app/app.manifest --bundle build/YourApp.app/main.jsbundle",
        description: "Register a submitted iOS production build",
      },
    ]),
  );
  const buildGet = Command.make(
    "get",
    buildGetFlags,
    Effect.fn("cli.build.get")(function* (input) {
      yield* handle({ ...input, command: "build-get" });
    }),
  ).pipe(
    Command.withDescription("Find a compatible registered build"),
    Command.withExamples([
      {
        command: "open-ota build get --platform ios --profile production --json",
        description: "Find an iOS production build for the current runtime",
      },
    ]),
  );
  const buildActivate = Command.make(
    "activate",
    buildIdFlags,
    Effect.fn("cli.build.activate")(function* (input) {
      yield* handle({ ...input, command: "build-activate" });
    }),
  ).pipe(Command.withDescription("Make a deactivated build eligible again; safe to repeat"));
  const buildDeactivate = Command.make(
    "deactivate",
    buildIdFlags,
    Effect.fn("cli.build.deactivate")(function* (input) {
      yield* handle({ ...input, command: "build-deactivate" });
    }),
  ).pipe(
    Command.withDescription(
      "Stop a build from counting as OTA-eligible without deleting it or its embedded bundle; safe to repeat",
    ),
    Command.withExamples([
      {
        command: "open-ota build deactivate --id 8f1c4d2e-0a5b-4c7d-9e3f-1a2b3c4d5e6f",
        description: "A store submission was rejected or the build was pulled",
      },
    ]),
  );
  const build = Command.make("build").pipe(
    Command.withDescription("Register, find, and manage native builds"),
    Command.withSubcommands([buildRegister, buildGet, buildActivate, buildDeactivate]),
  );
  const patches = Command.make(
    "patches",
    patchesFlags,
    Effect.fn("cli.patches")(function* (input) {
      yield* handle({ ...input, command: "patches" });
    }),
  ).pipe(
    Command.withDescription(
      "Compute the delta patches the newest bundle on a branch is missing, for bases the server reports: devices in the field, registered builds, recent publishes",
    ),
    Command.withExamples([
      { command: "open-ota patches --branch production", description: "Backfill patches after registering a build" },
    ]),
  );
  return Command.make("open-ota").pipe(
    Command.withDescription("Publish Expo updates to a self-hosted Open OTA server"),
    Command.withSubcommands([publish, rollback, doctor, init, build, patches]),
  );
};
