import { cn } from "@/lib/utils"

/**
 * A framed region: a tinted outer surface that carries the title and the
 * controls, and a white panel inset by a small gutter that carries the
 * content. The radii are concentric (16 outside, 6 gutter, 12 inside: outer
 * minus gutter plus two, so the inner corner reads as soft as the outer), so the
 * nesting reads as chrome around content rather than a box inside a box.
 */
export function Frame({
  className,
  ...props
}: React.ComponentProps<"section">) {
  return (
    <section
      data-slot="frame"
      className={cn(
        "flex flex-col rounded-2xl bg-muted/60 p-1.5 text-sm shadow-recessed dark:bg-muted/25",
        className
      )}
      {...props}
    />
  )
}

/** Title, one line under it, and whatever acts on the region, on the frame itself. */
export function FrameHeader({
  title,
  description,
  action,
  className,
}: {
  readonly title: React.ReactNode
  readonly description?: React.ReactNode
  readonly action?: React.ReactNode
  readonly className?: string
}) {
  return (
    <div
      data-slot="frame-header"
      className={cn(
        "flex flex-wrap items-start justify-between gap-x-4 gap-y-1 px-2.5 pt-1.5 pb-2.5",
        className
      )}
    >
      <div className="flex min-w-0 flex-col gap-0.5">
        <h2 className="font-heading text-base leading-snug font-medium text-balance">
          {title}
        </h2>
        {description ? (
          <p className="text-sm text-pretty text-muted-foreground">
            {description}
          </p>
        ) : null}
      </div>
      {action ? (
        <div className="flex shrink-0 items-center gap-2">{action}</div>
      ) : null}
    </div>
  )
}

/** The white content panel. Tables sit flush; anything else gets `p-4`. */
export function FramePanel({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="frame-panel"
      className={cn(
        "overflow-hidden rounded-xl bg-card text-card-foreground shadow-raised",
        className
      )}
      {...props}
    />
  )
}

/** A white tile inside a frame that holds several, all on the same gutter. */
export function FrameTile({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="frame-tile"
      className={cn(
        "flex flex-col gap-3 rounded-xl bg-card p-4 text-card-foreground shadow-raised",
        className
      )}
      {...props}
    />
  )
}
