import { Schema } from "effect";

export class BadRequest extends Schema.TaggedError<BadRequest>()("BadRequest", {
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

export type UpdatesError = BadRequest | Unauthorized | NotFound | StorageError;

export const httpStatus = (error: UpdatesError): number => {
  switch (error._tag) {
    case "BadRequest":
      return 400;
    case "Unauthorized":
      return 401;
    case "NotFound":
      return 404;
    case "StorageError":
      return 500;
  }
};
