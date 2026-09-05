import { Effect, Layer } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { StorageError } from "./errors.ts";
import { UpdateStore, type MetricsOverview } from "./store.ts";
import { makeServer } from "./test-support.ts";

describe("manifest bookkeeping", () => {
  let server: ReturnType<typeof makeServer>;
  afterEach(() => server.dispose());

  it("does not register an empty device id", async () => {
    server = makeServer(UpdateStore.memory);
    expect((await server.manifest({ "eas-client-id": "" })).status).toBe(200);
    const metrics = (await (await server.authed("/admin/metrics")).json()) as MetricsOverview;
    expect(metrics.online).toBe(0);
  });

  it("bounds client-supplied crash messages before storing them", async () => {
    const failures: Array<string | undefined> = [];
    server = makeServer(() => Layer.effect(
      UpdateStore,
      Effect.map(UpdateStore, (store) => ({
        ...store,
        recordFailures: Effect.fn("Test.recordFailures")((failure) =>
          Effect.sync(() => { failures.push(failure.fatalError); }),
        ),
      })),
    ).pipe(Layer.provide(UpdateStore.memory())));
    expect((await server.manifest({
      "expo-recent-failed-update-ids": '"abcdef00-0000-4000-8000-000000000000"',
      "expo-fatal-error": "x".repeat(4096),
    })).status).toBe(200);
    expect(failures).toEqual(["x".repeat(1024)]);
  });

  it("records the device and event even when writing failures fails", async () => {
    server = makeServer(() =>
      Layer.effect(
        UpdateStore,
        Effect.map(UpdateStore, (store) => ({
          ...store,
          recordFailures: Effect.fn("Test.recordFailures")(() =>
            Effect.fail(new StorageError({ message: "D1 unavailable" })),
          ),
        })),
      ).pipe(Layer.provide(UpdateStore.memory())),
    );
    const response = await server.manifest({ "expo-recent-failed-update-ids": '"abcdef00-0000-4000-8000-000000000000"' });
    expect(response.status).toBe(200);
    const metrics = (await (await server.authed("/admin/metrics")).json()) as MetricsOverview;
    expect(metrics.online).toBe(1);
    expect(server.events).toHaveLength(1);
    expect(server.events[0]).toMatchObject({ event: "check", outcome: "none" });
  });
});
