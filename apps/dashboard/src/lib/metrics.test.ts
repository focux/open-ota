import { describe, expect, it } from "vitest"

import type { Metrics, Update } from "@/lib/api"
import {
  adoption,
  driftedRuntimes,
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
  updates: [{ updateId: "u1", running: 30, served: 36, faulty: 2 }],
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

describe("adoption", () => {
  it("reads running, served and faulty against the devices on that runtime", () => {
    expect(adoption(metrics, update)).toEqual({
      running: 30,
      served: 36,
      faulty: 2,
      // 30 on staging plus 10 on production, both on this build.
      devices: 40,
      percent: 75,
    })
  })

  it("reports zero rather than dividing by no devices", () => {
    expect(adoption(metrics, { ...update, runtimeVersion: "fp-none" })).toEqual(
      {
        running: 30,
        served: 36,
        faulty: 2,
        devices: 0,
        percent: 0,
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

describe("segmentsFor", () => {
  it("keeps only this group's updates, summed per country, busiest first", () => {
    expect(segmentsFor(metrics, [update])).toEqual([
      { country: "CA", running: 20, faulty: 1 },
      { country: "US", running: 10, faulty: 1 },
    ])
  })
})
