const relative = new Intl.RelativeTimeFormat("en", { numeric: "auto" })

const units: ReadonlyArray<readonly [Intl.RelativeTimeFormatUnit, number]> = [
  ["year", 365 * 24 * 60 * 60_000],
  ["month", 30 * 24 * 60 * 60_000],
  ["day", 24 * 60 * 60_000],
  ["hour", 60 * 60_000],
  ["minute", 60_000],
]

/** Update ids are uuids; eight characters is enough to tell two apart. */
export function shortId(id: string): string {
  return id.slice(0, 8)
}

export function relativeTime(iso: string, now = Date.now()): string {
  const elapsed = Date.parse(iso) - now
  if (Number.isNaN(elapsed)) return iso
  for (const [unit, size] of units) {
    if (Math.abs(elapsed) >= size) {
      return relative.format(Math.round(elapsed / size), unit)
    }
  }
  return relative.format(Math.round(elapsed / 1000), "second")
}

export function absoluteTime(iso: string): string {
  const parsed = new Date(iso)
  return Number.isNaN(parsed.getTime()) ? iso : parsed.toLocaleString()
}

/** ISO 3166-1 alpha-2 to its flag, which is the two letters as regional indicators. */
export function flagEmoji(country: string): string {
  if (!/^[A-Za-z]{2}$/.test(country)) return ""
  return String.fromCodePoint(
    ...[...country.toUpperCase()].map(
      (letter) => 0x1f1e6 + letter.charCodeAt(0) - 65
    )
  )
}

/** "1 device", "8 devices". Pass `many` for a noun that does not take an s. */
export function plural(count: number, noun: string, many?: string): string {
  return `${count.toLocaleString()} ${count === 1 ? noun : (many ?? `${noun}s`)}`
}
