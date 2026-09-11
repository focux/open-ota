import { Link, createFileRoute } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"

import type { Device, DeviceCheck } from "@/lib/api"
import {
  explainCheck,
  explainDevice,
  recordedNote,
  timesChecked,
} from "@/lib/devices"
import { absoluteTime, flagEmoji, relativeTime } from "@/lib/format"
import { deviceQueryOptions, useHydrated } from "@/lib/queries"
import { ErrorState } from "@/components/feedback"
import {
  CopyId,
  Dot,
  EmptyValue,
  PlatformChip,
  RuntimeVersion,
} from "@/components/metrics"
import { PageHeader } from "@/components/page-header"
import { CardSkeleton } from "@/components/page-state"
import { Frame, FrameHeader, FramePanel } from "@/components/frame"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"

export const Route = createFileRoute("/_dashboard/devices/$clientId")({
  component: DevicePage,
})

function DevicePage() {
  const { clientId } = Route.useParams()
  const hydrated = useHydrated()
  const device = useQuery({
    ...deviceQueryOptions(clientId),
    enabled: hydrated,
  })

  if (device.isError) {
    return (
      <ErrorState
        thing="this device"
        error={device.error}
        onRetry={() => void device.refetch()}
      />
    )
  }
  if (device.isPending) {
    return <CardSkeleton count={2} widths={["w-40", "w-32", "w-56"]} />
  }

  const { device: row, checks } = device.data
  const latest = explainDevice(checks)

  return (
    <>
      <PageHeader
        title="Device"
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            <Link
              to="/devices"
              className="rounded-sm font-medium text-foreground underline-offset-4 transition-colors duration-150 ease-out outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              All devices
            </Link>
            <span title={absoluteTime(row.lastSeenAt)}>
              Last seen {relativeTime(row.lastSeenAt)}
            </span>
            <span title={absoluteTime(row.firstSeenAt)}>
              first seen {relativeTime(row.firstSeenAt)}
            </span>
          </span>
        }
        actions={<CopyId value={row.clientId} kind="Client id" />}
      />

      {latest !== null && (
        <Alert>
          <AlertTitle>{latest.summary}</AlertTitle>
          <AlertDescription className="text-pretty">
            {latest.detail}
          </AlertDescription>
        </Alert>
      )}

      <Frame>
        <FrameHeader
          title="What this device is"
          description="The state its last check-in left behind."
        />
        <FramePanel>
          <dl className="grid gap-x-6 gap-y-4 p-4 sm:grid-cols-2 lg:grid-cols-3">
            <Entry label="Build">
              <PlatformChip
                platform={row.platform}
                runtimeVersion={row.runtimeVersion}
              />
            </Entry>
            <Entry label="Channel">{row.channel}</Entry>
            <Entry label="Runtime version">
              <RuntimeVersion value={row.runtimeVersion} />
            </Entry>
            <Entry label="Running">
              <UpdateValue
                value={row.currentUpdateId}
                reason="No update reported yet"
              />
            </Entry>
            <Entry label="Served">
              <UpdateValue
                value={row.servedUpdateId}
                reason="Nothing has been handed to it"
              />
            </Entry>
            <Entry label="Built-in JavaScript">
              <UpdateValue
                value={row.embeddedUpdateId}
                reason="The build reports no embedded update"
              />
            </Entry>
            <Entry label="Where">
              {row.country === null ? (
                <EmptyValue reason="No country reported" />
              ) : (
                <span className="flex items-center gap-2">
                  <span aria-hidden="true">{flagEmoji(row.country)}</span>
                  <span>
                    {[row.city, row.country].filter(Boolean).join(", ")}
                  </span>
                </span>
              )}
            </Entry>
          </dl>
          {row.servedUpdateId !== null &&
            row.servedUpdateId !== row.currentUpdateId && (
              <p className="border-t px-4 py-3 text-xs text-pretty text-muted-foreground">
                Served is ahead of running: the device has been handed an update
                it has not launched yet. `expo-updates` applies one on a full
                relaunch, not on a return from the background.
              </p>
            )}
        </FramePanel>
      </Frame>

      <Frame>
        <FrameHeader
          title="Recent checks"
          description={`Newest first. A run of identical answers is one row. ${recordedNote}`}
        />
        <FramePanel>
          {checks.length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">
              This device has a registry row but no recorded checks yet.
            </p>
          ) : (
            <ol className="flex flex-col">
              {checks.map((check) => (
                <CheckRow
                  key={`${check.firstCheckedAt} ${check.reason}`}
                  check={check}
                />
              ))}
            </ol>
          )}
        </FramePanel>
      </Frame>
    </>
  )
}

function CheckRow({ check }: { readonly check: DeviceCheck }) {
  const explained = explainCheck(check)
  return (
    <li className="flex flex-col gap-1.5 border-b px-4 py-3 last:border-0">
      <span className="flex flex-wrap items-center gap-2">
        <Badge variant={explained.served ? "outline" : "secondary"}>
          <Dot
            className={
              explained.served ? "bg-emerald-500" : "bg-muted-foreground"
            }
          />
          {check.decision === "none" ? "No update" : check.decision}
        </Badge>
        <span className="font-medium">{explained.summary}</span>
      </span>
      <span className="text-sm text-pretty text-muted-foreground">
        {explained.detail}
      </span>
      <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span title={absoluteTime(check.lastCheckedAt)}>
          {relativeTime(check.lastCheckedAt)}
        </span>
        <span>
          Recorded {timesChecked(check.checks)}
          {check.checks > 1 && `, since ${relativeTime(check.firstCheckedAt)}`}
        </span>
        <span>
          {check.platform} on {check.channel}
        </span>
        {check.currentUpdateId !== null && (
          <span className="flex items-center gap-1">
            running <CopyId value={check.currentUpdateId} kind="Update" />
          </span>
        )}
        {check.servedUpdateId !== null && (
          <span className="flex items-center gap-1">
            served <CopyId value={check.servedUpdateId} kind="Update" />
          </span>
        )}
      </span>
      {check.fatalError !== null && (
        <span className="font-mono text-xs text-destructive">
          {check.fatalError}
        </span>
      )}
    </li>
  )
}

function UpdateValue({
  value,
  reason,
}: {
  readonly value: Device["currentUpdateId"]
  readonly reason: string
}) {
  return value === null ? (
    <EmptyValue reason={reason} />
  ) : (
    <CopyId value={value} kind="Update" />
  )
}

function Entry({
  label,
  children,
}: {
  readonly label: string
  readonly children: React.ReactNode
}) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="flex items-center text-sm">{children}</dd>
    </div>
  )
}
