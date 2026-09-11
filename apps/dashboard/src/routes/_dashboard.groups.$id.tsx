import { Link, createFileRoute } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { HugeiconsIcon } from "@hugeicons/react"
import { ArrowDown01Icon } from "@hugeicons/core-free-icons"

import type { Metrics, Update, UpdatePatches } from "@/lib/api"
import {
  absoluteTime,
  flagEmoji,
  formatBytes,
  plural,
  relativeTime,
  shortId,
} from "@/lib/format"
import {
  adoptionOf,
  failuresFor,
  isCurrentGroup,
  linkedChannels,
  segmentsFor,
} from "@/lib/metrics"
import {
  groupQueryOptions,
  metricsQueryOptions,
  overviewQueryOptions,
  updatePatchesQueryOptions,
  useHydrated,
} from "@/lib/queries"
import { ErrorState } from "@/components/feedback"
import { GroupActions } from "@/components/group-actions"
import { HealthBadge } from "@/components/health-badge"
import {
  AdoptionCell,
  CommitBadge,
  CopyButton,
  CopyId,
  EmptyValue,
  RuntimeVersion,
  maskHash,
} from "@/components/metrics"
import { PageHeader } from "@/components/page-header"
import { CardSkeleton } from "@/components/page-state"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Frame, FrameHeader, FramePanel } from "@/components/frame"
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
  // Counts and adoption are read against the devices this branch can reach.
  const linked = linkedChannels(overview.data?.channels, group.data.branch)
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
          <>
            <CopyId value={group.data.id} kind="Update group" />
            <GroupActions
              group={group.data}
              branches={overview.data?.branches ?? [group.data.branch]}
              channels={overview.data?.channels ?? []}
              metrics={metrics.data}
              current={current}
              layout="buttons"
            />
          </>
        }
      />

      {linked !== undefined && linked.length === 0 && (
        <Alert>
          <AlertTitle>Not linked to a channel</AlertTitle>
          <AlertDescription>
            No channel points at {group.data.branch}, so no device asks for this
            group and the counts below are zero. Link a channel to the branch to
            serve it.
          </AlertDescription>
        </Alert>
      )}

      {group.data.updates.map((update, index) => (
        <UpdateCard
          key={update.id}
          update={update}
          metrics={metrics.data}
          channels={linked}
          index={index}
        />
      ))}

      {failures.length > 0 && (
        <Frame>
          <FrameHeader
            title="Crashes"
            description="Devices that crashed at launch on this group and rolled back."
          />
          <FramePanel>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-4 text-xs text-muted-foreground">
                    Message
                  </TableHead>
                  <TableHead className="w-28 pr-4 text-right text-xs text-muted-foreground">
                    Devices
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody className="[&_tr:last-child]:border-0">
                {failures.map((failure) => (
                  <TableRow key={`${failure.updateId} ${failure.message}`}>
                    <TableCell className="pl-4 font-mono text-xs">
                      {failure.message}
                    </TableCell>
                    <TableCell className="pr-4 text-right tabular-nums">
                      {failure.devices.toLocaleString()}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </FramePanel>
        </Frame>
      )}

      {segments.length > 0 && (
        <Frame>
          <FrameHeader
            title="By country"
            description="Where the devices running this group are."
          />
          <FramePanel>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-4 text-xs text-muted-foreground">
                    Country
                  </TableHead>
                  <TableHead className="w-28 text-right text-xs text-muted-foreground">
                    Running
                  </TableHead>
                  <TableHead className="w-32 pr-4 text-xs text-muted-foreground">
                    Health
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody className="[&_tr:last-child]:border-0">
                {segments.map((segment) => (
                  <TableRow key={segment.country}>
                    <TableCell className="pl-4">
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
                    <TableCell className="pr-4">
                      <HealthBadge
                        healthy={segment.running}
                        faulty={segment.faulty}
                      />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </FramePanel>
        </Frame>
      )}

      {config !== undefined && (
        <Collapsible>
          <Frame>
            <FrameHeader
              title="Expo config"
              description="The public config the manifest hands to the client."
              action={
                <CollapsibleTrigger
                  render={
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label="Toggle the Expo config"
                      className="aria-expanded:rotate-180"
                    />
                  }
                >
                  <HugeiconsIcon icon={ArrowDown01Icon} strokeWidth={2} />
                </CollapsibleTrigger>
              }
            />
            <CollapsibleContent>
              <FramePanel className="p-1.5">
                <pre className="max-h-96 overflow-auto rounded-md bg-muted p-3 font-mono text-xs">
                  {JSON.stringify(config.expoConfig, null, 2)}
                </pre>
              </FramePanel>
            </CollapsibleContent>
          </Frame>
        </Collapsible>
      )}
    </>
  )
}

function UpdateCard({
  update,
  metrics,
  channels,
  index,
}: {
  readonly update: Update
  readonly metrics: Metrics | undefined
  // The channels linked to the group's branch; undefined while unknown.
  readonly channels: ReadonlyArray<string> | undefined
  readonly index: number
}) {
  // The server defines these: running and served count the update wherever a
  // device checks in from, the population is the devices its branch can
  // reach. The metrics fallback only serves an older server.
  const numbers = adoptionOf(metrics, update, channels)

  return (
    <Frame
      className="animate-in duration-200 ease-out fade-in-0 [animation-fill-mode:backwards] slide-in-from-bottom-1"
      style={{ animationDelay: `${index * 40}ms` }}
    >
      <FrameHeader
        title={
          <span className="flex flex-wrap items-center gap-2">
            {update.platform}
            {update.kind === "rollback" && (
              <Badge variant="destructive">Rollback</Badge>
            )}
            {update.rolloutPercent < 100 && (
              <Badge variant="secondary" className="tabular-nums">
                Rolling out {update.rolloutPercent}%
              </Badge>
            )}
          </span>
        }
        description={
          <span className="flex flex-wrap items-center gap-1.5">
            Runtime version <RuntimeVersion value={update.runtimeVersion} />
          </span>
        }
        action={<CopyId value={update.id} kind="Update" />}
      />
      <FramePanel>
        <div className="flex flex-col gap-4 p-4">
          <div className="flex flex-wrap items-end gap-6">
            <Figure
              label="Running"
              value={numbers.running}
              hint={
                update.kind === "rollback"
                  ? "Devices back on their build's embedded JS."
                  : "Devices launching this update."
              }
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
        </div>
        {update.kind === "bundle" && (
          <Collapsible>
            <CollapsibleTrigger
              render={
                <button
                  type="button"
                  className="group/assets flex w-full items-center justify-between border-t px-4 py-2.5 text-sm transition-colors duration-150 ease-out outline-none hover:bg-muted/40 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:ring-inset"
                />
              }
            >
              <span className="font-medium">Bundle and assets</span>
              <span className="flex items-center gap-2 text-xs text-muted-foreground">
                {plural(update.assets.length + 1, "file")}
                <HugeiconsIcon
                  icon={ArrowDown01Icon}
                  strokeWidth={2}
                  className="size-4 transition-transform duration-150 ease-out group-aria-expanded/assets:rotate-180"
                />
              </span>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <div className="flex flex-col gap-1 border-t px-4 py-3">
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
              {update.assets.length > 0 && (
                <div className="border-t">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="min-w-56 pl-4 text-xs text-muted-foreground">
                          Key
                        </TableHead>
                        <TableHead className="text-xs text-muted-foreground">
                          Type
                        </TableHead>
                        <TableHead className="w-24 text-xs text-muted-foreground">
                          Extension
                        </TableHead>
                        <TableHead className="w-52 pr-4 text-xs text-muted-foreground">
                          Hash
                        </TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody className="[&_tr:last-child]:border-0">
                      {update.assets.map((asset) => (
                        <TableRow key={asset.hash} className="h-11">
                          <TableCell className="max-w-64 pl-4">
                            <CopyButton
                              value={asset.key}
                              label={maskHash(asset.key)}
                            />
                          </TableCell>
                          <TableCell>{asset.contentType}</TableCell>
                          <TableCell>
                            {asset.fileExtension ?? (
                              <EmptyValue reason="No file extension" />
                            )}
                          </TableCell>
                          <TableCell className="pr-4">
                            <CopyButton
                              value={asset.hash}
                              label={maskHash(asset.hash)}
                            />
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </CollapsibleContent>
          </Collapsible>
        )}
        {update.kind === "bundle" && <DeltaPatches updateId={update.id} />}
      </FramePanel>
    </Frame>
  )
}

/**
 * The patches stored toward this bundle, and what devices actually
 * downloaded. Failures stay quiet: the rest of the card does not depend on it.
 */
function DeltaPatches({ updateId }: { readonly updateId: string }) {
  const hydrated = useHydrated()
  const patches = useQuery({
    ...updatePatchesQueryOptions(updateId),
    enabled: hydrated,
  })

  if (patches.isPending || patches.isError) {
    return (
      <div className="flex items-center justify-between border-t px-4 py-2.5 text-sm">
        <span className="font-medium">Delta patches</span>
        <span className="text-xs text-muted-foreground">
          {patches.isError ? "Unavailable" : "Loading"}
        </span>
      </div>
    )
  }

  const data = patches.data
  const wire = data.launchAsset.wireSize
  return (
    <Collapsible>
      <CollapsibleTrigger
        render={
          <button
            type="button"
            className="group/patches flex w-full items-center justify-between border-t px-4 py-2.5 text-sm transition-colors duration-150 ease-out outline-none hover:bg-muted/40 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:ring-inset"
          />
        }
      >
        <span className="font-medium">Delta patches</span>
        <span className="flex items-center gap-2 text-xs text-muted-foreground">
          {plural(data.patches.length, "patch", "patches")}
          {wire !== null && ` · full download ${formatBytes(wire)}`}
          <HugeiconsIcon
            icon={ArrowDown01Icon}
            strokeWidth={2}
            className="size-4 transition-transform duration-150 ease-out group-aria-expanded/patches:rotate-180"
          />
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <DeliveryLine data={data} />
        {data.patches.length > 0 ? (
          <div className="border-t">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-4 text-xs text-muted-foreground">
                    From
                  </TableHead>
                  <TableHead className="w-24 text-right text-xs text-muted-foreground">
                    Patch
                  </TableHead>
                  <TableHead className="w-32 text-right text-xs text-muted-foreground">
                    Of full download
                  </TableHead>
                  <TableHead className="w-36 pr-4 text-xs text-muted-foreground">
                    Computed
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody className="[&_tr:last-child]:border-0">
                {data.patches.map((patch) => (
                  <TableRow key={patch.baseHash} className="h-11">
                    <TableCell className="pl-4">
                      <span className="flex flex-wrap items-center gap-1.5">
                        {patch.bases.length === 0 ? (
                          <CopyButton
                            value={patch.baseHash}
                            label={maskHash(patch.baseHash)}
                          />
                        ) : (
                          patch.bases.map((base) => (
                            <span
                              key={base.updateId}
                              className="flex items-center gap-1"
                            >
                              <CopyId value={base.updateId} kind="Update" />
                              {base.embedded && (
                                <Badge variant="secondary">Build</Badge>
                              )}
                            </span>
                          ))
                        )}
                      </span>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatBytes(patch.size)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {patch.ratio === null ? (
                        <EmptyValue reason="The full bundle is no longer stored" />
                      ) : (
                        `${Math.round(patch.ratio * 100)}%`
                      )}
                    </TableCell>
                    <TableCell
                      className="pr-4 text-muted-foreground"
                      title={absoluteTime(patch.createdAt)}
                    >
                      {relativeTime(patch.createdAt)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : (
          <p className="border-t px-4 py-3 text-xs text-muted-foreground">
            No patch was worth storing for this bundle. Patches are kept only
            under {Math.round(data.maxRatio * 100)}% of the full download.
          </p>
        )}
      </CollapsibleContent>
    </Collapsible>
  )
}

/** What went over the wire for this bundle lately, when the server can tell. */
function DeliveryLine({ data }: { readonly data: UpdatePatches }) {
  const delivery = data.delivery
  if (delivery === null) {
    return (
      <p className="border-t px-4 py-3 text-xs text-muted-foreground">
        Delivery counts are off: the server was deployed with
        OTA_DELIVERY_STATS=off, or Analytics Engine did not answer.
      </p>
    )
  }
  const downloads = delivery.full + delivery.patch
  const wire = data.launchAsset.wireSize
  // Every patched download would otherwise have cost a full one.
  const saved =
    wire === null ? null : delivery.patch * wire - delivery.patchBytes
  return (
    <div className="flex flex-wrap items-end gap-6 border-t px-4 py-3">
      <Figure
        label="Downloads"
        value={downloads}
        hint={`Last ${plural(delivery.days, "day")}.`}
      />
      <Figure
        label="Patched"
        value={delivery.patch}
        hint={
          downloads === 0
            ? "No downloads yet."
            : `${Math.round((delivery.patch / downloads) * 100)}% took a patch.`
        }
      />
      <div className="flex flex-col gap-1">
        <span className="text-xs text-muted-foreground">Saved</span>
        <span className="text-2xl leading-none font-semibold tabular-nums">
          {saved === null ? "–" : formatBytes(Math.max(0, saved))}
        </span>
        <span className="text-xs text-pretty text-muted-foreground">
          Against full downloads.
        </span>
      </div>
    </div>
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
