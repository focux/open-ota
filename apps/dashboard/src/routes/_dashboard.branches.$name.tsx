import { useState } from "react"
import { Link, createFileRoute } from "@tanstack/react-router"
import { useInfiniteQuery, useQuery } from "@tanstack/react-query"
import { HugeiconsIcon } from "@hugeicons/react"
import { CloudUploadIcon } from "@hugeicons/core-free-icons"

import { absoluteTime, plural, relativeTime } from "@/lib/format"
import { adoption, combineAdoption, isCurrentGroup } from "@/lib/metrics"
import {
  groupsQueryOptions,
  metricsQueryOptions,
  overviewQueryOptions,
  useHydrated,
} from "@/lib/queries"
import { ErrorState, StaleStrip, isUnreachable } from "@/components/feedback"
import { GroupActions } from "@/components/group-actions"
import { HealthBadge } from "@/components/health-badge"
import {
  AdoptionCell,
  CommitBadge,
  PlatformChip,
  StatusChip,
} from "@/components/metrics"
import { PageHeader } from "@/components/page-header"
import { RollbackDialog } from "@/components/rollback-dialog"
import { TableSkeleton } from "@/components/page-state"
import { Button } from "@/components/ui/button"
import { Frame, FrameHeader, FramePanel } from "@/components/frame"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty"
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"

export const Route = createFileRoute("/_dashboard/branches/$name")({
  component: BranchPage,
})

