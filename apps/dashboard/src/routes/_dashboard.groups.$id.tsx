import { Link, createFileRoute } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { HugeiconsIcon } from "@hugeicons/react"
import { ArrowDown01Icon } from "@hugeicons/core-free-icons"

import type { Metrics, Update } from "@/lib/api"
import { absoluteTime, flagEmoji, relativeTime, shortId } from "@/lib/format"
import {
  adoption,
  failuresFor,
  isCurrentGroup,
  segmentsFor,
} from "@/lib/metrics"
import {
  groupQueryOptions,
  metricsQueryOptions,
  overviewQueryOptions,
  useHydrated,
} from "@/lib/queries"
import { ErrorState, isUnreachable } from "@/components/feedback"
import { GroupActions } from "@/components/group-actions"
import { HealthBadge } from "@/components/health-badge"
import {
  AdoptionCell,
  CommitBadge,
  CopyButton,
  CopyId,
  RuntimeVersion,
  maskHash,
} from "@/components/metrics"
import { PageHeader } from "@/components/page-header"
import { CardSkeleton } from "@/components/page-state"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"

export const Route = createFileRoute("/_dashboard/groups/$id")({
  component: GroupPage,
})

function GroupPage() {
  const { id } = Route.useParams()
  const hydrated = useHydrated()
  const overview = useQuery({ ...overviewQueryOptions, enabled: hydrated })
  const metrics = useQuery({ ...metricsQueryOptions, enabled: hydrated })
  const group = useQuery({ ...groupQueryOptions(id), enabled: hydrated })

  if (isUnreachable(group.error)) return null
  if (group.isError) {
    return (
      <ErrorState
        thing="this update group"
        error={group.error}
        onRetry={() => void group.refetch()}
      />
    )
  }
  if (group.isPending) {
    return <CardSkeleton count={2} widths={["w-40", "w-32", "w-16", "w-56"]} />
  }

  const current = isCurrentGroup(overview.data?.latest ?? [], group.data)
  const failures = failuresFor(metrics.data, group.data.updates)
  const segments = segmentsFor(metrics.data, group.data.updates)
  const config = group.data.updates.find((update) => update.kind === "bundle")

  return (
    <>
      <PageHeader
        title={group.data.message ?? shortId(group.data.id)}
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            <Link
              to="/branches/$name"
              params={{ name: group.data.branch }}
              className="rounded-sm font-medium text-foreground underline-offset-4 transition-colors duration-150 ease-out outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              {group.data.branch}
            </Link>
            {group.data.gitCommit !== null && (
              <CommitBadge value={group.data.gitCommit} />
            )}
            <span title={absoluteTime(group.data.createdAt)}>
              {group.data.actor === null
                ? `Published ${relativeTime(group.data.createdAt)}`
                : `Published by ${group.data.actor} ${relativeTime(group.data.createdAt)}`}
            </span>
          </span>
        }
        actions={
          <GroupActions
            group={group.data}
            branches={overview.data?.branches ?? [group.data.branch]}
            metrics={metrics.data}
            current={current}
            layout="buttons"
          />
        }
      />

      {group.data.updates.map((update, index) => (
        <UpdateCard
          key={update.id}
          update={update}
          metrics={metrics.data}
          index={index}
        />
      ))}

      {failures.length > 0 && (
        <Card>
          <CardHeader className="border-b">
            <CardTitle>Crashes</CardTitle>
            <CardDescription>
              Devices that crashed at launch on this group and rolled back.
            </CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-(--card-spacing)">Message</TableHead>
                  <TableHead className="w-28 pr-(--card-spacing) text-right">
                    Devices
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody className="[&_tr:last-child]:border-0">
                {failures.map((failure) => (
                  <TableRow key={`${failure.updateId} ${failure.message}`}>
                    <TableCell className="pl-(--card-spacing) font-mono text-xs">
                      {failure.message}
                    </TableCell>
                    <TableCell className="pr-(--card-spacing) text-right tabular-nums">
                      {failure.devices.toLocaleString()}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {segments.length > 0 && (
        <Card>
          <CardHeader className="border-b">
            <CardTitle>By country</CardTitle>
            <CardDescription>
              Where the devices running this group are.
            </CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-(--card-spacing)">Country</TableHead>
                  <TableHead className="w-28 text-right">Running</TableHead>
                  <TableHead className="w-32 pr-(--card-spacing)">
                    Health
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody className="[&_tr:last-child]:border-0">
                {segments.map((segment) => (
                  <TableRow key={segment.country}>
                    <TableCell className="pl-(--card-spacing)">
                      <span className="flex items-center gap-2">
                        <span aria-hidden="true">
                          {flagEmoji(segment.country)}
                        </span>
                        <span className="font-mono text-xs">
                          {segment.country}
                        </span>
                      </span>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {segment.running.toLocaleString()}
                    </TableCell>
                    <TableCell className="pr-(--card-spacing)">
                      <HealthBadge
                        healthy={segment.running}
                        faulty={segment.faulty}
                      />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {config !== undefined && (
        <Card>
          <Collapsible>
            <CardHeader>
              <CardTitle>Expo config</CardTitle>
              <CardDescription>
                The public config the manifest hands to the client.
              </CardDescription>
              <CollapsibleTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Toggle the Expo config"
                    className="absolute top-3 right-3 aria-expanded:rotate-180"
                  />
                }
              >
                <HugeiconsIcon icon={ArrowDown01Icon} strokeWidth={2} />
              </CollapsibleTrigger>
            </CardHeader>
            <CollapsibleContent>
              <CardContent>
                <pre className="max-h-96 overflow-auto rounded-lg bg-muted p-3 font-mono text-xs">
                  {JSON.stringify(config.expoConfig, null, 2)}
                </pre>
              </CardContent>
            </CollapsibleContent>
          </Collapsible>
        </Card>
      )}
    </>
  )
}

function UpdateCard({
  update,
  metrics,
  index,
}: {
  readonly update: Update
  readonly metrics: Metrics | undefined
  readonly index: number
}) {
  const numbers = adoption(metrics, update)

  return (
    <Card
      className="animate-in duration-200 ease-out fade-in-0 [animation-fill-mode:backwards] slide-in-from-bottom-1"
      style={{ animationDelay: `${index * 40}ms` }}
    >
      <CardHeader className="border-b">
        <CardTitle className="flex flex-wrap items-center gap-2">
          {update.platform}
          {update.kind === "rollback" && (
            <Badge variant="destructive">Rollback</Badge>
          )}
          {update.rolloutPercent < 100 && (
            <Badge variant="secondary" className="tabular-nums">
              Rolling out {update.rolloutPercent}%
            </Badge>
          )}
          <CopyId value={update.id} />
        </CardTitle>
        <CardDescription className="flex flex-wrap items-center gap-1.5">
          Runtime version <RuntimeVersion value={update.runtimeVersion} />
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-wrap items-end gap-6">
          <Figure
            label="Running"
            value={numbers.running}
            hint="Devices launching this update."
          />
          <Figure
            label="Served"
            value={numbers.served}
            hint="Handed it, some awaiting a relaunch."
          />
          <Figure
            label="On this runtime"
            value={numbers.devices}
            hint="Devices that could take it."
          />
          <div className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">Health</span>
            <HealthBadge healthy={numbers.running} faulty={numbers.faulty} />
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">Adoption</span>
            <AdoptionCell adoption={numbers} />
          </div>
        </div>

        {update.kind === "bundle" && (
          <div className="flex flex-col gap-1">
            <span className="text-sm font-medium">Launch asset</span>
            <span className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <CopyButton
                value={update.launchAsset.key}
                label={maskHash(update.launchAsset.key)}
              />
              {update.launchAsset.contentType}
              <CopyButton
                value={update.launchAsset.hash}
                label={maskHash(update.launchAsset.hash)}
              />
            </span>
          </div>
        )}
      </CardContent>
      {update.kind === "bundle" && update.assets.length > 0 && (
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="min-w-56 pl-(--card-spacing) text-xs text-muted-foreground">
                  Key
                </TableHead>
                <TableHead className="text-xs text-muted-foreground">
                  Type
                </TableHead>
                <TableHead className="w-24 text-xs text-muted-foreground">
                  Extension
                </TableHead>
                <TableHead className="w-52 pr-(--card-spacing) text-xs text-muted-foreground">
                  Hash
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody className="[&_tr:last-child]:border-0">
              {update.assets.map((asset) => (
                <TableRow key={asset.hash} className="h-11">
                  <TableCell className="max-w-64 pl-(--card-spacing)">
                    <CopyButton value={asset.key} label={maskHash(asset.key)} />
                  </TableCell>
                  <TableCell>{asset.contentType}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {asset.fileExtension ?? "none"}
                  </TableCell>
                  <TableCell className="pr-(--card-spacing)">
                    <CopyButton
                      value={asset.hash}
                      label={maskHash(asset.hash)}
                    />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      )}
    </Card>
  )
}

function Figure({
  label,
  value,
  hint,
}: {
  readonly label: string
  readonly value: number
  readonly hint: string
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-2xl leading-none font-semibold tabular-nums">
        {value.toLocaleString()}
      </span>
      <span className="text-xs text-pretty text-muted-foreground">{hint}</span>
    </div>
  )
}
