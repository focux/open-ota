import { useState } from "react"
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router"
import { useInfiniteQuery, useQuery } from "@tanstack/react-query"
import { HugeiconsIcon } from "@hugeicons/react"
import { Search01Icon, SmartphoneIcon } from "@hugeicons/core-free-icons"

import type { DeviceFilters, Platform } from "@/lib/api"
import { flagEmoji, relativeTime, plural, shortId } from "@/lib/format"
import {
  devicesQueryOptions,
  overviewQueryOptions,
  useHydrated,
} from "@/lib/queries"
import { ErrorState, isUnreachable } from "@/components/feedback"
import { CopyId, EmptyValue, PlatformChip } from "@/components/metrics"
import { PageHeader } from "@/components/page-header"
import { TableSkeleton } from "@/components/page-state"
import { Frame, FrameHeader, FramePanel } from "@/components/frame"
import { Button } from "@/components/ui/button"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty"
import { Field, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"

export const Route = createFileRoute("/_dashboard/devices/")({
  component: DevicesPage,
})

// "Anything" is absence, which a Select cannot hold as a value.
const anyValue = "any"

const recency: ReadonlyArray<readonly [string, string]> = [
  [anyValue, "Any time"],
  ["20", "Last 20 minutes"],
  ["60", "Last hour"],
  ["1440", "Last 24 hours"],
]

interface FormState {
  readonly platform: string
  readonly runtimeVersion: string
  readonly channel: string
  readonly currentUpdateId: string
  readonly country: string
  readonly seenWithinMinutes: string
}

const empty: FormState = {
  platform: anyValue,
  runtimeVersion: "",
  channel: anyValue,
  currentUpdateId: "",
  country: "",
  seenWithinMinutes: anyValue,
}

/** The form as the API reads it: blanks and "any" are simply not sent. */
function toFilters(form: FormState): DeviceFilters {
  return {
    ...(form.platform === anyValue
      ? {}
      : { platform: form.platform as Platform }),
    ...(form.channel === anyValue ? {} : { channel: form.channel }),
    ...(form.seenWithinMinutes === anyValue
      ? {}
      : { seenWithinMinutes: Number(form.seenWithinMinutes) }),
    runtimeVersion: form.runtimeVersion,
    currentUpdateId: form.currentUpdateId,
    country: form.country,
  }
}

function DevicesPage() {
  const hydrated = useHydrated()
  const navigate = useNavigate()
  const [form, setForm] = useState(empty)
  const [applied, setApplied] = useState<DeviceFilters>({})
  const [clientId, setClientId] = useState("")

  const overview = useQuery({ ...overviewQueryOptions, enabled: hydrated })
  const devices = useInfiniteQuery({
    ...devicesQueryOptions(applied),
    enabled: hydrated,
  })
  // A Select can clear to null; the form keeps "any" for that.
  const set = (field: keyof FormState) => (value: string | null) =>
    setForm((current) => ({ ...current, [field]: value ?? anyValue }))

  if (isUnreachable(overview.error)) return null

  const rows = devices.data?.pages.flatMap((page) => page.devices) ?? []

  return (
    <>
      <PageHeader
        title="Devices"
        subtitle="Which devices checked in, and what the server last answered them?"
      />

      <Frame>
        <FrameHeader
          title="Find a device"
          description="A client id goes straight to one device. The filters narrow the fleet when nobody can read you an id."
        />
        <FramePanel className="p-4">
          <form
            className="flex flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault()
              const id = clientId.trim()
              if (id !== "") {
                void navigate({
                  to: "/devices/$clientId",
                  params: { clientId: id },
                })
                return
              }
              setApplied(toFilters(form))
            }}
          >
            <Field>
              <FieldLabel htmlFor="device-client-id">Client id</FieldLabel>
              <Input
                id="device-client-id"
                value={clientId}
                onChange={(event) => setClientId(event.target.value)}
                placeholder="The eas-client-id the app reports"
                autoComplete="off"
              />
            </Field>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <Field>
                <FieldLabel>Platform</FieldLabel>
                <Select value={form.platform} onValueChange={set("platform")}>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={anyValue}>Any platform</SelectItem>
                    <SelectItem value="ios">iOS</SelectItem>
                    <SelectItem value="android">Android</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
              <Field>
                <FieldLabel>Channel</FieldLabel>
                <Select value={form.channel} onValueChange={set("channel")}>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={anyValue}>Any channel</SelectItem>
                    {(overview.data?.channels ?? []).map((channel) => (
                      <SelectItem key={channel.name} value={channel.name}>
                        {channel.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field>
                <FieldLabel>Last seen</FieldLabel>
                <Select
                  value={form.seenWithinMinutes}
                  onValueChange={set("seenWithinMinutes")}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {recency.map(([value, label]) => (
                      <SelectItem key={value} value={value}>
                        {label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field>
                <FieldLabel htmlFor="device-runtime">
                  Runtime version
                </FieldLabel>
                <Input
                  id="device-runtime"
                  value={form.runtimeVersion}
                  onChange={(event) =>
                    set("runtimeVersion")(event.target.value)
                  }
                  placeholder="The runtime the native build carries"
                  autoComplete="off"
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="device-update">
                  Running update id
                </FieldLabel>
                <Input
                  id="device-update"
                  value={form.currentUpdateId}
                  onChange={(event) =>
                    set("currentUpdateId")(event.target.value)
                  }
                  placeholder="The update the device reports"
                  autoComplete="off"
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="device-country">Country</FieldLabel>
                <Input
                  id="device-country"
                  value={form.country}
                  onChange={(event) => set("country")(event.target.value)}
                  placeholder="Two-letter code, such as CA"
                  autoComplete="off"
                />
              </Field>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button type="submit" size="sm">
                <HugeiconsIcon icon={Search01Icon} strokeWidth={2} />
                Search
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  setForm(empty)
                  setClientId("")
                  setApplied({})
                }}
              >
                Clear
              </Button>
            </div>
          </form>
        </FramePanel>
      </Frame>

      {devices.isError && (
        <ErrorState
          thing="devices"
          error={devices.error}
          onRetry={() => void devices.refetch()}
        />
      )}

      <Frame>
        <FrameHeader
          title="Matching devices"
          description={
            devices.isPending
              ? "Loading"
              : `${plural(rows.length, "device")}${devices.hasNextPage ? " loaded so far" : ""}, most recently seen first`
          }
        />
        <FramePanel>
          {devices.isPending ? (
            <TableSkeleton
              widths={["w-32", "w-20", "w-24", "w-24", "w-20"]}
              rowClassName="h-14"
            />
          ) : rows.length === 0 ? (
            <div className="p-4">
              <Empty>
                <EmptyHeader>
                  <EmptyTitle>No device matches</EmptyTitle>
                  <EmptyDescription className="text-pretty">
                    A device appears here after its first check-in. Nothing at
                    all means no build is reaching this server yet.
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="min-w-48 pl-4 text-xs text-muted-foreground">
                    Device
                  </TableHead>
                  <TableHead className="w-32 text-xs text-muted-foreground">
                    Build
                  </TableHead>
                  <TableHead className="w-28 text-xs text-muted-foreground">
                    Channel
                  </TableHead>
                  <TableHead className="w-36 text-xs text-muted-foreground">
                    Running
                  </TableHead>
                  <TableHead className="w-24 text-xs text-muted-foreground">
                    Where
                  </TableHead>
                  <TableHead className="w-32 pr-4 text-right text-xs text-muted-foreground">
                    Last seen
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody className="[&_tr:last-child]:border-0">
                {rows.map((device) => (
                  <TableRow key={device.clientId} className="h-14">
                    <TableCell className="pl-4">
                      <Link
                        to="/devices/$clientId"
                        params={{ clientId: device.clientId }}
                        className="flex items-center gap-3 rounded-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
                      >
                        <span
                          aria-hidden="true"
                          className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground"
                        >
                          <HugeiconsIcon
                            icon={SmartphoneIcon}
                            strokeWidth={2}
                            className="size-4"
                          />
                        </span>
                        <span className="font-mono text-xs underline-offset-4 hover:underline">
                          {shortId(device.clientId)}
                        </span>
                      </Link>
                    </TableCell>
                    <TableCell>
                      <PlatformChip
                        platform={device.platform}
                        runtimeVersion={device.runtimeVersion}
                      />
                    </TableCell>
                    <TableCell>{device.channel}</TableCell>
                    <TableCell>
                      {device.currentUpdateId === null ? (
                        <EmptyValue reason="No update reported yet" />
                      ) : (
                        <CopyId value={device.currentUpdateId} kind="Update" />
                      )}
                    </TableCell>
                    <TableCell>
                      {device.country === null ? (
                        <EmptyValue reason="No country reported" />
                      ) : (
                        <span className="flex items-center gap-2">
                          <span aria-hidden="true">
                            {flagEmoji(device.country)}
                          </span>
                          <span className="font-mono text-xs">
                            {device.country}
                          </span>
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="pr-4 text-right text-muted-foreground">
                      {relativeTime(device.lastSeenAt)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </FramePanel>
      </Frame>

      {devices.hasNextPage && (
        <div className="flex justify-center">
          <Button
            variant="outline"
            disabled={devices.isFetchingNextPage}
            onClick={() => devices.fetchNextPage()}
          >
            {devices.isFetchingNextPage ? "Loading" : "Load more"}
          </Button>
        </div>
      )}
    </>
  )
}
