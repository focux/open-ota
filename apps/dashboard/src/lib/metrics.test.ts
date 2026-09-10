import { describe, expect, it } from "vitest"

import type { Metrics, Update } from "@/lib/api"
import {
  adoption,
  combineAdoption,
  driftedRuntimes,
  figuresAdoption,
  linkedChannels,
  runtimeVersionCount,
  segmentsFor,
} from "@/lib/metrics"

const metrics: Metrics = {
  online: 12,
  runtimes: [
    {
      channel: "staging",
      platform: "ios",
      runtimeVersion: "fp-a",
      devices: 30,
    },
    {
      channel: "production",
      platform: "ios",
      runtimeVersion: "fp-a",
      devices: 10,
    },
    {
      channel: "staging",
      platform: "android",
      runtimeVersion: "fp-b",
      devices: 10,
    },
    {
      channel: "production",
      platform: "ios",
      runtimeVersion: "fp-old",
      devices: 3,
    },
  ],
  updates: [
    { updateId: "u1", channel: "staging", running: 30, served: 36, faulty: 2 },
  ],
  failures: [{ updateId: "u1", message: "TypeError", devices: 2 }],
  countries: [{ country: "CA", devices: 40 }],
  segments: [
    { updateId: "u1", country: "CA", running: 20, faulty: 1 },
    { updateId: "u2", country: "CA", running: 5, faulty: 0 },
    { updateId: "u1", country: "US", running: 10, faulty: 1 },
  ],
}

const update = {
  kind: "rollback",
  id: "u1",
  groupId: "g1",
  branch: "staging",
  platform: "ios",
  runtimeVersion: "fp-a",
  rolloutPercent: 100,
  createdAt: "2026-09-01T00:00:00.000Z",
} satisfies Update

const bundleUpdate = {
  ...update,
  kind: "bundle",
  launchAsset: {
    hash: "h",
    key: "k",
    contentType: "application/javascript",
  },
  assets: [],
  expoConfig: {},
} satisfies Update

describe("adoption", () => {
  it("reads running, served and faulty against the devices on that runtime", () => {
    expect(adoption(metrics, update)).toEqual({
      running: 30,
      served: 36,
      faulty: 2,
      // 30 on staging plus 10 on production, both on this build.
      devices: 40,
      elsewhere: 0,
      // Rollbacks divide by directed devices, so fresh installs that never
      // needed directing cannot dilute them.
      base: 36,
      basis: "directed",
      percent: 83,
    })
  })

  it("divides bundles by every device on the runtime", () => {
    expect(adoption(metrics, bundleUpdate)).toEqual({
      running: 30,
      served: 36,
      faulty: 2,
      devices: 40,
      elsewhere: 0,
      base: 40,
      basis: "runtime",
      percent: 75,
    })
  })

  it("reports zero rather than dividing by no devices", () => {
    expect(
      adoption(metrics, { ...bundleUpdate, runtimeVersion: "fp-none" })
    ).toEqual({
      running: 30,
      served: 36,
      faulty: 2,
      devices: 0,
      elsewhere: 0,
      base: 0,
      basis: "runtime",
      percent: 0,
    })
  })

  it("divides rollbacks by directed devices even with none on the runtime", () => {
    expect(adoption(metrics, { ...update, runtimeVersion: "fp-none" })).toEqual(
      {
        running: 30,
        served: 36,
        faulty: 2,
        devices: 0,
        elsewhere: 0,
        base: 36,
        basis: "directed",
        percent: 83,
      }
    )
  })
})

describe("driftedRuntimes", () => {
  it("only strands devices on the channels asked about", () => {
    expect(
      driftedRuntimes(metrics, ["staging"], [update]).map(
        (runtime) => runtime.runtimeVersion
      )
    ).toEqual(["fp-b"])
  })

  it("ignores a runtime the channel's branch does serve", () => {
    expect(driftedRuntimes(metrics, ["production"], [update])).toEqual([
      {
        channel: "production",
        platform: "ios",
        runtimeVersion: "fp-old",
        devices: 3,
      },
    ])
  })

  it("reads every channel it is given", () => {
    expect(
      driftedRuntimes(metrics, ["staging", "production"], [update]).map(
        (runtime) => runtime.runtimeVersion
      )
    ).toEqual(["fp-b", "fp-old"])
  })
})

