import { Data, Effect, ManagedRuntime, Schema } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import * as HttpClient from "effect/unstable/http/HttpClient"
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"

// Mirrors apps/updates/src/model.ts and the Channel/Group rows in store.ts.
const Platform = Schema.Literals(["ios", "android"])

const StoredAsset = Schema.Struct({
  hash: Schema.String,
  key: Schema.String,
  contentType: Schema.String,
  fileExtension: Schema.optionalKey(Schema.String),
})

const updateFields = {
  id: Schema.String,
  groupId: Schema.String,
  branch: Schema.String,
  platform: Platform,
  runtimeVersion: Schema.String,
  rolloutPercent: Schema.Number,
  createdAt: Schema.String,
}

const BundleUpdate = Schema.Struct({
  kind: Schema.Literal("bundle"),
  ...updateFields,
  launchAsset: StoredAsset,
  assets: Schema.Array(StoredAsset),
  expoConfig: Schema.Record(Schema.String, Schema.Unknown),
})

const RollbackUpdate = Schema.Struct({
  kind: Schema.Literal("rollback"),
  ...updateFields,
})

const Update = Schema.Union([BundleUpdate, RollbackUpdate])

const Channel = Schema.Struct({
  name: Schema.String,
  branch: Schema.String,
  updatedAt: Schema.String,
})

const Group = Schema.Struct({
  id: Schema.String,
  branch: Schema.String,
  message: Schema.NullOr(Schema.String),
  gitCommit: Schema.NullOr(Schema.String),
  // Who published it: the commit author for CLI publishes, the Access identity
  // for anything done from this dashboard.
  actor: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  updates: Schema.Array(Update),
})

const Overview = Schema.Struct({
  channels: Schema.Array(Channel),
  branches: Schema.Array(Schema.String),
  latest: Schema.Array(Update),
})

const GroupsPage = Schema.Struct({ groups: Schema.Array(Group) })

const ChannelResult = Schema.Struct({
  channel: Schema.String,
  branch: Schema.String,
})

const PublishResult = Schema.Struct({
  groupId: Schema.String,
  updates: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      platform: Platform,
      runtimeVersion: Schema.String,
    })
  ),
})

// Devices check in on a channel, so a runtime row is per channel: drift only
// means anything against the branch that channel is linked to.
const RuntimeDevices = Schema.Struct({
  channel: Schema.String,
  platform: Platform,
  runtimeVersion: Schema.String,
  devices: Schema.Number,
})

// `served` counts devices the server last handed this update; `running` counts
// the ones that report launching it. Served above running means downloaded and
// waiting for a relaunch. `faulty` counts the ones that crashed at launch and
// rolled back.
const UpdateAdoption = Schema.Struct({
  updateId: Schema.String,
  running: Schema.Number,
  served: Schema.Number,
  faulty: Schema.Number,
})

const UpdateFailure = Schema.Struct({
  updateId: Schema.String,
  message: Schema.String,
  devices: Schema.Number,
})

// Country comes from Cloudflare's request geolocation, so it is an ISO code.
const CountryDevices = Schema.Struct({
  country: Schema.String,
  devices: Schema.Number,
})

const UpdateSegment = Schema.Struct({
  updateId: Schema.String,
  country: Schema.String,
  running: Schema.Number,
  faulty: Schema.Number,
})

const Metrics = Schema.Struct({
  online: Schema.Number,
  runtimes: Schema.Array(RuntimeDevices),
  updates: Schema.Array(UpdateAdoption),
  failures: Schema.Array(UpdateFailure),
  countries: Schema.Array(CountryDevices),
  segments: Schema.Array(UpdateSegment),
})

// One row per build the branch serves, with the state it would go back to.
const RollbackTarget = Schema.Struct({
  platform: Platform,
  runtimeVersion: Schema.String,
  current: Update,
  previous: Schema.NullOr(BundleUpdate),
  devices: Schema.Number,
})

const RollbackPlan = Schema.Struct({
  targets: Schema.Array(RollbackTarget),
})

const RollbackResult = Schema.Struct({
  groups: Schema.Array(
    Schema.Struct({
      groupId: Schema.String,
      updates: Schema.Array(
        Schema.Struct({
          id: Schema.String,
          platform: Platform,
          runtimeVersion: Schema.String,
        })
      ),
    })
  ),
})

const RolloutResult = Schema.Struct({
  groupId: Schema.String,
  rolloutPercent: Schema.Number,
})

