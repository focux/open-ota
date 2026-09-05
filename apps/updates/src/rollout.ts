import { Effect } from "effect";
import { sha256 } from "./crypto.ts";

// A device lands in the same bucket for a given update on every check, so a
// rollout percentage only ever grows the audience.
export const rolloutBucket = Effect.fn("Rollout.bucket")((clientId: string, updateId: string) =>
  sha256(new TextEncoder().encode(`${clientId}:${updateId}`)).pipe(Effect.map((digest) =>
    (((digest[0]! << 24) | (digest[1]! << 16) | (digest[2]! << 8) | digest[3]!) >>> 0) % 100,
  )),
);
