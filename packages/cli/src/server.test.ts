import { Effect, Layer, Redacted } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { expect, it, vi } from "vitest";
import { Server } from "./server.ts";

it.each([301, 302, 303, 307, 308])("rejects HTTP %i instead of forwarding a publish to a redirect target", async (status) => {
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
    new Response(null, { status, headers: { location: "https://attacker.test/upload" } }),
  );
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const server = yield* Server;
      return yield* Effect.result(server.publishGroup({ message: "private release" }));
    }).pipe(Effect.provide(Server.layer("https://ota.test", Redacted.make("secret")).pipe(
      Layer.provide(FetchHttpClient.layer),
      Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch)),
    ))),
  );
  expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "CliFailure" } });
  expect(fetch).toHaveBeenCalledOnce();
  expect(String(fetch.mock.calls[0]![0])).toBe("https://ota.test/publish/groups");
  expect(fetch.mock.calls[0]![1]?.redirect).toBe("manual");
});
