import { Effect } from "effect";
import { CryptoError } from "./errors.ts";

export const sha256 = Effect.fn("Crypto.sha256")((bytes: Uint8Array<ArrayBuffer>) =>
  Effect.tryPromise({
    try: () => crypto.subtle.digest("SHA-256", bytes),
    catch: (cause) => new CryptoError({ message: "Could not hash the bytes.", cause }),
  }).pipe(Effect.map((digest) => new Uint8Array(digest))),
);

// Expo addresses assets by the base64url SHA-256 of their bytes.
export const sha256Base64Url = Effect.fn("Crypto.sha256Base64Url")((bytes: Uint8Array<ArrayBuffer>) =>
  sha256(bytes).pipe(
    Effect.map((digest) =>
      btoa(String.fromCharCode(...digest))
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, ""),
    ),
  ),
);
