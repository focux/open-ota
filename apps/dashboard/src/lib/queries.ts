import { useSyncExternalStore } from "react"
import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query"

import { api } from "@/lib/api"

/** Every query key in one place, so invalidation cannot drift from the reads. */
export const queryKeys = {
  overview: ["overview"] as const,
  metrics: ["metrics"] as const,
  groups: (branch: string) => ["groups", branch] as const,
  branchSummary: (branch: string) => ["branch-summary", branch] as const,
  rollbackPlan: (branch: string) => ["rollback-plan", branch] as const,
  group: (id: string) => ["group", id] as const,
}

const groupsPageSize = 50

export const overviewQueryOptions = queryOptions({
  queryKey: queryKeys.overview,
  queryFn: api.overview,
})

export const metricsQueryOptions = queryOptions({
  queryKey: queryKeys.metrics,
  queryFn: api.metrics,
})

export const groupQueryOptions = (id: string) =>
  queryOptions({
    queryKey: queryKeys.group(id),
    queryFn: () => api.group(id),
  })

/** The newest page of a branch, for the branches index. */
export const branchSummaryQueryOptions = (branch: string) =>
  queryOptions({
    queryKey: queryKeys.branchSummary(branch),
    queryFn: () => api.groups(branch),
  })

/** What each build the branch serves would go back to. Read when a dialog opens. */
export const rollbackPlanQueryOptions = (branch: string) =>
  queryOptions({
    queryKey: queryKeys.rollbackPlan(branch),
    queryFn: () => api.rollbackPlan(branch),
  })

/** Groups are newest first; the next page starts before the oldest one loaded. */
export const groupsQueryOptions = (branch: string) =>
  infiniteQueryOptions({
    queryKey: queryKeys.groups(branch),
    queryFn: ({ pageParam }) => api.groups(branch, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) =>
      page.groups.length < groupsPageSize
        ? undefined
        : page.groups[page.groups.length - 1]?.createdAt,
  })

// Defined once at module scope: useSyncExternalStore resubscribes whenever the
// subscribe identity changes, and inline arrows change on every render.
const neverChanges = () => () => {}
const hydrated = () => true
const notHydrated = () => false

/**
 * False during server rendering and the hydration pass, true afterwards.
 * Reads gated on it start only after hydration, so the first client render
 * always matches the prerendered HTML.
 */
export function useHydrated() {
  return useSyncExternalStore(neverChanges, hydrated, notHydrated)
}
