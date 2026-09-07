import type { RuntimeContext } from "alchemy";
import type { R2 } from "alchemy/Cloudflare";
import { Context, Effect, Layer, Stream } from "effect";
import { ChecksumMismatch, StorageError } from "./errors.ts";

// A body arrives either whole or as a stream whose length the request declared.
export type AssetBody =
  | { readonly bytes: Uint8Array }
  | { readonly stream: ReadableStream<Uint8Array>; readonly size: number };

export interface PutOptions {
  readonly contentType: string;
  // Hex SHA-256 the stored bytes must hash to. R2 checks it as the object
  // lands, so a corrupt upload never becomes an object.
  readonly sha256?: string;
}

// R2 calls run inside Alchemy's request context, which the Worker provides.
export interface AssetStoreShape {
  readonly get: (
    key: string,
  ) => Effect.Effect<Stream.Stream<Uint8Array, StorageError> | null, StorageError, RuntimeContext>;
  readonly getBytes: (key: string) => Effect.Effect<Uint8Array | null, StorageError, RuntimeContext>;
  readonly put: (
    key: string,
    body: AssetBody,
    options: PutOptions,
  ) => Effect.Effect<void, StorageError | ChecksumMismatch, RuntimeContext>;
  readonly delete: (keys: ReadonlyArray<string>) => Effect.Effect<void, StorageError, RuntimeContext>;
}

const mismatch = () => new ChecksumMismatch({ message: "The body does not match the hash." });

// R2 deletes at most this many keys per call.
const deleteBatch = 1000;

export class AssetStore extends Context.Service<AssetStore, AssetStoreShape>()("expo-ota/AssetStore") {
  static readonly r2 = (bucket: R2.ReadWriteBucketClient) => {
    const fail = (message: string) => (cause: unknown) => new StorageError({ message, cause });
    return Layer.succeed(AssetStore, {
      get: Effect.fn("AssetStore.get")((key: string) =>
        bucket.get(key).pipe(
          Effect.mapError(fail("Could not read the object.")),
          Effect.map((object) =>
            object === null ? null : object.body.pipe(Stream.mapError(fail("Could not stream the object."))),
          ),
        ),
      ),
      getBytes: Effect.fn("AssetStore.getBytes")((key: string) =>
        bucket.get(key).pipe(
          Effect.flatMap((object) => (object === null ? Effect.succeed(null) : object.bytes())),
          Effect.mapError(fail("Could not read the object.")),
        ),
      ),
      put: Effect.fn("AssetStore.put")((key: string, body: AssetBody, options: PutOptions) => {
        // A tee'd request body has no length of its own; R2 needs one.
        const value = "bytes" in body ? body.bytes : body.stream.pipeThrough(new FixedLengthStream(body.size));
        return bucket
          .put(key, value, {
            httpMetadata: { contentType: options.contentType },
            ...(options.sha256 === undefined ? {} : { sha256: options.sha256 }),
          })
          .pipe(
            Effect.mapError((error) => {
              const text = `${error.message} ${error.cause instanceof Error ? error.cause.message : ""}`;
              return /checksum|sha-?256|digest/i.test(text) ? mismatch() : fail("Could not write the object.")(error);
            }),
            Effect.asVoid,
          );
      }),
      delete: Effect.fn("AssetStore.delete")((keys: ReadonlyArray<string>) =>
        Effect.forEach(
          Array.from({ length: Math.ceil(keys.length / deleteBatch) }, (_, index) =>
            keys.slice(index * deleteBatch, (index + 1) * deleteBatch),
          ),
          (batch) => bucket.delete([...batch]).pipe(Effect.mapError(fail("Could not delete the objects."))),
          { discard: true },
        ),
      ),
    });
  };

  static readonly memory = () =>
    Layer.sync(AssetStore, () => {
      const objects = new Map<string, Uint8Array>();
      const collect = (body: AssetBody) =>
        "bytes" in body
          ? Effect.succeed(body.bytes)
          : Effect.tryPromise({
              try: () => new Response(body.stream).bytes(),
              catch: (cause) => new StorageError({ message: "Could not read the body.", cause }),
            }).pipe(
              Effect.filterOrFail(
                (bytes) => bytes.length === body.size,
                () => new StorageError({ message: "The body did not match its declared length." }),
              ),
            );
      const digest = (bytes: Uint8Array) =>
        Effect.tryPromise({
          try: async () =>
            Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>)))
              .map((byte) => byte.toString(16).padStart(2, "0"))
              .join(""),
          catch: (cause) => new StorageError({ message: "Could not hash the body.", cause }),
        });
      return {
        get: Effect.fn("AssetStore.get")((key) => Effect.sync(() => {
          const bytes = objects.get(key);
          return bytes === undefined ? null : Stream.succeed(bytes);
        })),
        getBytes: Effect.fn("AssetStore.getBytes")((key) => Effect.sync(() => objects.get(key) ?? null)),
        put: Effect.fn("AssetStore.put")((key, body, options) =>
          Effect.gen(function* () {
            const bytes = yield* collect(body);
            if (options.sha256 !== undefined && (yield* digest(bytes)) !== options.sha256) {
              return yield* Effect.fail(mismatch());
            }
            objects.set(key, bytes);
          }),
        ),
        delete: Effect.fn("AssetStore.delete")((keys) => Effect.sync(() => {
          for (const key of keys) objects.delete(key);
        })),
      };
    });
}
