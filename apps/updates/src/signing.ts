import { Context, Effect, Layer } from "effect";
import { CryptoError } from "./errors.ts";

export interface SignerShape {
  readonly keyId: string;
  readonly sign: (bytes: Uint8Array<ArrayBuffer>) => Effect.Effect<string, CryptoError>;
}

const algorithm = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" } as const;

const sign = (key: CryptoKey) => Effect.fn("Signer.sign")((bytes: Uint8Array<ArrayBuffer>) =>
  Effect.tryPromise({
    try: () => crypto.subtle.sign(algorithm, key, bytes),
    catch: (cause) => new CryptoError({ message: "Could not sign the response.", cause }),
  }).pipe(Effect.map(base64)),
);

// Signs manifest and directive parts the way expo-updates verifies them:
// RSA PKCS#1 v1.5 over SHA-256, base64, sent as `sig="…", keyid="…"`.
export class Signer extends Context.Service<Signer, SignerShape>()("expo-ota/Signer") {
  static readonly fromKey = (key: CryptoKey, keyId: string) =>
    Layer.succeed(Signer, {
      keyId,
      sign: sign(key),
    });

  static readonly fromPem = (pem: string, keyId: string) =>
    Layer.effect(
      Signer,
      Effect.gen(function* () {
        const key = yield* Effect.tryPromise({
          try: () => crypto.subtle.importKey("pkcs8", pkcs8FromPem(pem), algorithm, false, ["sign"]),
          catch: (cause) => new CryptoError({ message: "Could not import the signing key.", cause }),
        });
        return { keyId, sign: sign(key) };
      }),
    );
}

export const signatureHeader = (signature: string, keyId: string) => `sig="${signature}", keyid="${keyId}"`;

const base64 = (buffer: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(buffer)));

// `expo-updates codesigning:generate` writes PKCS#1 (`RSA PRIVATE KEY`); WebCrypto
// only imports PKCS#8, so a PKCS#1 body is wrapped in the PKCS#8 envelope here.
export const pkcs8FromPem = (pem: string): Uint8Array<ArrayBuffer> => {
  const body = pem.replace(/-----[A-Z ]+-----/g, "").replace(/\s+/g, "");
  const der = Uint8Array.from(atob(body), (char) => char.charCodeAt(0));
  if (!pem.includes("RSA PRIVATE KEY")) return der;
  const version = Uint8Array.of(0x02, 0x01, 0x00);
  const rsaEncryption = Uint8Array.of(
    0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00,
  );
  return derSequence(0x30, concat(version, rsaEncryption, derSequence(0x04, der)));
};

const derSequence = (tag: number, content: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> => {
  const length =
    content.length < 0x80
      ? Uint8Array.of(content.length)
      : content.length < 0x100
        ? Uint8Array.of(0x81, content.length)
        : content.length < 0x10000
          ? Uint8Array.of(0x82, content.length >> 8, content.length & 0xff)
          : Uint8Array.of(0x83, content.length >> 16, (content.length >> 8) & 0xff, content.length & 0xff);
  return concat(Uint8Array.of(tag), length, content);
};

const concat = (...chunks: ReadonlyArray<Uint8Array<ArrayBuffer>>): Uint8Array<ArrayBuffer> => {
  const out = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
};
