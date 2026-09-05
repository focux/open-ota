import * as Cloudflare from "alchemy/Cloudflare";
import * as SQL from "alchemy/SQL/D1";
import { Config, ConfigProvider, Effect, Layer, Option, Redacted } from "effect";
import { HttpRouter } from "effect/unstable/http";
import { adminRoutes } from "./admin.ts";
import { AssetStore } from "./assets.ts";
import { Assets } from "./bucket.ts";
import { Origins } from "./config.ts";
import { Database } from "./database.ts";
import { Metrics, MetricsDataset } from "./metrics.ts";
import { noStoreByDefault } from "./http.ts";
import { PublishAuth, routes } from "./routes.ts";
import { Signer } from "./signing.ts";
import { UpdateStore } from "./store.ts";

export default class Updates extends Cloudflare.Worker<Updates>()(
  "Updates",
  Effect.gen(function* () {
    const { updatesDomain } = yield* Origins;
    const accessEmailDomains = yield* Config.option(
      Config.string("OTA_ACCESS_EMAIL_DOMAINS"),
    ).pipe(Effect.map(Option.getOrUndefined));
    const accessEmails = yield* Config.option(Config.string("OTA_ACCESS_EMAILS")).pipe(
      Effect.map(Option.getOrUndefined),
    );
    return {
      main: import.meta.url,
      compatibility: { date: "2026-07-01" },
      observability: { enabled: true },
      ...(accessEmailDomains === undefined
        ? {}
        : { OTA_ACCESS_EMAIL_DOMAINS: accessEmailDomains }),
      ...(accessEmails === undefined ? {} : { OTA_ACCESS_EMAILS: accessEmails }),
      ...(updatesDomain === undefined ? {} : { domain: updatesDomain }),
    };
  }),
  Effect.gen(function* () {
    const d1 = yield* Cloudflare.D1.QueryDatabase(Database);
    const bucket = yield* Cloudflare.R2.ReadWriteBucket(Assets);
    const dataset = yield* Cloudflare.AnalyticsEngine.WriteDataset(MetricsDataset);
    // Assets are content-addressed and immutable, so the cache survives deploys.
    yield* Cloudflare.Workers.cache({ enabled: true, crossVersionCache: true });
    const signingKey = yield* Config.redacted("OTA_SIGNING_KEY");
    const publishToken = yield* Config.redacted("OTA_PUBLISH_TOKEN");
    const signer = yield* Signer.pipe(
      Effect.provide(Signer.fromPem(Redacted.value(signingKey), "main")),
      Effect.mapError((cause) => new Config.ConfigError(new ConfigProvider.SourceError({
        message: "OTA_SIGNING_KEY is not a valid RSA private key.", cause,
      }))),
    );

    const services = Layer.mergeAll(
      UpdateStore.layer.pipe(Layer.provide(SQL.D1Layer(d1))),
      AssetStore.r2(bucket),
      Metrics.analyticsEngine(dataset),
      Layer.succeed(Signer, signer),
      Layer.succeed(PublishAuth, { token: Redacted.value(publishToken) }),
    );
    const app = Layer.mergeAll(routes, adminRoutes).pipe(Layer.provide(noStoreByDefault), Layer.provide(services));

    return {
      fetch: Effect.scoped(HttpRouter.toHttpEffect(app).pipe(Effect.flatMap((handle) => handle))),
    };
  }).pipe(
    Effect.provide([
      Cloudflare.D1.QueryDatabaseBinding,
      Cloudflare.R2.ReadWriteBucketBinding,
      Cloudflare.AnalyticsEngine.WriteDatasetBinding,
    ]),
  ),
) {}
