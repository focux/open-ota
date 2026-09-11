import { describe, expect, it } from "vitest"

import type { DeviceCheck } from "@/lib/api"
import { explainCheck, explainDevice, timesChecked } from "@/lib/devices"

const check = (overrides: Partial<DeviceCheck> = {}): DeviceCheck => ({
  firstCheckedAt: "2026-09-10T10:00:00.000Z",
  lastCheckedAt: "2026-09-10T10:05:00.000Z",
  checks: 1,
  platform: "ios",
  runtimeVersion: "3f2a9c11d4",
  channel: "production",
  currentUpdateId: null,
  embeddedUpdateId: null,
  decision: "none",
  reason: "no-update-for-runtime",
  servedUpdateId: null,
  fatalError: null,
  ...overrides,
})

describe("explaining a check", () => {
  it("names the runtime a branch has nothing for", () => {
    const explained = explainCheck(check())
    expect(explained.summary).toBe(
      "Nothing to serve: the branch has no update for runtime 3f2a9c11…"
    )
    expect(explained.served).toBe(false)
  })

  it("names the channel nothing is linked to", () => {
    expect(
      explainCheck(check({ reason: "unknown-channel" })).summary
    ).toContain("channel production")
  })

  it("names the update a served check handed over", () => {
    const explained = explainCheck(
      check({
        decision: "manifest",
        reason: "manifest",
        servedUpdateId: "abcdef00-0000-4000-8000-000000000000",
      })
    )
    expect(explained.summary).toBe("Served update abcdef00")
    expect(explained.served).toBe(true)
  })

  it("says something about every reason the server can give", () => {
    const reasons = [
      "manifest",
      "rollback",
      "unknown-channel",
      "no-update-for-runtime",
      "rollout-excluded",
      "already-current",
      "already-embedded",
    ] as const
    for (const reason of reasons) {
      const explained = explainCheck(check({ reason }))
      expect(explained.summary.length).toBeGreaterThan(0)
      expect(explained.detail.length).toBeGreaterThan(0)
    }
  })

  it("reads a device by its newest answer, and says nothing when it has none", () => {
    expect(explainDevice([])).toBeNull()
    expect(
      explainDevice([check({ reason: "already-current" }), check()])?.summary
    ).toBe("Nothing to serve: already running the newest update")
  })

  it("counts a run of identical answers", () => {
    expect(timesChecked(1)).toBe("once")
    expect(timesChecked(1200)).toBe("1,200 times")
  })
})
