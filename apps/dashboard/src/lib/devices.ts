import type { DeviceCheck } from "@/lib/api"
import { shortId } from "@/lib/format"

/**
 * What one answer meant, in the words support would use with the person
 * holding the phone. The summary names the values behind the decision, since
 * "no update for that runtime" is only actionable once you can see which
 * runtime; the detail says what to do about it.
 */
export interface Explained {
  readonly summary: string
  readonly detail: string
  /** Whether the device was given something. Drives the row's tone. */
  readonly served: boolean
}

const details: Record<DeviceCheck["reason"], string> = {
  manifest:
    "The device downloads it next, then runs it after a full relaunch. Until then it is served but not yet running.",
  rollback:
    "The server told it to go back to the JavaScript built into its native binary. It reports that bundle's own id afterwards.",
  "unknown-channel":
    "No branch is linked to the channel this build asks for. Link that channel to a branch, or ship a binary built for a channel that exists.",
  "no-update-for-runtime":
    "The runtime version comes from the native binary and nothing published on this branch targets it. Publishing for this runtime, or a new binary, is what reaches this device.",
  "rollout-excluded":
    "The newest update is on a partial rollout and this device is outside it, with nothing older to fall back to. Expected: raise the rollout to include it.",
  "already-current":
    "Nothing is wrong. The device is already running the newest update this branch serves.",
  "already-embedded":
    "The device already carried out the rollback and is back on its built-in JavaScript, so the directive stopped being sent.",
}

export function explainCheck(check: DeviceCheck): Explained {
  const runtime = shortId(check.runtimeVersion)
  const summaries: Record<DeviceCheck["reason"], string> = {
    manifest: `Served update ${shortId(check.servedUpdateId ?? "")}`,
    rollback: "Told to roll back to the built-in JavaScript",
    "unknown-channel": `Nothing to serve: no branch is linked to channel ${check.channel}`,
    "no-update-for-runtime": `Nothing to serve: the branch has no update for runtime ${runtime}…`,
    "rollout-excluded": "Nothing to serve: held back by a partial rollout",
    "already-current": "Nothing to serve: already running the newest update",
    "already-embedded":
      "Nothing to serve: already back on the built-in JavaScript",
  }
  return {
    summary: summaries[check.reason],
    detail: details[check.reason],
    served: check.decision !== "none",
  }
}

/**
 * The one line to read first on a device: the newest answer it got, or that it
 * has never been heard from, which is its own answer.
 */
export function explainDevice(
  checks: ReadonlyArray<DeviceCheck>
): Explained | null {
  return checks.length === 0 ? null : explainCheck(checks[0])
}

/** "once", "8 times": a run of identical answers, counted. */
export function timesChecked(checks: number): string {
  return checks === 1 ? "once" : `${checks.toLocaleString()} times`
}

/** What the count means, since repeats inside the write window are skipped. */
export const recordedNote =
  "Recorded on the first check of each minute, so a device polling faster counts once per minute."
