import type { RuntimeContext } from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import type { AnalyticsEngine } from "alchemy/Cloudflare";
import { Context, Effect, Layer } from "effect";

// Time series live in Analytics Engine; the exact per-device state lives in D1.
export const MetricsDataset = Cloudflare.AnalyticsEngine.Dataset("Metrics");

export interface CheckEvent {
  readonly event: "check";
  readonly clientId: string | undefined;
  readonly platform: string;
  readonly runtimeVersion: string;
  readonly channel: string;
  readonly currentUpdateId: string | undefined;
  readonly servedUpdateId: string | undefined;
  readonly outcome: "manifest" | "rollback" | "none";
  readonly country: string | undefined;
  readonly city: string | undefined;
}

export interface AssetEvent {
  readonly event: "asset";
  readonly clientId: string | undefined;
  readonly hash: string;
  readonly outcome: "full" | "patch";
}

export type MetricEvent = CheckEvent | AssetEvent;

export interface MetricsShape {
  readonly record: (event: MetricEvent) => Effect.Effect<void, never, RuntimeContext>;
}

export class Metrics extends Context.Service<Metrics, MetricsShape>()("expo-ota/Metrics") {
  static readonly analyticsEngine = (dataset: AnalyticsEngine.DatasetClient) =>
    Layer.succeed(Metrics, {
      record: Effect.fn("Metrics.record")((event: MetricEvent) =>
        dataset
          .writeDataPoint({
            indexes: [event.clientId ?? ""],
            blobs:
              event.event === "check"
                ? [
                    event.event,
                    event.platform,
                    event.runtimeVersion,
                    event.channel,
                    event.currentUpdateId ?? "",
                    event.servedUpdateId ?? "",
                    event.outcome,
                    event.country ?? "",
                    event.city ?? "",
                  ]
                : [event.event, event.hash, event.outcome],
            doubles: [1],
          })
          .pipe(Effect.catch((error) => Effect.logWarning("Metric dropped", { cause: error }))),
      ),
    });

  static readonly memory = (events: Array<MetricEvent> = []) =>
    Layer.succeed(Metrics, { record: (event) => Effect.sync(() => void events.push(event)) });
}
