import { useQuery, useQueryClient } from "@tanstack/react-query"
import { HugeiconsIcon } from "@hugeicons/react"
import { Alert02Icon } from "@hugeicons/core-free-icons"

import {
  metricsQueryOptions,
  overviewQueryOptions,
  useHydrated,
} from "@/lib/queries"
import { isUnreachable } from "@/components/feedback"
import {
  Alert,
  AlertAction,
  AlertDescription,
  AlertTitle,
} from "@/components/ui/alert"
import { Button } from "@/components/ui/button"

/**
 * One message when the server is not answering at all, so pages do not each
 * grow their own. Reads the two root queries, which every page shares, so
 * this subscribes to the cache without fetching anything extra.
 */
export function UnreachableBanner() {
  const hydrated = useHydrated()
  const queryClient = useQueryClient()
  const overview = useQuery({ ...overviewQueryOptions, enabled: hydrated })
  const metrics = useQuery({ ...metricsQueryOptions, enabled: hydrated })
  const error = [overview.error, metrics.error].find(isUnreachable)
  if (!(error instanceof Error)) return null

  return (
    <Alert
      variant="destructive"
      className="animate-in duration-180 ease-[cubic-bezier(0.23,1,0.32,1)] fade-in-0 slide-in-from-top-1"
    >
      <HugeiconsIcon icon={Alert02Icon} strokeWidth={2} />
      <AlertTitle>The dashboard can't reach the updates server.</AlertTitle>
      <AlertDescription className="text-pretty">
        {error.message}
      </AlertDescription>
      <AlertAction>
        <Button
          variant="outline"
          size="sm"
          onClick={() => queryClient.invalidateQueries()}
        >
          Retry
        </Button>
      </AlertAction>
    </Alert>
  )
}
