import { instantiate } from "@open-ota/bsdiff";
import * as Cloudflare from "alchemy/Cloudflare";
import * as SQL from "alchemy/SQL/D1";
import { Config, ConfigProvider, Effect, Layer, Option, Redacted } from "effect";
import { HttpRouter } from "effect/unstable/http";
import { adminRoutes } from "./admin.ts";
import { AssetStore } from "./assets.ts";
import { Assets } from "./bucket.ts";
import { Origins } from "./config.ts";
import { Database } from "./database.ts";
import { CheckDebounce } from "./debounce.ts";
import { Delivery } from "./delivery.ts";
import { Retention, sweep } from "./gc.ts";
import { Metrics, MetricsDataset } from "./metrics.ts";
import { noStoreByDefault } from "./http.ts";
import { PatchEngine, PatchPolicy } from "./patching.ts";
import { PublishAuth, routes } from "./routes.ts";
import { Signer } from "./signing.ts";
import { UpdateStore } from "./store.ts";

const optionalString = (name: string) => Config.option(Config.string(name)).pipe(Effect.map(Option.getOrUndefined));

// A token scoped to reading analytics, and nothing else, for the dashboard's
// delivery counts.
const DeliveryToken = Effect.gen(function* () {
  const { accountId } = yield* yield* Cloudflare.CloudflareEnvironment;
  return yield* Cloudflare.ApiToken.AccountApiToken("DeliveryToken", {
    name: "open-ota delivery stats",
    accountId,
    policies: [
      {
        effect: "allow",
        permissionGroups: ["Account Analytics Read"],
        resources: { [`com.cloudflare.api.account.${accountId}`]: "*" },
      },
    ],
  });
});

export default class Updates extends Cloudflare.Worker<Updates>()(
  "Updates",
  Effect.gen(function* () {
    const { updatesDomain } = yield* Origins;
    const accessEmailDomains = yield* optionalString("OTA_ACCESS_EMAIL_DOMAINS");
    const accessEmails = yield* optionalString("OTA_ACCESS_EMAILS");
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
    const metricsDataset = yield* MetricsDataset;
    const dataset = yield* Cloudflare.AnalyticsEngine.WriteDataset(metricsDataset);
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

    // Patches: what the server accepts, and the engine that proves each one.
    // Deploying evaluates this module in Node to read the Worker's bindings,
    // where the `.wasm` module does not exist; it is only loaded inside the
    // bundle workerd runs, where the bundler ships it as a CompiledWasm module.
    const bsdiff = yield* Effect.promise(async () => {
      if (!(globalThis as { __ALCHEMY_RUNTIME__?: boolean }).__ALCHEMY_RUNTIME__) return undefined;
      const { default: module } = await import("@open-ota/bsdiff/bsdiff.wasm");
      return instantiate(module);
    });
    const policy = {
      maxRatio: yield* Config.number("OTA_PATCH_MAX_RATIO").pipe(Config.withDefault(PatchPolicy.defaults.maxRatio)),
      maxBundleBytes:
        (yield* Config.number("OTA_PATCH_MAX_BUNDLE_MB").pipe(Config.withDefault(PatchPolicy.defaults.maxBundleBytes / (1024 * 1024)))) *
        1024 *
        1024,
    };

    // Retention: what the nightly sweep keeps.
    const retention = {
      keepGroups: yield* Config.number("OTA_RETAIN_GROUPS").pipe(Config.withDefault(Retention.defaults.keepGroups)),
      keepDays: yield* Config.number("OTA_RETAIN_DAYS").pipe(Config.withDefault(Retention.defaults.keepDays)),
      deviceDays: yield* Config.number("OTA_RETAIN_DEVICE_DAYS").pipe(Config.withDefault(Retention.defaults.deviceDays)),
      uploadGraceHours: Retention.defaults.uploadGraceHours,
    };

    // Delivery numbers come from the Analytics Engine SQL API, which has no
    // Worker binding. The deploy mints an account token that can only read
    // analytics and binds it here. Deploying with a credential that cannot
    // create tokens is the reason to turn this off.
    const deliveryStats = (yield* optionalString("OTA_DELIVERY_STATS")) !== "off";
    const delivery = deliveryStats
      ? yield* Effect.gen(function* () {
          const token = yield* DeliveryToken;
          return Delivery.analyticsEngine({
            accountId: yield* token.accountId,
            token: yield* token.value,
            dataset: metricsDataset.dataset,
          });
        })
      : Delivery.disabled;

    const services = Layer.mergeAll(
      UpdateStore.layer.pipe(Layer.provide(SQL.D1Layer(d1))),
      AssetStore.r2(bucket),
      Metrics.analyticsEngine(dataset),
      Layer.succeed(Signer, signer),
      Layer.succeed(PublishAuth, { token: Redacted.value(publishToken) }),
      bsdiff === undefined ? PatchEngine.unavailable : PatchEngine.fromBsdiff(bsdiff),
      Layer.succeed(PatchPolicy, policy),
      Layer.succeed(Retention, retention),
      // No binding, no setup: an isolate-local memo in front of the colo's
      // own cache. Where neither answers, every check is written instead.
      typeof caches === "undefined" ? CheckDebounce.always : CheckDebounce.edge(caches.default),
      delivery,
    );
    const app = Layer.mergeAll(routes, adminRoutes).pipe(Layer.provide(noStoreByDefault), Layer.provide(services));

    // Nightly, off-peak: forget devices long gone, then drop bundles, assets
    // and patches nothing retained references.
    yield* Cloudflare.Workers.cron("17 3 * * *", () =>
      sweep().pipe(
        Effect.provide(services),
        Effect.catch((error) => Effect.logError("Sweep failed", { cause: error })),
      ),
    );

    return {
      fetch: Effect.scoped(HttpRouter.toHttpEffect(app).pipe(Effect.flatMap((handle) => handle))),
    };
  }).pipe(
    Effect.provide([
      Cloudflare.D1.QueryDatabaseBinding,
      Cloudflare.R2.ReadWriteBucketBinding,
      Cloudflare.AnalyticsEngine.WriteDatasetBinding,
      Cloudflare.Workers.CronEventSourceLive,
    ]),
  ),
) {}
