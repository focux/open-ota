import { HugeiconsIcon } from "@hugeicons/react"
import { Alert02Icon, InformationCircleIcon } from "@hugeicons/core-free-icons"

import { DashboardApiError } from "@/lib/api"
import { relativeTime } from "@/lib/format"
import {
  Alert,
  AlertAction,
  AlertDescription,
  AlertTitle,
} from "@/components/ui/alert"
import { Button } from "@/components/ui/button"

/** Alerts arrive rather than appear: opacity and 4px, gone in 180ms. */
const enters =
  "duration-180 ease-[cubic-bezier(0.23,1,0.32,1)] animate-in fade-in-0 slide-in-from-top-1"

export function isUnreachable(error: unknown): boolean {
  return error instanceof DashboardApiError && error.kind === "unreachable"
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * A region that could not load. One of these replaces the region's content,
 * never one per row or per card.
 */
export function ErrorState({
  thing,
  error,
  onRetry,
}: {
  readonly thing: string
  readonly error: unknown
  readonly onRetry?: () => void
}) {
  return (
    <Alert variant="destructive" className={enters}>
      <HugeiconsIcon icon={Alert02Icon} strokeWidth={2} />
      <AlertTitle>Couldn't load {thing}</AlertTitle>
      <AlertDescription className="text-pretty">
        {messageOf(error)}
      </AlertDescription>
      {onRetry ? (
        <AlertAction>
          <Button variant="outline" size="sm" onClick={onRetry}>
            Try again
          </Button>
        </AlertAction>
      ) : null}
    </Alert>
  )
}

/** A refetch failed but the data is still on screen, so it is only aging. */
export function StaleStrip({
  updatedAt,
  onRetry,
}: {
  readonly updatedAt: number
  readonly onRetry: () => void
}) {
  return (
    <Alert className={enters}>
      <HugeiconsIcon icon={InformationCircleIcon} strokeWidth={2} />
      <AlertTitle>
        Showing data from {relativeTime(new Date(updatedAt).toISOString())}
      </AlertTitle>
      <AlertAction>
        <Button variant="outline" size="sm" onClick={onRetry}>
          Try again
        </Button>
      </AlertAction>
    </Alert>
  )
}

/** An action the server refused. Lives inside the dialog, above its footer. */
export function DialogError({ error }: { readonly error: unknown }) {
  if (error === null || error === undefined) return null
  return (
    <Alert variant="destructive" className={enters}>
      <HugeiconsIcon icon={Alert02Icon} strokeWidth={2} />
      <AlertTitle>The updates server refused this</AlertTitle>
      <AlertDescription className="text-pretty">
        {messageOf(error)}
      </AlertDescription>
    </Alert>
  )
}

/** Everything wrong with the state of the world on this page, in one place. */
export function Warnings({
  title,
  items,
}: {
  readonly title: string
  readonly items: ReadonlyArray<string>
}) {
  if (items.length === 0) return null
  const shown = items.slice(0, 3)
  return (
    <Alert className={enters}>
      <HugeiconsIcon icon={Alert02Icon} strokeWidth={2} />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription className="text-pretty">
        {shown.join(", ")}
        {items.length > shown.length &&
          `, and ${items.length - shown.length} more`}
      </AlertDescription>
    </Alert>
  )
}