describe("runtimeVersionCount", () => {
  it("counts platform and runtime pairs, not channel rows", () => {
    expect(runtimeVersionCount(metrics)).toBe(3)
  })
})

describe("linkedChannels", () => {
  const channels = [
    { name: "staging", branch: "staging", updatedAt: "2026-09-01T00:00:00Z" },
    {
      name: "production",
      branch: "production",
      updatedAt: "2026-09-01T00:00:00Z",
    },
    { name: "beta", branch: "production", updatedAt: "2026-09-01T00:00:00Z" },
  ]

  it("names every channel that points at the branch", () => {
    expect(linkedChannels(channels, "production")).toEqual([
      "production",
      "beta",
    ])
  })

  it("is empty for a branch nothing points at, so its population is zero", () => {
    expect(linkedChannels(channels, "early-access")).toEqual([])
  })

  it("stays undefined while the channels are unknown", () => {
    expect(linkedChannels(undefined, "production")).toBeUndefined()
  })
})

describe("adoption across channels", () => {
  // Two channels can point at the same branch, so the same update is served on
  // both. u1 runs on 30 staging devices and 10 production ones.
  const shared: Metrics = {
    ...metrics,
    updates: [
      ...metrics.updates,
      {
        updateId: "u1",
        channel: "production",
        running: 10,
        served: 10,
        faulty: 0,
      },
    ],
  }

  it("counts every channel when given none", () => {
    expect(adoption(shared, bundleUpdate)).toMatchObject({
      running: 40,
      served: 46,
      faulty: 2,
      devices: 40,
      elsewhere: 0,
      percent: 100,
    })
  })

  it("counts only the channels it divides by", () => {
    // 30 of the 30 staging devices, not 40 of them.
    expect(adoption(shared, bundleUpdate, ["staging"])).toMatchObject({
      running: 30,
      served: 36,
      faulty: 2,
      devices: 30,
      elsewhere: 0,
      percent: 100,
    })
  })
})

describe("figuresAdoption", () => {
  const figures = {
    updateId: "u2",
    running: 3,
    served: 4,
    faulty: 1,
    elsewhere: 1,
    population: 4,
  }

  it("reads the server's figures and divides only the reached devices by the population", () => {
    // Three run it, but one moved to another channel: 2 of 4 reached.
    expect(figuresAdoption({ ...bundleUpdate, figures })).toEqual({
      running: 3,
      served: 4,
      faulty: 1,
      devices: 4,
      elsewhere: 1,
      base: 4,
      basis: "runtime",
      percent: 50,
    })
  })

  it("divides a rollback by the devices it directed", () => {
    expect(
      figuresAdoption({ ...update, figures: { ...figures, running: 2 } })
    ).toMatchObject({ basis: "directed", base: 4, percent: 25 })
  })

  it("is undefined for an update read without figures", () => {
    expect(figuresAdoption(bundleUpdate)).toBeUndefined()
  })
})

describe("combineAdoption", () => {
  it("keeps one basis when every part shares it", () => {
    expect(combineAdoption([adoption(metrics, bundleUpdate)])).toMatchObject({
      base: 40,
      basis: "runtime",
      percent: 75,
    })
  })

  it("sums each part against its own population when they differ", () => {
    expect(
      combineAdoption([
        adoption(metrics, update),
        adoption(metrics, bundleUpdate),
      ])
    ).toEqual({
      running: 60,
      served: 72,
      faulty: 4,
      devices: 80,
      elsewhere: 0,
      // The rollback brings the 36 it directed, the bundle all 40 on its
      // runtime; neither is forced onto the other's denominator.
      base: 76,
      basis: "mixed",
      // Floored: 60 of 76 is 78.9, and the last percent is not earned yet.
      percent: 78,
    })
  })

  it("reports nothing for a group with no updates", () => {
    expect(combineAdoption([])).toEqual({
      running: 0,
      served: 0,
      faulty: 0,
      devices: 0,
      elsewhere: 0,
      base: 0,
      basis: "runtime",
      percent: 0,
    })
  })
})

describe("segmentsFor", () => {
  it("keeps only this group's updates, summed per country, busiest first", () => {
    expect(segmentsFor(metrics, [update])).toEqual([
      { country: "CA", running: 20, faulty: 1 },
      { country: "US", running: 10, faulty: 1 },
    ])
  })
})
