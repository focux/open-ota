import { Card, CardContent, CardHeader } from "@/components/ui/card"
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
      <div className="flex h-10 items-center gap-6 border-b px-(--card-spacing)">
        {widths.map((width, column) => (
          <Skeleton key={column} className={`h-3 w-12 ${width}`} />
        ))}
      </div>
      {Array.from({ length: rows }, (_, row) => (
        <div
          key={row}
          className={`flex items-center gap-6 border-b px-(--card-spacing) last:border-0 ${rowClassName}`}
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
    <Card key={index} size="sm">
      <CardContent className="flex flex-col gap-2">
        <span className="flex items-center justify-between gap-2">
          <Skeleton className="h-3 w-20" />
          <Skeleton className="size-3.5 rounded-full" />
        </span>
        <Skeleton className="h-6 w-16" />
      </CardContent>
    </Card>
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
    <Card key={index}>
      <CardHeader className="border-b">
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-3 w-56" />
      </CardHeader>
      <CardContent className="p-0">
        <TableSkeleton widths={widths} rows={rows} />
      </CardContent>
    </Card>
  ))
}