export type Platform = typeof Platform.Type
export type StoredAsset = typeof StoredAsset.Type
export type BundleUpdate = typeof BundleUpdate.Type
export type Update = typeof Update.Type
export type Channel = typeof Channel.Type
export type Group = typeof Group.Type
export type Overview = typeof Overview.Type
export type Metrics = typeof Metrics.Type
export type RuntimeDevices = typeof RuntimeDevices.Type
export type UpdateFailure = typeof UpdateFailure.Type
export type CountryDevices = typeof CountryDevices.Type
export type RollbackTarget = typeof RollbackTarget.Type
export type RollbackMode = "previous" | "embedded"
export type PublishResult = typeof PublishResult.Type

/**
 * `rejected` is the server refusing the request, `unreachable` is not getting
 * an answer at all, `unexpected` is an answer we could not read. The UI
 * branches on this, never on status codes.
 */
export type DashboardErrorKind = "rejected" | "unreachable" | "unexpected"

export class DashboardApiError extends Data.TaggedError("DashboardApiError")<{
  readonly message: string
  readonly kind: DashboardErrorKind
  readonly status?: number
}> {}

const apiRuntime = ManagedRuntime.make(FetchHttpClient.layer)

/** Every call goes to the catch-all route in `routes/$.ts`, which adds the bearer token. */
export const api = {
  overview: () => runRequest("/api/admin/overview", "GET", undefined, Overview),
  metrics: () => runRequest("/api/admin/metrics", "GET", undefined, Metrics),
  groups: (branch: string, before?: string) =>
    runRequest(
      `/api/admin/branches/${encodeURIComponent(branch)}/groups?${new URLSearchParams(
        {
          limit: "50",
          ...(before === undefined ? {} : { before }),
        }
      ).toString()}`,
      "GET",
      undefined,
      GroupsPage
    ),
  group: (id: string) =>
    runRequest(
      `/api/admin/groups/${encodeURIComponent(id)}`,
      "GET",
      undefined,
      Group
    ),
  setChannel: (channel: string, branch: string) =>
    runRequest(
      `/api/admin/channels/${encodeURIComponent(channel)}`,
      "POST",
      { branch },
      ChannelResult
    ),
  rollbackPlan: (branch: string) =>
    runRequest(
      `/api/admin/branches/${encodeURIComponent(branch)}/rollback-plan`,
      "GET",
      undefined,
      RollbackPlan
    ),
  rollback: (
    branch: string,
    input: {
      readonly targets: ReadonlyArray<{
        readonly platform: Platform
        readonly runtimeVersion: string
        readonly mode: "previous" | "embedded"
      }>
      readonly message?: string
    }
  ) =>
    runRequest(
      `/api/admin/branches/${encodeURIComponent(branch)}/rollback`,
      "POST",
      input,
      RollbackResult
    ),
  promote: (
    groupId: string,
    input: {
      readonly branch: string
      readonly message?: string
      readonly rolloutPercent?: number
    }
  ) =>
    runRequest(
      `/api/admin/groups/${encodeURIComponent(groupId)}/promote`,
      "POST",
      input,
      PublishResult
    ),
  setRollout: (groupId: string, percent: number) =>
    runRequest(
      `/api/admin/groups/${encodeURIComponent(groupId)}/rollout`,
      "POST",
      { percent },
      RolloutResult
    ),
}

function runRequest<TResult>(
  path: string,
  method: "GET" | "POST",
  body: unknown,
  schema: Schema.Codec<TResult, unknown, never, never>
): Promise<TResult> {
  return apiRuntime.runPromise(
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient
      let request =
        method === "POST"
          ? HttpClientRequest.post(path)
          : HttpClientRequest.get(path)
      if (body !== undefined) {
        request = HttpClientRequest.bodyJsonUnsafe(request, body)
      }

      const response = yield* client.execute(request)
      const payload = yield* response.json
      if (response.status < 200 || response.status >= 300) {
        return yield* Effect.fail(
          new DashboardApiError({
            message: readErrorMessage(payload),
            kind: response.status >= 500 ? "unreachable" : "rejected",
            status: response.status,
          })
        )
      }
      return yield* Schema.decodeUnknownEffect(schema)(payload)
    }).pipe(
      Effect.mapError((error) =>
        error instanceof DashboardApiError
          ? error
          : isRequestError(error)
            ? new DashboardApiError({
                message: "The request never reached the updates server.",
                kind: "unreachable",
                status: 0,
              })
            : new DashboardApiError({
                message: "The updates server did not answer as expected.",
                kind: "unexpected",
              })
      )
    )
  )
}

/** A transport failure, as opposed to an answer we could not read. */
function isRequestError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    error._tag === "RequestError"
  )
}

function readErrorMessage(payload: unknown): string {
  return payload !== null &&
    typeof payload === "object" &&
    "error" in payload &&
    typeof payload.error === "string"
    ? payload.error
    : "The updates server rejected the request."
}
