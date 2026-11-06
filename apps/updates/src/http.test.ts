import { Effect, Logger } from "effect";
import { SqlError, UnknownError } from "effect/unstable/sql/SqlError";
import { describe, expect, it } from "vitest";
import { StorageError } from "./errors.ts";
import { handle } from "./http.ts";

describe("HTTP error logging", () => {
  it("logs the D1 error message while keeping it out of the response", async () => {
    const messages: Array<unknown> = [];
    const driverMessage = "D1_ERROR: database is overloaded";
    const error = new StorageError({
      message: "Could not read metrics.",
      cause: new SqlError({
        reason: new UnknownError({ cause: new Error(driverMessage), message: "Failed to execute statement" }),
      }),
    });
    const response = await Effect.runPromise(handle(Effect.fail(error)).pipe(
      Effect.provide(Logger.layer([Logger.make((options) => { messages.push(options.message); })])),
    ));

    expect(messages.flat()).toContain(driverMessage);
    expect(response.status).toBe(500);
    expect(response.body).toMatchObject({
      _tag: "Uint8Array",
      body: new TextEncoder().encode(JSON.stringify({ error: "Could not read metrics." })),
    });
  });
});
