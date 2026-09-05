import { Frame, FramePanel, FrameTile } from "@/components/frame"
import { Skeleton } from "@/components/ui/skeleton"

/**
 * A loading table keeps the real row height and column widths, so nothing
 * jumps when the data lands.
 */
export function TableSkeleton({
  widths,
  rows = 5,
  rowClassName = "h-14",
}: {
  readonly widths: ReadonlyArray<string>
  readonly rows?: number
  readonly rowClassName?: string
}) {
  return (
    <div className="flex flex-col">
      <div className="flex h-10 items-center gap-6 border-b px-4">
        {widths.map((width, column) => (
          <Skeleton key={column} className={`h-3 w-12 ${width}`} />
        ))}
      </div>
      {Array.from({ length: rows }, (_, row) => (
        <div
          key={row}
          className={`flex items-center gap-6 border-b px-4 last:border-0 ${rowClassName}`}
        >
          {widths.map((width, column) => (
            <Skeleton key={column} className={`h-4 ${width}`} />
          ))}
        </div>
      ))}
    </div>
  )
}

/** The stat row's shape: label, number, one line of explanation. */
export function StatSkeleton({ count }: { readonly count: number }) {
  return Array.from({ length: count }, (_, index) => (
    <FrameTile key={index}>
      <span className="flex items-start justify-between gap-2">
        <Skeleton className="size-9 rounded-lg" />
        <Skeleton className="size-3.5 rounded-full" />
      </span>
      <div className="flex flex-col gap-2">
        <Skeleton className="h-3.5 w-24" />
        <Skeleton className="h-6 w-16" />
      </div>
    </FrameTile>
  ))
}

export function CardSkeleton({
  count,
  widths,
  rows = 3,
}: {
  readonly count: number
  readonly widths: ReadonlyArray<string>
  readonly rows?: number
}) {
  return Array.from({ length: count }, (_, index) => (
    <Frame key={index}>
      <div className="flex flex-col gap-1.5 px-2.5 pt-2 pb-3">
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-3 w-56" />
      </div>
      <FramePanel>
        <TableSkeleton widths={widths} rows={rows} />
      </FramePanel>
    </Frame>
  ))
}
