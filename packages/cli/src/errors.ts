import { Schema } from "effect";

export class CliFailure extends Schema.TaggedError<CliFailure>()("CliFailure", {
  message: Schema.String,
  cause: Schema.optional(Schema.Unknown),
}) {}

export class ProcessFailure extends Schema.TaggedError<ProcessFailure>()("ProcessFailure", {
  message: Schema.String,
  command: Schema.String,
  missing: Schema.Boolean,
  cause: Schema.optional(Schema.Unknown),
}) {}
