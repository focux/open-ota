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

// Defined by the server once for every view of an update (UpdateFigures in
// store.ts). `running` counts devices on the update wherever they check in
// from; `population` is the devices the update's branch can reach.
const UpdateFigures = Schema.Struct({
  updateId: Schema.String,
  running: Schema.Number,
  served: Schema.Number,
  faulty: Schema.Number,
  population: Schema.Number,
})

const updateFields = {
  id: Schema.String,
  groupId: Schema.String,
  branch: Schema.String,
  platform: Platform,
  runtimeVersion: Schema.String,
  rolloutPercent: Schema.Number,
  createdAt: Schema.String,
  // Present on updates read through a group; the overview's latest rows and
  // rollback plans carry none.
  figures: Schema.optionalKey(UpdateFigures),
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

// `running` counts who is on this update: launching it for bundles, on their
// build's embedded JS for rollbacks. `served` counts devices the server last
// handed this update; served above running means downloaded and waiting for a
// relaunch. `faulty` counts the ones that crashed at launch and rolled back.
const UpdateAdoption = Schema.Struct({
  updateId: Schema.String,
  // Counted per channel: a card scoped to one channel must divide the same
  // population it counts, and two channels can serve the same update.
  channel: Schema.String,
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

// A stored bsdiff patch toward one update's bundle: which base it applies to,
// which updates run that base, and how it compares with the full download.
const StoredPatch = Schema.Struct({
  baseHash: Schema.String,
  size: Schema.Number,
  createdAt: Schema.String,
  ratio: Schema.NullOr(Schema.Number),
  bases: Schema.Array(
    Schema.Struct({ updateId: Schema.String, embedded: Schema.Boolean })
  ),
})

// How the bundle went out recently, from Analytics Engine. Null when the
// server has no API token to query it with.
const AssetDelivery = Schema.Struct({
  days: Schema.Number,
  full: Schema.Number,
  patch: Schema.Number,
  fullBytes: Schema.Number,
  patchBytes: Schema.Number,
})

const UpdatePatches = Schema.Struct({
  updateId: Schema.String,
  launchAsset: Schema.Struct({
    hash: Schema.String,
    size: Schema.NullOr(Schema.Number),
    compressedSize: Schema.NullOr(Schema.Number),
    // What a device downloads without a patch: the gzip size at the edge.
    wireSize: Schema.NullOr(Schema.Number),
    // False once the retention sweep removed the bundle.
    present: Schema.Boolean,
  }),
  maxRatio: Schema.Number,
  patches: Schema.Array(StoredPatch),
  delivery: Schema.NullOr(AssetDelivery),
})

// One device as the registry last saw it. Nulls are "not reported", never
// "none": a device on its build's embedded JS names that bundle's own id.
const Device = Schema.Struct({
  clientId: Schema.String,
  platform: Platform,
  runtimeVersion: Schema.String,
  channel: Schema.String,
  currentUpdateId: Schema.NullOr(Schema.String),
  embeddedUpdateId: Schema.NullOr(Schema.String),
  servedUpdateId: Schema.NullOr(Schema.String),
  country: Schema.NullOr(Schema.String),
  city: Schema.NullOr(Schema.String),
  firstSeenAt: Schema.String,
  lastSeenAt: Schema.String,
})

// Why the server answered a check the way it did. Mirrors DecisionReason in
// apps/updates/src/protocol.ts; the words for each are in lib/devices.ts.
const DecisionReason = Schema.Literals([
  "manifest",
  "rollback",
  "unknown-channel",
  "no-update-for-runtime",
  "rollout-excluded",
  "already-current",
  "already-embedded",
])

// One answer a device got. A run of identical answers arrives as one entry
// with `checks` above 1, spanning first to last.
const DeviceCheck = Schema.Struct({
  firstCheckedAt: Schema.String,
  lastCheckedAt: Schema.String,
  checks: Schema.Number,
  platform: Platform,
  runtimeVersion: Schema.String,
  channel: Schema.String,
  currentUpdateId: Schema.NullOr(Schema.String),
  embeddedUpdateId: Schema.NullOr(Schema.String),
  decision: Schema.Literals(["manifest", "rollback", "none"]),
  reason: DecisionReason,
  servedUpdateId: Schema.NullOr(Schema.String),
  fatalError: Schema.NullOr(Schema.String),
})

const DeviceDetail = Schema.Struct({
  device: Device,
  checks: Schema.Array(DeviceCheck),
})

const DevicesPage = Schema.Struct({ devices: Schema.Array(Device) })

/** What support can be told, and search on. Every field narrows the list. */
export interface DeviceFilters {
  readonly platform?: Platform
  readonly runtimeVersion?: string
  readonly channel?: string
  readonly currentUpdateId?: string
  readonly country?: string
  readonly seenWithinMinutes?: number
}

export type Platform = typeof Platform.Type
export type Device = typeof Device.Type
export type DeviceCheck = typeof DeviceCheck.Type
export type DecisionReason = typeof DecisionReason.Type
export type DeviceDetail = typeof DeviceDetail.Type
export type StoredAsset = typeof StoredAsset.Type
export type BundleUpdate = typeof BundleUpdate.Type
export type Update = typeof Update.Type
export type Channel = typeof Channel.Type
export type UpdateFigures = typeof UpdateFigures.Type
export type Group = typeof Group.Type
export type Overview = typeof Overview.Type
export type Metrics = typeof Metrics.Type
export type RuntimeDevices = typeof RuntimeDevices.Type
export type UpdateFailure = typeof UpdateFailure.Type
export type CountryDevices = typeof CountryDevices.Type
export type RollbackTarget = typeof RollbackTarget.Type
export type RollbackMode = "previous" | "embedded"
export type PublishResult = typeof PublishResult.Type
export type StoredPatch = typeof StoredPatch.Type
export type AssetDelivery = typeof AssetDelivery.Type
export type UpdatePatches = typeof UpdatePatches.Type

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
  devices: (filters: DeviceFilters) =>
    runRequest(
      `/api/admin/devices?${deviceQuery(filters)}`,
      "GET",
      undefined,
      DevicesPage
    ),
  device: (clientId: string) =>
    runRequest(
      `/api/admin/devices/${encodeURIComponent(clientId)}`,
      "GET",
      undefined,
      DeviceDetail
    ),
  updatePatches: (updateId: string) =>
    runRequest(
      `/api/admin/updates/${encodeURIComponent(updateId)}/patches`,
      "GET",
      undefined,
      UpdatePatches
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

/** Only the filters the user actually filled in reach the server. */
export function deviceQuery(filters: DeviceFilters): string {
  const params = new URLSearchParams()
  for (const [name, value] of Object.entries(filters)) {
    const text = typeof value === "number" ? String(value) : value?.trim()
    if (text !== undefined && text !== "") params.set(name, text)
  }
  return params.toString()
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
