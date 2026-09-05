import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { Signer } from "./signing.ts";
import { keys } from "./test-support.ts";

describe("typed signing failures", () => {
  it("reports an invalid PEM as a CryptoError", async () => {
    const error = await Effect.runPromise(
      Effect.flip(Signer.pipe(Effect.provide(Signer.fromPem("not a PEM", "main")))),
    );
    expect(error._tag).toBe("CryptoError");
    expect(error.message).toBe("Could not import the signing key.");
  });

  it("reports an unusable signing key as a CryptoError", async () => {
    const error = await Effect.runPromise(
      Effect.gen(function* () {
        const signer = yield* Signer;
        return yield* Effect.flip(signer.sign(new TextEncoder().encode("payload")));
      }).pipe(Effect.provide(Signer.fromKey(keys.publicKey, "main"))),
    );
    expect(error._tag).toBe("CryptoError");
    expect(error.message).toBe("Could not sign the response.");
  });
});
