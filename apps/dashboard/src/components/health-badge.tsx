import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"

/** Share of devices that launched an update instead of crashing back off it. */
export function HealthBadge({
  healthy,
  faulty,
}: {
  readonly healthy: number
  readonly faulty: number
}) {
  const total = healthy + faulty
  if (total === 0) {
    return (
      <Badge variant="outline" className="text-muted-foreground">
        <Dot className="bg-muted-foreground/40" />
        no data
      </Badge>
    )
  }

  // Floored, so 100 percent means not one device crashed off it.
  const percent = Math.floor((healthy / total) * 100)
  const tone =
    percent >= 98
      ? "bg-emerald-500"
      : percent >= 90
        ? "bg-amber-500"
        : "bg-red-500"

  return (
    <Tooltip>
      <TooltipTrigger
        render={<Badge variant="outline" className="tabular-nums" />}
      >
        <Dot className={tone} />
        {percent}%
      </TooltipTrigger>
      <TooltipContent>
        {healthy} healthy, {faulty} faulty
      </TooltipContent>
    </Tooltip>
  )
}

function Dot({ className }: { readonly className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn("size-1.5 shrink-0 rounded-full", className)}
    />
  )
}
