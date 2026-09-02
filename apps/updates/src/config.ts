import * as Alchemy from "alchemy";
import { Config, Effect, Option } from "effect";

const optional = (name: string) => Config.option(Config.string(name)).pipe(Effect.map(Option.getOrUndefined));
const list = (value: string | undefined) => (value ?? "").split(",").map((s) => s.trim()).filter(Boolean);

// Deploy-time settings from the environment. Domains are optional: without
// them the Workers keep their workers.dev URLs, and a dev stage never binds
// them, so one .env serves every stage. The dashboard allow-list is required
// on every stage that is not a dev one, so it never deploys open.
export const Origins = Effect.gen(function* () {
  const { stage } = yield* Alchemy.Stack;
  const dev = stage.startsWith("dev_");
  const updatesDomain = dev ? undefined : yield* optional("OTA_UPDATES_DOMAIN");
  const dashboardDomain = dev ? undefined : yield* optional("OTA_DASHBOARD_DOMAIN");
  const emailDomains = list(yield* optional("OTA_ACCESS_EMAIL_DOMAINS"));
  const emails = list(yield* optional("OTA_ACCESS_EMAILS"));
  const accessInclude = [
    ...emailDomains.map((emailDomain) => ({ emailDomain })),
    ...emails.map((email) => ({ email })),
  ];
  return { stage, updatesDomain, dashboardDomain, accessInclude };
});

export const assertProtectedStage = (stage: string, accessInclude: readonly { emailDomain?: string; email?: string }[]) =>
  Effect.gen(function* () {
    const dev = stage.startsWith("dev_");
    if (!dev && accessInclude.length === 0) {
      return yield* Effect.die(new Error(
        `Stage "${stage}" needs OTA_ACCESS_EMAIL_DOMAINS or OTA_ACCESS_EMAILS so the dashboard deploys behind Cloudflare Access.`,
      ));
    }
  });
