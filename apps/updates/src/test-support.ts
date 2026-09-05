import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient";
import { RuntimeContext } from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import { Effect, Layer } from "effect";
import { HttpRouter } from "effect/unstable/http";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import initMigration from "../migrations/0001_init.sql?raw";
import devicesMigration from "../migrations/0002_devices.sql?raw";
import failuresMigration from "../migrations/0004_failures.sql?raw";
import geoMigration from "../migrations/0005_geo.sql?raw";
import actorMigration from "../migrations/0006_actor.sql?raw";
import patchesMigration from "../migrations/0003_patches.sql?raw";
import { adminRoutes } from "./admin.ts";
import { AssetStore } from "./assets.ts";
import { Metrics, type MetricEvent } from "./metrics.ts";
import { noStoreByDefault } from "./http.ts";
import { PublishAuth, routes } from "./routes.ts";
import { Signer } from "./signing.ts";
import { UpdateStore } from "./store.ts";

export const token = "publish-token";
export const origin = "https://updates.test";

export const keys = await crypto.subtle.generateKey(
  { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
  true,
  ["sign", "verify"],
);

export const sqliteDatabase = () => {
  const migrated = Layer.effectDiscard(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      for (const statement of `${initMigration}${devicesMigration}${patchesMigration}${failuresMigration}${geoMigration}${actorMigration}`.split(";").map((s: string) => s.trim()).filter(Boolean)) {
        yield* sql.unsafe(statement);
      }
    }),
  ).pipe(Layer.provideMerge(SqliteClient.layer({ filename: ":memory:" })));
  return migrated;
};

const sqliteStore = () => UpdateStore.layer.pipe(Layer.provide(sqliteDatabase()), Layer.orDie);

// Every suite runs against both store implementations.
export const stores = [
  ["memory", UpdateStore.memory],
  ["sqlite", sqliteStore],
] as const;

// Runs background work inline so tests can assert on it right away.
const inlineExecutionContext = Layer.succeed(Cloudflare.Workers.WorkerExecutionContext, {
  waitUntil: (effect) => Effect.asVoid(effect),
} as Cloudflare.Workers.WorkerExecutionContext["Service"]);

export const makeServer = (
  store: () => Layer.Layer<UpdateStore, never, never>,
  assets: Layer.Layer<AssetStore> = AssetStore.memory(),
) => {
  const events: Array<MetricEvent> = [];
  const server = HttpRouter.toWebHandler(
    Layer.mergeAll(routes, adminRoutes).pipe(
      Layer.provide(noStoreByDefault),
      // The memory doubles never touch Alchemy's runtime context.
      HttpRouter.provideRequest(Layer.mergeAll(RuntimeContext.phantom, inlineExecutionContext)),
      Layer.provide(
        Layer.mergeAll(
          store(),
          assets,
          Metrics.memory(events),
          Signer.fromKey(keys.privateKey, "main"),
          Layer.succeed(PublishAuth, { token }),
        ),
      ),
    ),
    { disableLogger: true },
  );
  const request = (path: string, init: RequestInit = {}) => server.handler(new Request(`${origin}${path}`, init));
  const authed = (path: string, init: RequestInit = {}) =>
    request(path, { ...init, headers: { authorization: `Bearer ${token}`, ...init.headers } });
  const post = (path: string, body: unknown) =>
    authed(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const manifest = (headers: Record<string, string>) =>
    request("/manifest", {
      headers: {
        "expo-protocol-version": "1",
        "expo-platform": "ios",
        "expo-runtime-version": "rt-1",
        "expo-channel-name": "staging",
        "eas-client-id": "device-1",
        ...headers,
      },
    });
  return { dispose: server.dispose, request, authed, post, manifest, events };
};

export async function parseMultipart(response: Response) {
  const boundary = /boundary=(.+)$/.exec(response.headers.get("content-type") ?? "")![1]!;
  const text = await response.text();
  return text
    .split(`--${boundary}`)
    .slice(1, -1)
    .map((raw) => {
      const [head, ...rest] = raw.replace(/^\r\n/, "").split("\r\n\r\n");
      const headers = Object.fromEntries(
        head!.split("\r\n").map((line) => {
          const index = line.indexOf(":");
          return [line.slice(0, index).toLowerCase(), line.slice(index + 1).trim()];
        }),
      ) as Record<string, string | undefined>;
      const name = /name="([^"]+)"/.exec(headers["content-disposition"] ?? "")![1]!;
      return { name, headers, body: rest.join("\r\n\r\n").replace(/\r\n$/, "") };
    });
}

export const firstPart = async (response: Response) => JSON.parse((await parseMultipart(response))[0]!.body);
