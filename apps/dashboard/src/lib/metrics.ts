import type {
  Metrics,
  Platform,
  RuntimeDevices,
  Update,
  UpdateFailure,
} from "@/lib/api"

/**
 * The population a percent is a share of: every device on the runtime, only the
 * devices an update directed, or a mix of both across several updates.
 */
export type AdoptionBasis = "runtime" | "directed" | "mixed"

export interface Adoption {
  /** Devices on this update: launching it for bundles, back on embedded JS for rollbacks. */
  readonly running: number
  /** Devices the server last handed this update. Above running means downloaded and awaiting a relaunch. */
  readonly served: number
  /** Devices that crashed on this update at launch and rolled back. */
  readonly faulty: number
  /** Devices seen on this platform and runtime version, whatever they run. */
  readonly devices: number
  /** What `percent` divides by, and which population that is. Read both to label it. */
  readonly base: number
  readonly basis: AdoptionBasis
  readonly percent: number
}

export function activeDevices(metrics: Metrics | undefined): number {
  return (metrics?.runtimes ?? []).reduce(
    (total, runtime) => total + runtime.devices,
    0
  )
}

/**
 * Devices on this build. Scoped to channels when given, because a channel
 * card must not count staging devices against what production serves.
 */
export function deviceCount(
  metrics: Metrics | undefined,
  platform: Platform,
  runtimeVersion: string,
  channels?: ReadonlyArray<string>
): number {
  return (metrics?.runtimes ?? [])
    .filter(
      (runtime) =>
        runtime.platform === platform &&
        runtime.runtimeVersion === runtimeVersion &&
        (channels === undefined || channels.includes(runtime.channel))
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
  return (metrics?.updates ?? [])
    .filter((entry) => entry.updateId === updateId)
    .reduce((total, entry) => total + entry.running, 0)
}

// Floored, like the health badge: 100 percent means every device it targets is
// on it, not that the last few rounded away.
const percentOf = (running: number, base: number): number =>
  base === 0 ? 0 : Math.floor((running / base) * 100)

export function adoption(
  metrics: Metrics | undefined,
  update: Update,
  channels?: ReadonlyArray<string>
): Adoption {
  // Both halves take the same channel scope, or a device on another channel
  // running this update would count against a population it is not part of.
  const counts = (metrics?.updates ?? []).filter(
    (entry) =>
      entry.updateId === update.id &&
      (channels === undefined || channels.includes(entry.channel))
  )
  const devices = deviceCount(
    metrics,
    update.platform,
    update.runtimeVersion,
    channels
  )
  const total = (of: (entry: (typeof counts)[number]) => number) =>
    counts.reduce((sum, entry) => sum + of(entry), 0)
  const running = total((entry) => entry.running)
  const served = total((entry) => entry.served)
  // A bundle is offered to everything on its runtime; a rollback only to the
  // devices it directed, so a fresh install that never needed directing cannot
  // dilute it.
  const basis: AdoptionBasis =
    update.kind === "rollback" ? "directed" : "runtime"
  const base = basis === "directed" ? served : devices
  return {
    running,
    served,
    faulty: total((entry) => entry.faulty),
    devices,
    base,
    basis,
    percent: percentOf(running, base),
  }
}

/**
 * One figure for a whole group: the parts summed, each against its own
 * population, so a rollback on one platform and a bundle on the other are not
 * forced to share a denominator.
 */
export function combineAdoption(parts: ReadonlyArray<Adoption>): Adoption {
  const sum = (of: (part: Adoption) => number) =>
    parts.reduce((total, part) => total + of(part), 0)
  const bases = new Set(parts.map((part) => part.basis))
  const running = sum((part) => part.running)
  const base = sum((part) => part.base)
  // One basis if the parts agree on it, "runtime" for a group with no updates.
  const basis: AdoptionBasis =
    bases.size > 1 ? "mixed" : ([...bases][0] ?? "runtime")
  return {
    running,
    served: sum((part) => part.served),
    faulty: sum((part) => part.faulty),
    devices: sum((part) => part.devices),
    base,
    basis,
    percent: percentOf(running, base),
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
