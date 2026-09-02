import { Effect } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { BadRequest, Unauthorized, httpStatus, type UpdatesError } from "./errors.ts";

// Every route ends here: typed failures become JSON with the matching status.
export const handle = <R>(effect: Effect.Effect<HttpServerResponse.HttpServerResponse, UpdatesError, R>) =>
  effect.pipe(
    Effect.catch((error) =>
      Effect.succeed(HttpServerResponse.jsonUnsafe({ error: error.message }, { status: httpStatus(error) })),
    ),
  );

export const bearer =
  (token: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      if (request.headers.authorization !== `Bearer ${token}`) {
        return yield* Effect.fail(new Unauthorized({ message: "Missing or invalid publish token." }));
      }
      return yield* effect;
    });

// Workers Cache follows response headers, so anything that does not opt in
// explicitly (assets do) must say no-store.
export const noStoreByDefault = HttpRouter.middleware()(
  Effect.succeed((handler) =>
    Effect.map(handler, (response) =>
      response.headers["cache-control"] === undefined
        ? HttpServerResponse.setHeader(response, "cache-control", "no-store")
        : response,
    ),
  ),
).layer;

export const badRequestOn =
  (message: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(Effect.mapError(() => new BadRequest({ message })));
