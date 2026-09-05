import { Link, createFileRoute } from "@tanstack/react-router"
import { HugeiconsIcon } from "@hugeicons/react"
import { GitBranchIcon } from "@hugeicons/core-free-icons"
import { useQueries, useQuery } from "@tanstack/react-query"

import { relativeTime, plural } from "@/lib/format"
import {
  branchSummaryQueryOptions,
  overviewQueryOptions,
  useHydrated,
} from "@/lib/queries"
import { ErrorState, StaleStrip, isUnreachable } from "@/components/feedback"
import { PageHeader } from "@/components/page-header"
import { EmptyValue } from "@/components/metrics"
import { Badge } from "@/components/ui/badge"
import { TableSkeleton } from "@/components/page-state"
import { Frame, FrameHeader, FramePanel } from "@/components/frame"
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

function BranchesPage() {
  const hydrated = useHydrated()
  const overview = useQuery({ ...overviewQueryOptions, enabled: hydrated })
  const branches = overview.data?.branches ?? []

  const summaries = useQueries({
    queries: branches.map((branch) => ({
      ...branchSummaryQueryOptions(branch),
      enabled: hydrated,
    })),
  })
  const failedSummaries = summaries.filter((summary) => summary.isError)

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
      {overview.isError && (
        <StaleStrip
          updatedAt={overview.dataUpdatedAt}
          onRetry={() => void overview.refetch()}
        />
      )}
      {failedSummaries.length > 0 && (
        <ErrorState
          thing="branch summaries"
          error={failedSummaries[0].error}
          onRetry={() =>
            void Promise.all(
              failedSummaries.map((summary) => summary.refetch())
            )
          }
        />
      )}
      <Frame>
        <FrameHeader
          title="All branches"
          description={
            overview.isPending
              ? "Loading"
              : plural(branches.length, "branch", "branches")
          }
        />
        <FramePanel>
          {overview.isPending ? (
            <TableSkeleton
              widths={["w-32", "w-48", "w-10"]}
              rowClassName="h-12"
            />
          ) : branches.length === 0 ? (
            <div className="p-4">
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
                  <TableHead className="min-w-52 pl-4 text-xs text-muted-foreground">
                    Branch
                  </TableHead>
                  <TableHead className="min-w-72 text-xs text-muted-foreground">
                    Latest update
                  </TableHead>
                  <TableHead className="w-24 pr-4 text-right text-xs text-muted-foreground">
                    Groups
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody className="[&_tr:last-child]:border-0">
                {branches.map((branch, index) => {
                  const summary = summaries[index]
                  const groups = summary.data?.groups
                  const newest = groups?.[0]
                  const linked = overview.data.channels.filter(
                    (channel) => channel.branch === branch
                  )
                  return (
                    <TableRow key={branch} className="h-16">
                      <TableCell className="pl-4">
                        <Link
                          to="/branches/$name"
                          params={{ name: branch }}
                          className="flex items-center gap-3 rounded-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
                        >
                          <span
                            aria-hidden="true"
                            className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground"
                          >
                            <HugeiconsIcon
                              icon={GitBranchIcon}
                              strokeWidth={2}
                              className="size-4"
                            />
                          </span>
                          <span className="flex min-w-0 flex-col gap-1">
                            <span className="font-medium underline-offset-4 hover:underline">
                              {branch}
                            </span>
                            <span className="flex flex-wrap items-center gap-1">
                              {linked.length === 0 ? (
                                <span className="text-xs text-muted-foreground">
                                  Not linked to a channel
                                </span>
                              ) : (
                                linked.map((channel) => (
                                  <Badge
                                    key={channel.name}
                                    variant="secondary"
                                    className="font-normal"
                                  >
                                    {channel.name}
                                  </Badge>
                                ))
                              )}
                            </span>
                          </span>
                        </Link>
                      </TableCell>
                      <TableCell>
                        {groups === undefined ? (
                          <span className="text-muted-foreground">
                            {summary.isError
                              ? "Could not load updates"
                              : "Loading updates"}
                          </span>
                        ) : newest === undefined ? (
                          <span className="text-muted-foreground">
                            No updates yet
                          </span>
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
                      <TableCell className="pr-4 text-right font-medium tabular-nums">
                        {groups === undefined ? (
                          <EmptyValue
                            reason={
                              summary.isError
                                ? "Could not load the group count"
                                : "Still loading"
                            }
                          />
                        ) : (
                          `${groups.length}${groups.length === pageSize ? "+" : ""}`
                        )}
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          )}
        </FramePanel>
      </Frame>
    </>
  )
}
