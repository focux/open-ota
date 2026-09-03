import { Effect, Schema } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { NotFound } from "./errors.ts";
import { bearer, badRequestOn, handle } from "./http.ts";
import { BranchName, Percent, Platform, type PublishGroupInput } from "./model.ts";
import { PublishAuth } from "./routes.ts";
import { UpdateStore, bundleInput, republishInput, type RollbackTarget } from "./store.ts";

const Name = Schema.Struct({ name: BranchName });
const Id = Schema.Struct({ id: Schema.String });
const GroupsPage = Schema.Struct({
  limit: Schema.optional(Schema.NumberFromString.check(Schema.isBetween({ minimum: 1, maximum: 200 }))),
  before: Schema.optional(Schema.String),
});
const ChannelInput = Schema.Struct({ branch: BranchName });
const PromoteInput = Schema.Struct({
  branch: BranchName,
  message: Schema.optionalKey(Schema.String),
  rolloutPercent: Schema.optionalKey(Percent),
});
const RollbackTargetInput = Schema.Struct({
  platform: Platform,
  runtimeVersion: Schema.String.check(Schema.isNonEmpty()),
  mode: Schema.Literals(["previous", "embedded"]),
});
const BranchRollbackInput = Schema.Struct({
  targets: Schema.Array(RollbackTargetInput).check(Schema.isNonEmpty()),
  message: Schema.optionalKey(Schema.String),
});
const RolloutInput = Schema.Struct({ percent: Percent });
const RollbackInput = Schema.Struct({
  runtimeVersion: Schema.String.check(Schema.isNonEmpty()),
  platforms: Schema.Array(Platform).check(Schema.isNonEmpty()),
  message: Schema.optionalKey(Schema.String),
});

