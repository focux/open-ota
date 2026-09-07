import { Schema } from "effect";

export class BadRequest extends Schema.TaggedError<BadRequest>()("BadRequest", {
  message: Schema.String,
}) {}

export class Conflict extends Schema.TaggedError<Conflict>()("Conflict", {
  message: Schema.String,
}) {}

export class Unauthorized extends Schema.TaggedError<Unauthorized>()("Unauthorized", {
  message: Schema.String,
}) {}

export class NotFound extends Schema.TaggedError<NotFound>()("NotFound", {
  message: Schema.String,
}) {}

export class StorageError extends Schema.TaggedError<StorageError>()("StorageError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Unknown),
}) {}

export class CryptoError extends Schema.TaggedError<CryptoError>()("CryptoError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Unknown),
}) {}

// An uploaded body whose bytes do not hash to the address it was sent to.
export class ChecksumMismatch extends Schema.TaggedError<ChecksumMismatch>()("ChecksumMismatch", {
  message: Schema.String,
}) {}

// A patch the engine refused: not BSDIFF40, truncated, or too large to apply.
export class PatchError extends Schema.TaggedError<PatchError>()("PatchError", {
  message: Schema.String,
  code: Schema.String,
}) {}

export type UpdatesError =
  | BadRequest
  | Conflict
  | Unauthorized
  | NotFound
  | StorageError
  | CryptoError
  | ChecksumMismatch
  | PatchError;

export const httpStatus = (error: UpdatesError): number => {
  switch (error._tag) {
    case "BadRequest":
    case "ChecksumMismatch":
    case "PatchError":
      return 400;
    case "Conflict":
      return 409;
    case "Unauthorized":
      return 401;
    case "NotFound":
      return 404;
    case "StorageError":
    case "CryptoError":
      return 500;
  }
};
