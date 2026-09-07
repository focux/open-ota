import type { RuntimeContext } from "alchemy";
import { Context, Effect, Layer, Redacted } from "effect";

// How an asset actually went out over the last `days`, from the asset events
// the Worker writes to Analytics Engine.
export interface AssetDelivery {
  readonly days: number;
  readonly full: number;
  readonly patch: number;
  readonly fullBytes: number;
  readonly patchBytes: number;
}

export class Delivery extends Context.Service<
  Delivery,
  // Null when the numbers are not available: the SQL API is not configured or
  // did not answer. Never a failure, because the rest of the page still is.
  { readonly assetDelivery: (hash: string, days: number) => Effect.Effect<AssetDelivery | null, never, RuntimeContext> }
>()("expo-ota/Delivery") {
  static readonly disabled = Layer.succeed(Delivery, { assetDelivery: () => Effect.succeed(null) });

  // Analytics Engine has no binding for reads; queries go through the SQL API
  // with a token that has the Account Analytics read permission. The deploy
  // mints that token and binds it, so both are read back at request time.
  static readonly analyticsEngine = (config: {
    readonly accountId: Effect.Effect<string, never, RuntimeContext>;
    readonly token: Effect.Effect<Redacted.Redacted<string>, never, RuntimeContext>;
    readonly dataset: string;
  }) =>
    Layer.succeed(Delivery, {
      assetDelivery: Effect.fn("Delivery.assetDelivery")(function* (hash: string, days: number) {
        // Both go into the query text, so only known-safe shapes are allowed in.
        if (!/^[A-Za-z0-9_-]{43}$/.test(hash) || !/^[A-Za-z0-9_-]+$/.test(config.dataset) || !Number.isInteger(days)) {
          return null;
        }
        const accountId = yield* config.accountId;
        const token = Redacted.value(yield* config.token);
        const query = `
          SELECT blob3 AS outcome, SUM(_sample_interval) AS count, SUM(_sample_interval * double2) AS bytes
          FROM "${config.dataset}"
          WHERE blob1 = 'asset' AND blob2 = '${hash}' AND timestamp > NOW() - INTERVAL '${days}' DAY
          GROUP BY outcome FORMAT JSON`;
        const result = yield* Effect.tryPromise({
          try: async () => {
            const response = await fetch(
              `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/analytics_engine/sql`,
              { method: "POST", headers: { authorization: `Bearer ${token}` }, body: query },
            );
            if (!response.ok) throw new Error(`Analytics Engine answered ${response.status}`);
            return (await response.json()) as { data?: Array<{ outcome: string; count: number | string; bytes: number | string }> };
          },
          catch: (cause) => cause,
        }).pipe(
          Effect.catch((cause) => Effect.logWarning("Delivery query failed", { cause }).pipe(Effect.as(null))),
        );
        if (result === null) return null;
        const delivery = { days, full: 0, patch: 0, fullBytes: 0, patchBytes: 0 };
        for (const row of result.data ?? []) {
          const count = Number(row.count);
          const bytes = Number(row.bytes);
          if (row.outcome === "full") {
            delivery.full = count;
            delivery.fullBytes = bytes;
          } else if (row.outcome === "patch") {
            delivery.patch = count;
            delivery.patchBytes = bytes;
          }
        }
        return delivery;
      }),
    });
}
