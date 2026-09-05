import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import { Config, Effect } from "effect";

// The project's marketing site. It is a stack of its own, separate from the
// root alchemy.run.ts: people self-hosting Open OTA deploy that one and never
// deploy this. Nothing here is shared with the updates Worker or the dashboard.
export default Alchemy.Stack(
  "OpenOtaSite",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const { stage } = yield* Alchemy.Stack;
    const domain = yield* Config.string("SITE_DOMAIN").pipe(
      Config.withDefault("openota.dev"),
    );
    const site = yield* Cloudflare.Website.Vite("Site", {
      compatibility: { date: "2026-07-01" },
      observability: { enabled: true },
      // Only these files affect the build, so an unchanged site skips both
      // the Vite build and the deploy.
      memo: {
        include: [
          "src/**",
          "public/**",
          "index.html",
          "package.json",
          "vite.config.ts",
        ],
      },
      // One page, so anything unmatched falls back to it rather than a 404.
      assets: { notFoundHandling: "single-page-application" },
      // A dev stage keeps its workers.dev URL and never touches the zone.
      ...(stage.startsWith("dev_")
        ? {}
        : { domain: { name: domain, redirects: [`www.${domain}`] } }),
    });
    return { siteUrl: site.url.as<string>() };
  }),
);
