import { HugeiconsIcon } from "@hugeicons/react"
import { Alert02Icon, InformationCircleIcon } from "@hugeicons/core-free-icons"

import { DashboardApiError } from "@/lib/api"
import { relativeTime } from "@/lib/format"
import { cn } from "@/lib/utils"
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

/**
 * Something inside a card that needs a hand, said in the card's own voice: a
 * tinted band between the header and the table, never a box inside the box.
 */
export function CardNotice({
  title,
  description,
  action,
  variant = "default",
}: {
  readonly title: string
  readonly description?: string
  readonly action?: React.ReactNode
  readonly variant?: "default" | "destructive"
}) {
  return (
    <div
      role={variant === "destructive" ? "alert" : "status"}
      className={cn(
        "flex flex-wrap items-center gap-x-4 gap-y-2 border-b px-4 py-2.5 text-sm",
        enters,
        variant === "destructive"
          ? "bg-destructive/5 text-destructive"
          : "bg-muted/40 text-foreground"
      )}
    >
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="font-medium">{title}</span>
        {description ? (
          <span
            className={cn(
              "text-pretty",
              variant === "destructive"
                ? "text-destructive/80"
                : "text-muted-foreground"
            )}
          >
            {description}
          </span>
        ) : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  )
}