function BranchPage() {
  const { name } = Route.useParams()
  const hydrated = useHydrated()
  const overview = useQuery({ ...overviewQueryOptions, enabled: hydrated })
  const metrics = useQuery({ ...metricsQueryOptions, enabled: hydrated })
  const groups = useInfiniteQuery({
    ...groupsQueryOptions(name),
    enabled: hydrated,
  })

  const rows = groups.data?.pages.flatMap((page) => page.groups) ?? []
  const latest = overview.data?.latest ?? []
  const channels = (overview.data?.channels ?? []).filter(
    (channel) => channel.branch === name
  )
  const stale = groups.isError && groups.data !== undefined
  const [rollbackOpen, setRollbackOpen] = useState(false)
  // Group id to message, so the rollback rows can name what they replace.
  const messages = new Map(
    rows.map((group) => [group.id, group.message] as const)
  )

  if (isUnreachable(overview.error)) return null

  return (
    <>
      <PageHeader
        title={name}
        subtitle={
          overview.isPending
            ? "Loading"
            : channels.length === 0
              ? "Not linked to any channel"
              : `Linked to channels: ${channels.map((channel) => channel.name).join(", ")}`
        }
        actions={
          <>
            <PublishCommand branch={name} />
            <Button variant="destructive" onClick={() => setRollbackOpen(true)}>
              Roll back...
            </Button>
          </>
        }
      />

      {stale && (
        <StaleStrip
          updatedAt={groups.dataUpdatedAt}
          onRetry={() => void groups.refetch()}
        />
      )}

      {groups.isError && groups.data === undefined ? (
        <ErrorState
          thing={`the update groups on ${name}`}
          error={groups.error}
          onRetry={() => void groups.refetch()}
        />
      ) : (
        <Frame>
          <FrameHeader
            title="Update groups"
            description={
              groups.isPending
                ? "Loading"
                : `${plural(rows.length, "group")}${groups.hasNextPage ? " loaded so far" : ""}, newest first`
            }
          />
          <FramePanel>
            {groups.isPending ? (
              <TableSkeleton
                widths={["w-64", "w-40", "w-20", "w-12", "w-14", "w-6"]}
              />
            ) : rows.length === 0 ? (
              <div className="p-4">
                <Empty>
                  <EmptyHeader>
                    <EmptyTitle>Nothing published on {name}</EmptyTitle>
                    <EmptyDescription className="text-pretty">
                      Publish from the app repository and the update group shows
                      up here.
                    </EmptyDescription>
                  </EmptyHeader>
                  <EmptyContent>
                    <code className="rounded-lg bg-muted px-2.5 py-1.5 font-mono text-xs">
                      npx open-ota publish --branch {name}
                    </code>
                  </EmptyContent>
                </Empty>
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead className="min-w-70 pl-4 text-xs text-muted-foreground">
                      Update
                    </TableHead>
                    <TableHead className="min-w-40 text-xs text-muted-foreground">
                      Targets
                    </TableHead>
                    <TableHead className="w-32 text-xs text-muted-foreground">
                      Status
                    </TableHead>
                    <TableHead className="w-24 text-right text-xs text-muted-foreground">
                      Adoption
                    </TableHead>
                    <TableHead className="w-28 text-xs text-muted-foreground">
                      Health
                    </TableHead>
                    <TableHead className="w-0 pr-4" />
                  </TableRow>
                </TableHeader>
                <TableBody className="[&_tr:last-child]:border-0">
                  {rows.map((group) => {
                    const current = isCurrentGroup(latest, group)
                    const numbers = combineAdoption(
                      group.updates.map((update) =>
                        adoption(metrics.data, update)
                      )
                    )
                    return (
                      <TableRow key={group.id} className="group/row h-14">
                        <TableCell className="pl-4">
                          <Link
                            to="/groups/$id"
                            params={{ id: group.id }}
                            className="flex max-w-96 flex-col gap-0.5 rounded-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
                          >
                            <Tooltip>
                              <TooltipTrigger
                                render={
                                  <span className="truncate font-medium underline-offset-4 hover:underline" />
                                }
                              >
                                {group.message ?? (
                                  <span className="text-muted-foreground italic">
                                    Untitled update
                                  </span>
                                )}
                              </TooltipTrigger>
                              <TooltipContent>
                                {group.message ?? "Untitled update"}
                              </TooltipContent>
                            </Tooltip>
                            <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                              {group.gitCommit !== null && (
                                <>
                                  <CommitBadge value={group.gitCommit} />
                                  <span aria-hidden="true">&middot;</span>
                                </>
                              )}
                              <Tooltip>
                                <TooltipTrigger render={<span />}>
                                  {relativeTime(group.createdAt)}
                                </TooltipTrigger>
                                <TooltipContent>
                                  {absoluteTime(group.createdAt)}
                                </TooltipContent>
                              </Tooltip>
                              {group.actor !== null && (
                                <>
                                  <span aria-hidden="true">&middot;</span>
                                  <span className="truncate">
                                    by {group.actor}
                                  </span>
                                </>
                              )}
                            </span>
                          </Link>
                        </TableCell>
                        <TableCell>
                          <div className="flex flex-wrap gap-1.5">
                            {group.updates.map((update) => (
                              <PlatformChip
                                key={update.id}
                                platform={update.platform}
                                runtimeVersion={update.runtimeVersion}
                              />
                            ))}
                          </div>
                        </TableCell>
                        <TableCell>
                          <StatusChip
                            serving={current}
                            rollout={group.updates[0]?.rolloutPercent ?? 100}
                            rollback={group.updates.every(
                              (update) => update.kind === "rollback"
                            )}
                          />
                        </TableCell>
                        <TableCell className="text-right">
                          <AdoptionCell adoption={numbers} />
                        </TableCell>
                        <TableCell>
                          <HealthBadge
                            healthy={numbers.running}
                            faulty={numbers.faulty}
                          />
                        </TableCell>
                        <TableCell className="pr-4">
                          <GroupActions
                            group={group}
                            branches={overview.data?.branches ?? [name]}
                            channels={overview.data?.channels ?? []}
                            metrics={metrics.data}
                            current={current}
                            className="justify-end"
                          />
                        </TableCell>
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
            )}
          </FramePanel>
        </Frame>
      )}

      <RollbackDialog
        branch={name}
        open={rollbackOpen}
        onOpenChange={setRollbackOpen}
        messages={messages}
      />

      {groups.hasNextPage && (
        <div className="flex justify-center">
          <Button
            variant="outline"
            disabled={groups.isFetchingNextPage}
            onClick={() => groups.fetchNextPage()}
          >
            {groups.isFetchingNextPage ? "Loading" : "Load more"}
          </Button>
        </div>
      )}
    </>
  )
}

/** Publishing is a CLI job, so the page hands over the exact command. */
function PublishCommand({ branch }: { readonly branch: string }) {
  return (
    <Popover>
      <PopoverTrigger render={<Button variant="outline" />}>
        <HugeiconsIcon icon={CloudUploadIcon} strokeWidth={2} />
        Publish
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80">
        <PopoverHeader>
          <PopoverTitle>Publish to {branch}</PopoverTitle>
          <PopoverDescription className="text-pretty">
            Run this from the app repository, on the same lockfile as the native
            build.
          </PopoverDescription>
        </PopoverHeader>
        <code className="mt-3 block rounded-lg bg-muted px-2.5 py-1.5 font-mono text-xs break-all">
          npx open-ota publish --branch {branch}
        </code>
      </PopoverContent>
    </Popover>
  )
}