// Reached only through the dashboard's service binding, with the same bearer
// token as publishing.
export const adminRoutes = HttpRouter.use(
  Effect.fn("Admin.routes")(function* (router) {
    const store = yield* UpdateStore;
    const auth = yield* PublishAuth;
    const authorized = bearer(auth.token);
    const body = <A, I, RD>(schema: Schema.ConstraintCodec<A, I, RD, unknown>) =>
      HttpServerRequest.schemaBodyJson(schema).pipe(badRequestOn("Invalid request body."));
    const json = (value: unknown, status = 200) => HttpServerResponse.jsonUnsafe(value, { status });
    // The dashboard forwards the Cloudflare Access identity of whoever clicked.
    const actor = Effect.map(HttpServerRequest.HttpServerRequest, (request) => request.headers["x-ota-actor"]);
    const withActor = (input: PublishGroupInput, who: string | undefined): PublishGroupInput =>
      who === undefined ? input : { ...input, actor: who };

    yield* router.add(
      "GET",
      "/admin/overview",
      handle(
        authorized(
          Effect.gen(function* () {
            const [channels, branches, latest] = yield* Effect.all([
              store.listChannels(),
              store.listBranches(),
              store.latestPerRuntime(),
            ]);
            return json({ channels, branches, latest });
          }).pipe(Effect.withSpan("Admin.overview")),
        ),
      ),
    );

    yield* router.add(
      "GET",
      "/admin/metrics",
      handle(authorized(store.metricsOverview().pipe(Effect.map((overview) => json(overview)), Effect.withSpan("Admin.metrics")))),
    );

    yield* router.add(
      "GET",
      "/admin/branches/:name/groups",
      handle(
        authorized(
          Effect.gen(function* () {
            const { name } = yield* HttpRouter.schemaPathParams(Name).pipe(badRequestOn("Invalid branch."));
            const page = yield* HttpRouter.schemaParams(GroupsPage).pipe(badRequestOn("Invalid page parameters."));
            const groups = yield* store.listGroups(name, {
              limit: page.limit ?? 50,
              ...(page.before === undefined ? {} : { before: page.before }),
            });
            return json({ groups });
          }).pipe(Effect.withSpan("Admin.groups")),
        ),
      ),
    );

    yield* router.add(
      "GET",
      "/admin/groups/:id",
      handle(
        authorized(
          Effect.gen(function* () {
            const { id } = yield* HttpRouter.schemaPathParams(Id).pipe(badRequestOn("Invalid group id."));
            const group = yield* store.groupById(id);
            if (group === null) return yield* Effect.fail(new NotFound({ message: "Unknown group." }));
            return json(group);
          }).pipe(Effect.withSpan("Admin.group")),
        ),
      ),
    );

    yield* router.add(
      "POST",
      "/admin/channels/:name",
      handle(
        authorized(
          Effect.gen(function* () {
            const { name } = yield* HttpRouter.schemaPathParams(Name).pipe(badRequestOn("Invalid channel."));
            const { branch } = yield* body(ChannelInput);
            if (!(yield* store.setChannelBranch(name, branch))) {
              return yield* Effect.fail(new NotFound({ message: "Unknown branch." }));
            }
            return json({ channel: name, branch });
          }).pipe(Effect.withSpan("Admin.setChannel")),
        ),
      ),
    );

    yield* router.add(
      "POST",
      "/admin/groups/:id/promote",
      handle(
        authorized(
          Effect.gen(function* () {
            const { id } = yield* HttpRouter.schemaPathParams(Id).pipe(badRequestOn("Invalid group id."));
            const input = yield* body(PromoteInput);
            const group = yield* store.groupById(id);
            if (group === null) return yield* Effect.fail(new NotFound({ message: "Unknown group." }));
            const message = input.message ?? `${group.branch === input.branch ? "Republished" : "Promoted from " + group.branch}: ${group.message ?? id}`;
            const republished = withActor(republishInput(group, input.branch, message), yield* actor);
            return json(
              yield* store.publishGroup(
                input.rolloutPercent === undefined ? republished : { ...republished, rolloutPercent: input.rolloutPercent },
              ),
              201,
            );
          }).pipe(Effect.withSpan("Admin.promote")),
        ),
      ),
    );

    yield* router.add(
      "POST",
      "/admin/groups/:id/rollout",
      handle(
        authorized(
          Effect.gen(function* () {
            const { id } = yield* HttpRouter.schemaPathParams(Id).pipe(badRequestOn("Invalid group id."));
            const { percent } = yield* body(RolloutInput);
            if (!(yield* store.setRollout(id, percent))) {
              return yield* Effect.fail(new NotFound({ message: "Unknown group." }));
            }
            return json({ groupId: id, rolloutPercent: percent });
          }).pipe(Effect.withSpan("Admin.setRollout")),
        ),
      ),
    );

    yield* router.add(
      "GET",
      "/admin/branches/:name/rollback-plan",
      handle(
        authorized(
          Effect.gen(function* () {
            const { name } = yield* HttpRouter.schemaPathParams(Name).pipe(badRequestOn("Invalid branch."));
            return json({ targets: yield* store.rollbackTargets(name) });
          }).pipe(Effect.withSpan("Admin.rollbackPlan")),
        ),
      ),
    );

    // One group per runtime version: a group holds one update per platform.
    yield* router.add(
      "POST",
      "/admin/branches/:name/rollback",
      handle(
        authorized(
          Effect.gen(function* () {
            const { name } = yield* HttpRouter.schemaPathParams(Name).pipe(badRequestOn("Invalid branch."));
            const input = yield* body(BranchRollbackInput);
            const plan = yield* store.rollbackTargets(name);
            const who = yield* actor;
            const byRuntime = new Map<string, { updates: PublishGroupInput["updates"]; previous: RollbackTarget["previous"] }>();
            for (const chosen of input.targets) {
              const target = plan.find((t) => t.platform === chosen.platform && t.runtimeVersion === chosen.runtimeVersion);
              if (target === undefined) {
                return yield* Effect.fail(new NotFound({ message: `${chosen.platform} ${chosen.runtimeVersion} is not served on ${name}.` }));
              }
              if (chosen.mode === "previous" && target.previous === null) {
                return yield* Effect.fail(new NotFound({ message: `${chosen.platform} ${chosen.runtimeVersion} has no previous update to go back to.` }));
              }
              const entry = byRuntime.get(chosen.runtimeVersion) ?? { updates: {}, previous: null };
              entry.updates = {
                ...entry.updates,
                [chosen.platform]:
                  chosen.mode === "previous" && target.previous !== null
                    ? bundleInput(target.previous)
                    : { runtimeVersion: chosen.runtimeVersion, rollbackToEmbedded: true as const },
              };
              entry.previous = entry.previous ?? target.previous;
              byRuntime.set(chosen.runtimeVersion, entry);
            }
            const groups = [];
            for (const [runtimeVersion, entry] of byRuntime) {
              const previous = entry.previous;
              const message =
                input.message ??
                (previous === null
                  ? `Rolled back to embedded (${runtimeVersion.slice(0, 8)})`
                  : `Rolled back to: ${(yield* store.groupById(previous.groupId))?.message ?? previous.id}`);
              groups.push(
                yield* store.publishGroup(
                  withActor(
                    { branch: name, message, updates: entry.updates, ...(previous === null ? {} : { expoConfig: previous.expoConfig }) },
                    who,
                  ),
                ),
              );
            }
            return json({ groups }, 201);
          }).pipe(Effect.withSpan("Admin.rollback")),
        ),
      ),
    );

    yield* router.add(
      "POST",
      "/admin/branches/:name/rollback-to-embedded",
      handle(
        authorized(
          Effect.gen(function* () {
            const { name } = yield* HttpRouter.schemaPathParams(Name).pipe(badRequestOn("Invalid branch."));
            const input = yield* body(RollbackInput);
            const rollback = { runtimeVersion: input.runtimeVersion, rollbackToEmbedded: true } as const;
            const group = yield* store.publishGroup(
              withActor(
                {
                  branch: name,
                  message: input.message ?? `Rolled back to embedded (${input.runtimeVersion.slice(0, 8)})`,
                  updates: Object.fromEntries(input.platforms.map((platform) => [platform, rollback])),
                },
                yield* actor,
              ),
            );
            return json(group, 201);
          }).pipe(Effect.withSpan("Admin.rollbackToEmbedded")),
        ),
      ),
    );
  }),
);
