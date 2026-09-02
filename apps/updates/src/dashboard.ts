import * as Cloudflare from "alchemy/Cloudflare";
import { Config, Effect, Option } from "effect";
import { Origins } from "./config.ts";
import Updates from "./worker.ts";

// The operator UI. Cloudflare Access is the only login; the Worker forwards
// /api/* to the updates Worker over the service binding with the bearer token.
export class Dashboard extends Cloudflare.Website.Vite<Dashboard>()(
  "Dashboard",
  Effect.gen(function* () {
    const { dashboardDomain, accessInclude } = yield* Origins;
    const publishToken = yield* Config.redacted("OTA_PUBLISH_TOKEN");
    const accessEmailDomains = yield* Config.option(
      Config.string("OTA_ACCESS_EMAIL_DOMAINS"),
    ).pipe(Effect.map(Option.getOrUndefined));
    const accessEmails = yield* Config.option(Config.string("OTA_ACCESS_EMAILS")).pipe(
      Effect.map(Option.getOrUndefined),
    );
    return {
      rootDir: "./apps/dashboard",
      compatibility: { date: "2026-07-01", flags: ["nodejs_compat"] },
      env: { UPDATES: Updates, OTA_PUBLISH_TOKEN: publishToken },
      ...(accessEmailDomains === undefined
        ? {}
        : { OTA_ACCESS_EMAIL_DOMAINS: accessEmailDomains }),
      ...(accessEmails === undefined ? {} : { OTA_ACCESS_EMAILS: accessEmails }),
      // A dev stage without an allow-list runs without Access locally.
      ...(accessInclude.length === 0
        ? {}
        : {
            access: { policies: [{ decision: "allow" as const, include: accessInclude }] },
            dev: { access: { aud: "dev", identity: { email: "dev@example.com" } } },
          }),
      ...(dashboardDomain === undefined ? {} : { domain: dashboardDomain }),
    };
  }).pipe(Effect.orDie),
) {}
