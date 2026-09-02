import { Link, createFileRoute } from "@tanstack/react-router"
import { useQueries, useQuery } from "@tanstack/react-query"

import type { Group } from "@/lib/api"
import { relativeTime } from "@/lib/format"
import {
  branchSummaryQueryOptions,
  overviewQueryOptions,
  useHydrated,
} from "@/lib/queries"
import { ErrorState, StaleStrip, isUnreachable } from "@/components/feedback"
import { PageHeader } from "@/components/page-header"
import { TableSkeleton } from "@/components/page-state"
import { Card, CardContent } from "@/components/ui/card"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"

export const Route = createFileRoute("/_dashboard/branches/")({
  component: BranchesPage,
})

const pageSize = 50

// Hoisted so React Query sees the same function on every render.
function combineGroups(
  results: ReadonlyArray<{
    readonly data?: { readonly groups: ReadonlyArray<Group> }
  }>
): ReadonlyArray<ReadonlyArray<Group> | undefined> {
  return results.map((result) => result.data?.groups)
}

function BranchesPage() {
  const hydrated = useHydrated()
  const overview = useQuery({ ...overviewQueryOptions, enabled: hydrated })
  const branches = overview.data?.branches ?? []

  const summaries = useQueries({
    queries: branches.map((branch) => ({
      ...branchSummaryQueryOptions(branch),
      enabled: hydrated,
    })),
    combine: combineGroups,
  })

  if (isUnreachable(overview.error)) return null

  const header = (
    <PageHeader
      title="Branches"
      subtitle="Which streams of update groups exist, and what is on them?"
    />
  )

  if (overview.isError && overview.data === undefined) {
    return (
      <>
        {header}
        <ErrorState
          thing="branches"
          error={overview.error}
          onRetry={() => void overview.refetch()}
        />
      </>
    )
  }

  return (
    <>
      {header}
      {overview.isError && overview.data !== undefined && (
        <StaleStrip
          updatedAt={overview.dataUpdatedAt}
          onRetry={() => void overview.refetch()}
        />
      )}
      <Card>
        <CardContent className="p-0">
          {overview.isPending ? (
            <TableSkeleton
              widths={["w-32", "w-48", "w-10"]}
              rowClassName="h-12"
            />
          ) : branches.length === 0 ? (
            <div className="p-(--card-spacing)">
              <Empty>
                <EmptyHeader>
                  <EmptyTitle>No branches yet</EmptyTitle>
                  <EmptyDescription className="text-pretty">
                    A branch is created by the first publish that names it.
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="min-w-52 pl-(--card-spacing) text-xs text-muted-foreground">
                    Branch
                  </TableHead>
                  <TableHead className="min-w-72 text-xs text-muted-foreground">
                    Latest update
                  </TableHead>
                  <TableHead className="w-24 pr-(--card-spacing) text-right text-xs text-muted-foreground">
                    Groups
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody className="[&_tr:last-child]:border-0">
                {branches.map((branch, index) => {
                  const groups = summaries[index]
                  const newest = groups?.[0]
                  const linked = (overview.data?.channels ?? []).filter(
                    (channel) => channel.branch === branch
                  )
                  return (
                    <TableRow key={branch} className="h-12">
                      <TableCell className="pl-(--card-spacing)">
                        <Link
                          to="/branches/$name"
                          params={{ name: branch }}
                          className="flex flex-col gap-0.5 rounded-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
                        >
                          <span className="font-medium underline-offset-4 hover:underline">
                            {branch}
                          </span>
                          <span className="text-xs text-muted-foreground">
                            {linked.length === 0
                              ? "Not linked"
                              : linked
                                  .map((channel) => channel.name)
                                  .join(", ")}
                          </span>
                        </Link>
                      </TableCell>
                      <TableCell>
                        {newest === undefined ? (
                          <span className="text-muted-foreground">none</span>
                        ) : (
                          <span className="flex max-w-96 flex-col gap-0.5">
                            <span className="truncate">
                              {newest.message ?? (
                                <span className="text-muted-foreground italic">
                                  Untitled update
                                </span>
                              )}
                            </span>
                            <span className="text-xs text-muted-foreground">
                              {relativeTime(newest.createdAt)}
                            </span>
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="pr-(--card-spacing) text-right tabular-nums">
                        {groups === undefined
                          ? "no data"
                          : `${groups.length}${groups.length === pageSize ? "+" : ""}`}
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </>
  )
}
