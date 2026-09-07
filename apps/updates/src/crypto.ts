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

// R2 verifies uploads against a hex digest; Expo addresses assets in base64url.
export const base64UrlToHex = (value: string): string => {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (value.length % 4)) % 4);
  const binary = atob(padded);
  let hex = "";
  for (let index = 0; index < binary.length; index++) {
    hex += binary.charCodeAt(index).toString(16).padStart(2, "0");
  }
  return hex;
};
