import { useIsFetching, useQueryClient } from "@tanstack/react-query"
import { HugeiconsIcon } from "@hugeicons/react"
import { ArrowReloadHorizontalIcon } from "@hugeicons/core-free-icons"

import { Button } from "@/components/ui/button"
import { ThemeToggle } from "@/components/theme-toggle"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"

/** Re-reads everything, for the minute after a publish when numbers are moving. */
export function NavActions() {
  const queryClient = useQueryClient()
  const fetching = useIsFetching() > 0

  return (
    <div className="flex items-center gap-1">
      <ThemeToggle />
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Refresh"
              onClick={() => queryClient.invalidateQueries()}
            />
          }
        >
          <HugeiconsIcon
            icon={ArrowReloadHorizontalIcon}
            strokeWidth={2}
            className={fetching ? "animate-spin" : undefined}
          />
        </TooltipTrigger>
        <TooltipContent>Refresh</TooltipContent>
      </Tooltip>
    </div>
  )
}
