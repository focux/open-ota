import { Effect } from "effect";

// A device lands in the same bucket for a given update on every check, so a
// rollout percentage only ever grows the audience.
export const rolloutBucket = (clientId: string, updateId: string): Effect.Effect<number> =>
  Effect.promise(async () => {
    const digest = new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${clientId}:${updateId}`)),
    );
    return (((digest[0]! << 24) | (digest[1]! << 16) | (digest[2]! << 8) | digest[3]!) >>> 0) % 100;
  });
