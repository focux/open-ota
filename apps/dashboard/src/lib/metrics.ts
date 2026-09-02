import type {
  Metrics,
  Platform,
  RuntimeDevices,
  Update,
  UpdateFailure,
} from "@/lib/api"

export interface Adoption {
  /** Devices reporting that they launch this update. */
  readonly running: number
  /** Devices the server last handed this update. Above running means downloaded and awaiting a relaunch. */
  readonly served: number
  /** Devices that crashed on this update at launch and rolled back. */
  readonly faulty: number
  /** Devices seen on this platform and runtime version, whatever they run. */
  readonly devices: number
  readonly percent: number
}

export function activeDevices(metrics: Metrics | undefined): number {
  return (metrics?.runtimes ?? []).reduce(
    (total, runtime) => total + runtime.devices,
    0
  )
}

/** Devices on this build, summed over every channel they check in on. */
export function deviceCount(
  metrics: Metrics | undefined,
  platform: Platform,
  runtimeVersion: string
): number {
  return (metrics?.runtimes ?? [])
    .filter(
      (runtime) =>
        runtime.platform === platform &&
        runtime.runtimeVersion === runtimeVersion
    )
    .reduce((total, runtime) => total + runtime.devices, 0)
}

/** Distinct platform and runtime pairs in the field, however many channels report them. */
export function runtimeVersionCount(metrics: Metrics | undefined): number {
  return new Set(
    (metrics?.runtimes ?? []).map(
      (runtime) => `${runtime.platform} ${runtime.runtimeVersion}`
    )
  ).size
}

export function runningOn(
  metrics: Metrics | undefined,
  updateId: string
): number {
  return (
    metrics?.updates.find((entry) => entry.updateId === updateId)?.running ?? 0
  )
}

export function adoption(
  metrics: Metrics | undefined,
  update: Update
): Adoption {
  const counts = metrics?.updates.find((entry) => entry.updateId === update.id)
  const devices = deviceCount(metrics, update.platform, update.runtimeVersion)
  const running = counts?.running ?? 0
  return {
    running,
    served: counts?.served ?? 0,
    faulty: counts?.faulty ?? 0,
    devices,
    percent: devices === 0 ? 0 : Math.round((running / devices) * 100),
  }
}

/** Devices whose platform and runtime version these updates cover. */
export function coveredDevices(
  metrics: Metrics | undefined,
  published: ReadonlyArray<Update>
): number {
  return (metrics?.runtimes ?? [])
    .filter((runtime) =>
      published.some(
        (update) =>
          update.platform === runtime.platform &&
          update.runtimeVersion === runtime.runtimeVersion
      )
    )
    .reduce((total, runtime) => total + runtime.devices, 0)
}

/**
 * Runtime versions with devices on these channels that the updates do not
 * cover. Those devices will never receive an update, which is what fingerprint
 * drift between the native build and the publish job looks like from here.
 * Scoped to the channels because a staging device is not stranded by what
 * production happens to serve.
 */
export function driftedRuntimes(
  metrics: Metrics | undefined,
  channels: ReadonlyArray<string>,
  published: ReadonlyArray<Update>
): ReadonlyArray<RuntimeDevices> {
  return (metrics?.runtimes ?? []).filter(
    (runtime) =>
      runtime.devices > 0 &&
      channels.includes(runtime.channel) &&
      !published.some(
        (update) =>
          update.platform === runtime.platform &&
          update.runtimeVersion === runtime.runtimeVersion
      )
  )
}

/** Crash messages for the updates in one group, most common first. */
export function failuresFor(
  metrics: Metrics | undefined,
  updates: ReadonlyArray<Update>
): ReadonlyArray<UpdateFailure> {
  return (metrics?.failures ?? []).filter((failure) =>
    updates.some((update) => update.id === failure.updateId)
  )
}

/**
 * A group is current when devices are being served one of its updates today.
 * Republishing the current group would only duplicate it, and the rollout of a
 * superseded group changes nothing, so the row actions read this.
 */
export function isCurrentGroup(
  latest: ReadonlyArray<Update>,
  group: { readonly updates: ReadonlyArray<Update> }
): boolean {
  return group.updates.some((update) =>
    latest.some((newest) => newest.id === update.id)
  )
}

export interface CountrySegment {
  readonly country: string
  readonly running: number
  readonly faulty: number
}

/** Where a group's devices are, summed across its per-platform updates. */
export function segmentsFor(
  metrics: Metrics | undefined,
  updates: ReadonlyArray<Update>
): ReadonlyArray<CountrySegment> {
  const byCountry = new Map<string, { running: number; faulty: number }>()
  for (const segment of metrics?.segments ?? []) {
    if (!updates.some((update) => update.id === segment.updateId)) continue
    const current = byCountry.get(segment.country) ?? { running: 0, faulty: 0 }
    byCountry.set(segment.country, {
      running: current.running + segment.running,
      faulty: current.faulty + segment.faulty,
    })
  }
  return [...byCountry]
    .map(([country, counts]) => ({ country, ...counts }))
    .sort((a, b) => b.running - a.running)
}
