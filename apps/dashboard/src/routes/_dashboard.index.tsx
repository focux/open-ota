import { createFileRoute } from "@tanstack/react-router"
import { useQueries, useQuery } from "@tanstack/react-query"

import type { Group } from "@/lib/api"
import { plural } from "@/lib/format"
import {
  activeDevices,
  driftedRuntimes,
  runningOn,
  runtimeVersionCount,
} from "@/lib/metrics"
import {
  groupQueryOptions,
  metricsQueryOptions,
  overviewQueryOptions,
  useHydrated,
} from "@/lib/queries"
import { AddChannelDialog } from "@/components/add-channel-dialog"
import { ChannelCard } from "@/components/channel-card"
import { CountriesCard } from "@/components/countries-card"
import {
  ErrorState,
  StaleStrip,
  Warnings,
  isUnreachable,
} from "@/components/feedback"
import { StatCard } from "@/components/metrics"
import { PageHeader } from "@/components/page-header"
import { CardSkeleton, StatSkeleton } from "@/components/page-state"
import { Card, CardContent } from "@/components/ui/card"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty"

export const Route = createFileRoute("/_dashboard/")({
  component: OverviewPage,
})

function OverviewPage() {
  const hydrated = useHydrated()
  const overview = useQuery({ ...overviewQueryOptions, enabled: hydrated })
  const metrics = useQuery({ ...metricsQueryOptions, enabled: hydrated })

  // The message lives on the group, not the update, so the newest groups are
  // read alongside the overview. They also warm the cache for the group pages.
  const latest = overview.data?.latest ?? []
  const messages = useQueries({
    queries: [...new Set(latest.map((update) => update.groupId))].map((id) => ({
      ...groupQueryOptions(id),
      enabled: hydrated,
    })),
    combine: combineMessages,
  })

  // The layout owns the unreachable banner, so this page adds nothing to it.
  if (isUnreachable(overview.error) || isUnreachable(metrics.error)) return null
  if (overview.isError && overview.data === undefined) {
    return (
      <>
        <PageHeader
          title="Overview"
          subtitle="What is each channel serving right now?"
        />
        <ErrorState
          thing="the channels"
          error={overview.error}
          onRetry={() => void overview.refetch()}
        />
      </>
    )
  }

  const devices = activeDevices(metrics.data)
  const onNewest = latest.reduce(
    (total, update) => total + runningOn(metrics.data, update.id),
    0
  )
  const known = metrics.data !== undefined
  const stale = overview.isError && overview.data !== undefined
  // One line per channel that has devices on a runtime its branch never
  // published for. Scoped per channel: a staging device is not stranded by
  // what production serves.
  const drift = (overview.data?.channels ?? []).flatMap((channel) => {
    const stranded = driftedRuntimes(
      metrics.data,
      [channel.name],
      latest.filter((update) => update.branch === channel.branch)
    )
    return stranded.length === 0
      ? []
      : [
          `${channel.name}: ${stranded
            .map(
              (runtime) =>
                `${plural(runtime.devices, `${runtime.platform} device`)} on ${runtime.runtimeVersion.slice(0, 8)}`
            )
            .join(", ")}`,
        ]
  })
  const strandedRuntimes = (overview.data?.channels ?? []).reduce(
    (total, channel) =>
      total +
      driftedRuntimes(
        metrics.data,
        [channel.name],
        latest.filter((update) => update.branch === channel.branch)
      ).length,
    0
  )

  return (
    <>
      <PageHeader
        title="Overview"
        subtitle="What is each channel serving right now?"
        actions={
          <AddChannelDialog
            channels={
              overview.data?.channels.map((channel) => channel.name) ?? []
            }
            branches={overview.data?.branches ?? []}
          />
        }
      />

      {stale && (
        <StaleStrip
          updatedAt={overview.dataUpdatedAt}
          onRetry={() => void overview.refetch()}
        />
      )}

      <Warnings
        title={`${plural(strandedRuntimes, "runtime version")} ${strandedRuntimes === 1 ? "has" : "have"} devices but nothing published for them`}
        items={drift}
      />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {overview.isPending || metrics.isPending ? (
          <StatSkeleton count={4} />
        ) : (
          <>
            <StatCard
              index={0}
              label="Devices online"
              value={known ? metrics.data.online.toLocaleString() : null}
              hint="Checked in within the last 20 minutes."
            />
            <StatCard
              index={1}
              label="Devices total"
              value={known ? devices.toLocaleString() : null}
              hint="Every device the updates server has ever seen."
            />
            <StatCard
              index={2}
              label="On newest update"
              value={known ? onNewest.toLocaleString() : null}
              suffix={
                devices === 0
                  ? ""
                  : `${Math.min(100, Math.round((onNewest / devices) * 100))}%`
              }
              hint="Running the newest update for their runtime version."
            />
            <StatCard
              index={3}
              label="Runtime versions"
              value={known ? String(runtimeVersionCount(metrics.data)) : null}
              hint="Platform and runtime pairs devices report from the field."
            />
          </>
        )}
      </div>

      {overview.isPending ? (
        <CardSkeleton
          count={2}
          widths={["w-40", "w-56", "w-12", "w-14", "w-20"]}
        />
      ) : known && metrics.data.runtimes.length === 0 ? (
        <Card>
          <CardContent>
            <Empty>
              <EmptyHeader>
                <EmptyTitle>No device has checked in yet</EmptyTitle>
                <EmptyDescription className="text-pretty">
                  Devices appear here after the first launch of a build that
                  points at this server.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          </CardContent>
        </Card>
      ) : overview.data.channels.length === 0 ? (
        <Card>
          <CardContent>
            <Empty>
              <EmptyHeader>
                <EmptyTitle>No channels yet</EmptyTitle>
                <EmptyDescription className="text-pretty">
                  Add one with the name your build checks in with, and link it
                  to a branch.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          </CardContent>
        </Card>
      ) : (
        orderChannels(overview.data.channels).map((channel, index) => (
          <div
            key={channel.name}
            className="animate-in duration-200 ease-out fade-in-0 [animation-fill-mode:backwards] slide-in-from-bottom-1"
            style={{ animationDelay: `${index * 40}ms` }}
          >
            <ChannelCard
              channel={channel}
              branches={overview.data.branches}
              updates={latest}
              metrics={metrics.data}
              messages={messages}
            />
          </div>
        ))
      )}

      {known && <CountriesCard countries={metrics.data.countries} />}
    </>
  )
}

// Hoisted so React Query sees the same function on every render.
function combineMessages(
  results: ReadonlyArray<{ readonly data?: Group }>
): ReadonlyMap<string, string | null> {
  return new Map(
    results.flatMap((result) =>
      result.data ? [[result.data.id, result.data.message] as const] : []
    )
  )
}

const channelOrder = ["production", "staging"]

function orderChannels<T extends { readonly name: string }>(
  channels: ReadonlyArray<T>
): ReadonlyArray<T> {
  const rank = (name: string) => {
    const index = channelOrder.indexOf(name)
    return index === -1 ? channelOrder.length : index
  }
  return [...channels].sort(
    (a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name)
  )
}
