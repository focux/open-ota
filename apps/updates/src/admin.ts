import { Effect, Schema } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { AssetStore } from "./assets.ts";
import { Delivery } from "./delivery.ts";
import { NotFound } from "./errors.ts";
import { Retention, sweep } from "./gc.ts";
import { bearer, badRequestOn, handle } from "./http.ts";
import { BranchName, Percent, Platform, type PublishGroupInput } from "./model.ts";
import { PatchPolicy, wireSize } from "./patching.ts";
import { PublishAuth } from "./routes.ts";
import { UpdateStore, bundleInput, republishInput, type Group, type RollbackTarget } from "./store.ts";

// Delivery numbers cover this many days.
const deliveryDays = 7;

const Name = Schema.Struct({ name: BranchName });
const Id = Schema.Struct({ id: Schema.String });
const GroupsPage = Schema.Struct({
  limit: Schema.optional(Schema.NumberFromString.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 200 }))),
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
  targets: Schema.Array(RollbackTargetInput).check(
    Schema.isNonEmpty(),
    Schema.makeFilter((targets) =>
      new Set(targets.map((target) => JSON.stringify([target.platform, target.runtimeVersion]))).size === targets.length
        || "Each build can only appear once.",
    ),
  ),
  message: Schema.optionalKey(Schema.String),
});
const RolloutInput = Schema.Struct({ percent: Percent });
const ClientId = Schema.Struct({ clientId: Schema.String.check(Schema.isNonEmpty()) });
const NonEmpty = Schema.String.check(Schema.isNonEmpty());
// Support looks a device up by whatever the user could tell them. Every filter
// is optional and they narrow together.
const DeviceSearch = Schema.Struct({
  platform: Schema.optional(Platform),
  runtimeVersion: Schema.optional(NonEmpty),
  channel: Schema.optional(NonEmpty),
  currentUpdateId: Schema.optional(NonEmpty),
  country: Schema.optional(NonEmpty),
  // A day at most: beyond that "recently" stops narrowing anything.
  seenWithinMinutes: Schema.optional(
    Schema.NumberFromString.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 1440 })),
  ),
  limit: Schema.optional(Schema.NumberFromString.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 200 }))),
});
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
    const delivery = yield* Delivery;
    const policy = yield* PatchPolicy;
    const assets = yield* AssetStore;
    const retention = yield* Retention;
    const authorized = bearer(auth.token);
    const runSweep = sweep().pipe(
      Effect.provideService(UpdateStore, store),
      Effect.provideService(AssetStore, assets),
      Effect.provideService(Retention, retention),
    );
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
          Effect.fn("Admin.overview")(function* () {
            const [channels, branches, latest] = yield* Effect.all([
              store.listChannels(),
              store.listBranches(),
              store.latestPerRuntime(),
            ]);
            return json({ channels, branches, latest });
          })(),
        ),
      ),
    );

    yield* router.add(
      "GET",
      "/admin/metrics",
      handle(authorized(store.metricsOverview().pipe(Effect.map((overview) => json(overview)), Effect.withSpan("Admin.metrics")))),
    );

    // Why one device is where it is: its last known state, then the checks
    // that put it there, newest first.
    yield* router.add(
      "GET",
      "/admin/devices/:clientId",
      handle(
        authorized(
          Effect.fn("Admin.device")(function* () {
            const { clientId } = yield* HttpRouter.schemaPathParams(ClientId).pipe(badRequestOn("Invalid client id."));
            const device = yield* store.deviceById(clientId);
            if (device === null) return yield* Effect.fail(new NotFound({ message: "Unknown device." }));
            return json({ device, checks: yield* store.recentChecks(clientId) });
          })(),
        ),
      ),
    );

    // For when support cannot get a client id out of the user.
    yield* router.add(
      "GET",
      "/admin/devices",
      handle(
        authorized(
          Effect.fn("Admin.devices")(function* () {
            const query = yield* HttpRouter.schemaParams(DeviceSearch).pipe(badRequestOn("Invalid device filters."));
            const devices = yield* store.findDevices({
              platform: query.platform,
              runtimeVersion: query.runtimeVersion,
              channel: query.channel,
              currentUpdateId: query.currentUpdateId,
              country: query.country,
              seenWithinMinutes: query.seenWithinMinutes,
              limit: query.limit ?? 50,
            });
            return json({ devices });
          })(),
        ),
      ),
    );

    // Every update goes out with its figures, so no page has to derive them.
    const withFigures = Effect.fn("Admin.withFigures")(function* (groups: ReadonlyArray<Group>) {
      const figures = yield* store.updateFigures(groups.flatMap((group) => group.updates));
      const byId = new Map(figures.map((entry) => [entry.updateId, entry] as const));
      return groups.map((group) => ({
        ...group,
        updates: group.updates.map((update) => ({ ...update, figures: byId.get(update.id) })),
      }));
    });

    yield* router.add(
      "GET",
      "/admin/branches/:name/groups",
      handle(
        authorized(
          Effect.fn("Admin.groups")(function* () {
            const { name } = yield* HttpRouter.schemaPathParams(Name).pipe(badRequestOn("Invalid branch."));
            const page = yield* HttpRouter.schemaParams(GroupsPage).pipe(badRequestOn("Invalid page parameters."));
            const groups = yield* store.listGroups(name, {
              limit: page.limit ?? 50,
              ...(page.before === undefined ? {} : { before: page.before }),
            });
            return json({ groups: yield* withFigures(groups) });
          })(),
        ),
      ),
    );

    yield* router.add(
      "GET",
      "/admin/groups/:id",
      handle(
        authorized(
          Effect.fn("Admin.group")(function* () {
            const { id } = yield* HttpRouter.schemaPathParams(Id).pipe(badRequestOn("Invalid group id."));
            const group = yield* store.groupById(id);
            if (group === null) return yield* Effect.fail(new NotFound({ message: "Unknown group." }));
            return json((yield* withFigures([group]))[0]);
          })(),
        ),
      ),
    );

    // The patches computed toward one update's bundle, and how that bundle has
    // been going out to devices.
    yield* router.add(
      "GET",
      "/admin/updates/:id/patches",
      handle(
        authorized(
          Effect.fn("Admin.updatePatches")(function* () {
            const { id } = yield* HttpRouter.schemaPathParams(Id).pipe(badRequestOn("Invalid update id."));
            const update = yield* store.updateById(id);
            if (update === null || update.kind !== "bundle") return yield* Effect.fail(new NotFound({ message: "Unknown update." }));
            const hash = update.launchAsset.hash;
            const info = yield* store.assetInfo(hash);
            const [patches, stats] = yield* Effect.all([store.patchesToward(hash), delivery.assetDelivery(hash, deliveryDays)]);
            const wire = info === null ? null : wireSize(info);
            return json({
              updateId: update.id,
              launchAsset: {
                hash,
                size: info?.size ?? null,
                compressedSize: info?.compressedSize ?? null,
                wireSize: wire,
                // Null once a sweep has removed the bundle.
                present: info !== null,
              },
              maxRatio: policy.maxRatio,
              patches: patches.map((patch) => ({ ...patch, ratio: wire === null || wire === 0 ? null : patch.size / wire })),
              delivery: stats,
            });
          })(),
        ),
      ),
    );

    // Runs the retention sweep now instead of waiting for the nightly trigger.
    yield* router.add(
      "POST",
      "/admin/gc",
      handle(authorized(runSweep.pipe(Effect.map((result) => json(result)), Effect.withSpan("Admin.gc")))),
    );

    yield* router.add(
      "POST",
      "/admin/channels/:name",
      handle(
        authorized(
          Effect.fn("Admin.setChannel")(function* () {
            const { name } = yield* HttpRouter.schemaPathParams(Name).pipe(badRequestOn("Invalid channel."));
            const { branch } = yield* body(ChannelInput);
            if (!(yield* store.setChannelBranch(name, branch))) {
              return yield* Effect.fail(new NotFound({ message: "Unknown branch." }));
            }
            return json({ channel: name, branch });
          })(),
        ),
      ),
    );

    yield* router.add(
      "POST",
      "/admin/groups/:id/promote",
      handle(
        authorized(
          Effect.fn("Admin.promote")(function* () {
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
          })(),
        ),
      ),
    );

    yield* router.add(
      "POST",
      "/admin/groups/:id/rollout",
      handle(
        authorized(
          Effect.fn("Admin.setRollout")(function* () {
            const { id } = yield* HttpRouter.schemaPathParams(Id).pipe(badRequestOn("Invalid group id."));
            const { percent } = yield* body(RolloutInput);
            if (!(yield* store.setRollout(id, percent))) {
              return yield* Effect.fail(new NotFound({ message: "Unknown group." }));
            }
            return json({ groupId: id, rolloutPercent: percent });
          })(),
        ),
      ),
    );

    yield* router.add(
      "GET",
      "/admin/branches/:name/rollback-plan",
      handle(
        authorized(
          Effect.fn("Admin.rollbackPlan")(function* () {
            const { name } = yield* HttpRouter.schemaPathParams(Name).pipe(badRequestOn("Invalid branch."));
            return json({ targets: yield* store.rollbackTargets(name) });
          })(),
        ),
      ),
    );

    // One group per runtime version: a group holds one update per platform.
    yield* router.add(
      "POST",
      "/admin/branches/:name/rollback",
      handle(
        authorized(
          Effect.fn("Admin.rollback")(function* () {
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
              if (chosen.mode === "previous" && target.previous !== null) {
                entry.updates = { ...entry.updates, [chosen.platform]: bundleInput(target.previous) };
                entry.previous = entry.previous ?? target.previous;
              } else {
                entry.updates = {
                  ...entry.updates,
                  [chosen.platform]: { runtimeVersion: chosen.runtimeVersion, rollbackToEmbedded: true as const },
                };
              }
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
                    { branch: name, message, updates: entry.updates },
                    who,
                  ),
                  { revert: true },
                ),
              );
            }
            return json({ groups }, 201);
          })(),
        ),
      ),
    );

    yield* router.add(
      "POST",
      "/admin/branches/:name/rollback-to-embedded",
      handle(
        authorized(
          Effect.fn("Admin.rollbackToEmbedded")(function* () {
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
          })(),
        ),
      ),
    );
  }),
);
