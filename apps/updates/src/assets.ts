import type { RuntimeContext } from "alchemy";
import type { R2 } from "alchemy/Cloudflare";
import { Context, Effect, Layer, Stream } from "effect";
import { StorageError } from "./errors.ts";

// R2 calls run inside Alchemy's request context, which the Worker provides.
export interface AssetStoreShape {
  readonly get: (
    key: string,
  ) => Effect.Effect<Stream.Stream<Uint8Array, StorageError> | null, StorageError, RuntimeContext>;
  readonly put: (
    key: string,
    bytes: Uint8Array,
    contentType: string,
  ) => Effect.Effect<void, StorageError, RuntimeContext>;
}

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
      put: Effect.fn("AssetStore.put")((key: string, bytes: Uint8Array, contentType: string) =>
        bucket
          .put(key, bytes, { httpMetadata: { contentType } })
          .pipe(Effect.mapError(fail("Could not write the object.")), Effect.asVoid),
      ),
    });
  };

  static readonly memory = () =>
    Layer.sync(AssetStore, () => {
      const objects = new Map<string, Uint8Array>();
      return {
        get: Effect.fn("AssetStore.get")((key) => Effect.sync(() => {
          const bytes = objects.get(key);
          return bytes === undefined ? null : Stream.succeed(bytes);
        })),
        put: Effect.fn("AssetStore.put")((key, bytes) => Effect.sync(() => void objects.set(key, bytes))),
      };
    });
}
