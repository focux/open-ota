import { useState } from "react"
import { Link } from "@tanstack/react-router"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { HugeiconsIcon } from "@hugeicons/react"
import { MoreHorizontalIcon } from "@hugeicons/core-free-icons"

import { api } from "@/lib/api"
import type { Channel, Metrics, RuntimeDevices, Update } from "@/lib/api"
import { absoluteTime, plural, relativeTime, shortId } from "@/lib/format"
import { adoption, driftedRuntimes } from "@/lib/metrics"
import { CardNotice, DialogError } from "@/components/feedback"
import { RollbackDialog } from "@/components/rollback-dialog"
import { HealthBadge } from "@/components/health-badge"
import { AdoptionCell, PlatformChip } from "@/components/metrics"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty"
import { Field, FieldLabel } from "@/components/ui/field"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Spinner } from "@/components/ui/spinner"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { toast } from "@/components/ui/toast"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"

/** What a channel is serving right now, one row per build it can reach. */
export function ChannelCard({
  channel,
  branches,
  updates,
  metrics,
  messages,
}: {
  readonly channel: Channel
  readonly branches: ReadonlyArray<string>
  readonly updates: ReadonlyArray<Update>
  readonly metrics: Metrics | undefined
  readonly messages: ReadonlyMap<string, string | null>
}) {
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const [rollbackOpen, setRollbackOpen] = useState(false)
  const [target, setTarget] = useState(channel.branch)

  const link = useMutation({
    mutationFn: (branch: string) => api.setChannel(channel.name, branch),
    onSuccess: (_result, branch) => {
      setOpen(false)
      toast.add({
        title: `Linked ${channel.name} to ${branch}`,
        type: "success",
      })
      return queryClient.invalidateQueries()
    },
  })

  const serving = [...updates]
    .filter((update) => update.branch === channel.branch)
    .sort(
      (a, b) =>
        a.runtimeVersion.localeCompare(b.runtimeVersion) ||
        a.platform.localeCompare(b.platform)
    )

  // Builds with devices on this channel that the branch has nothing for.
  // They sit in the table with the rest: a fresh build looks like this until
  // its first publish, and an old build looks like this forever.
  const unserved = driftedRuntimes(metrics, [channel.name], serving)
  const rows = buildRows(serving, unserved)
  const faulty = serving.reduce(
    (total, update) => total + adoption(metrics, update).faulty,
    0
  )

  return (
    <Card>
      <CardHeader className="border-b">
        <CardTitle>{channel.name}</CardTitle>
        <CardDescription>
          Linked to{" "}
          <Link
            to="/branches/$name"
            params={{ name: channel.branch }}
            className="rounded-sm font-medium text-foreground underline-offset-4 transition-colors duration-150 ease-out outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            {channel.branch}
          </Link>
        </CardDescription>
        <CardAction>
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Actions for the ${channel.name} channel`}
                />
              }
            >
              <HugeiconsIcon icon={MoreHorizontalIcon} strokeWidth={2} />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-52">
              <DropdownMenuItem
                className="whitespace-nowrap"
                onClick={() => {
                  setTarget(channel.branch)
                  setOpen(true)
                }}
              >
                Change linked branch...
              </DropdownMenuItem>
              <DropdownMenuItem
                className="whitespace-nowrap"
                onClick={() => setRollbackOpen(true)}
              >
                Roll back...
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </CardAction>
      </CardHeader>

      {faulty > 0 && (
        <CardNotice
          variant="destructive"
          title={`${plural(faulty, "device")} crashed on what ${channel.name} is serving`}
          description="They rolled back to the update they were on. Rolling back stops the rest of the fleet from taking it."
          action={
            <Button
              variant="outline"
              size="sm"
              onClick={() => setRollbackOpen(true)}
            >
              Roll back
            </Button>
          }
        />
      )}

      <CardContent className="p-0">
        {rows.length === 0 ? (
          <div className="px-(--card-spacing) pb-(--card-spacing)">
            <Empty>
              <EmptyHeader>
                <EmptyTitle>Nothing published on {channel.branch}</EmptyTitle>
                <EmptyDescription className="text-pretty">
                  No build has checked in on this channel yet either.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="min-w-52 pl-(--card-spacing) text-xs text-muted-foreground">
                  Build
                </TableHead>
                <TableHead className="min-w-56 text-xs text-muted-foreground">
                  Serving
                </TableHead>
                <TableHead className="w-24 text-right text-xs text-muted-foreground">
                  Adoption
                </TableHead>
                <TableHead className="w-28 text-xs text-muted-foreground">
                  Health
                </TableHead>
                <TableHead className="w-28 pr-(--card-spacing) text-right text-xs text-muted-foreground">
                  Published
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody className="[&_tr:last-child]:border-0">
              {rows.map((row) =>
                row.kind === "unserved" ? (
                  <TableRow
                    key={`${row.runtime.platform} ${row.runtime.runtimeVersion}`}
                    className="h-14"
                  >
                    <TableCell className="pl-(--card-spacing)">
                      <div className="flex flex-col gap-1">
                        <PlatformChip
                          platform={row.runtime.platform}
                          runtimeVersion={row.runtime.runtimeVersion}
                        />
                        <span className="text-xs text-muted-foreground tabular-nums">
                          {plural(row.runtime.devices, "device")}
                        </span>
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex max-w-80 flex-col gap-0.5">
                        <span className="font-medium text-muted-foreground">
                          Nothing published for this build
                        </span>
                        <span className="text-xs text-muted-foreground">
                          Running the bundle it shipped with
                        </span>
                      </div>
                    </TableCell>
                    <TableCell className="text-right text-xs text-muted-foreground">
                      none
                    </TableCell>
                    <TableCell>
                      <HealthBadge healthy={0} faulty={0} />
                    </TableCell>
                    <TableCell className="pr-(--card-spacing) text-right text-xs text-muted-foreground">
                      never
                    </TableCell>
                  </TableRow>
                ) : (
                  <ServingRow
                    key={row.update.id}
                    update={row.update}
                    metrics={metrics}
                    messages={messages}
                  />
                )
              )}
            </TableBody>
          </Table>
        )}
      </CardContent>

      <RollbackDialog
        branch={channel.branch}
        open={rollbackOpen}
        onOpenChange={setRollbackOpen}
        messages={messages}
      />

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Change linked branch</DialogTitle>
            <DialogDescription className="text-pretty">
              Builds on the {channel.name} channel will start receiving updates
              from {target}.
            </DialogDescription>
          </DialogHeader>
          <Field>
            <FieldLabel>Branch</FieldLabel>
            <Select
              value={target}
              onValueChange={(branch) => branch !== null && setTarget(branch)}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {branches.map((branch) => (
                  <SelectItem key={branch} value={branch}>
                    {branch}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <DialogError error={link.error} />
          <DialogFooter>
            <DialogClose render={<Button variant="outline" />}>
              Cancel
            </DialogClose>
            <Button
              disabled={link.isPending || target === channel.branch}
              onClick={() => link.mutate(target)}
            >
              {link.isPending && <Spinner />}
              Change branch
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  )
}

type BuildRow =
  | { readonly kind: "serving"; readonly update: Update }
  | { readonly kind: "unserved"; readonly runtime: RuntimeDevices }

/** One row per build, published or not, ordered by runtime version then platform. */
function buildRows(
  serving: ReadonlyArray<Update>,
  unserved: ReadonlyArray<RuntimeDevices>
): ReadonlyArray<BuildRow> {
  const rows: Array<BuildRow> = [
    ...serving.map((update) => ({ kind: "serving" as const, update })),
    ...unserved.map((runtime) => ({ kind: "unserved" as const, runtime })),
  ]
  const key = (row: BuildRow) =>
    row.kind === "serving"
      ? [row.update.runtimeVersion, row.update.platform]
      : [row.runtime.runtimeVersion, row.runtime.platform]
  return rows.sort((a, b) => {
    const [ra, pa] = key(a)
    const [rb, pb] = key(b)
    return ra.localeCompare(rb) || pa.localeCompare(pb)
  })
}

function ServingRow({
  update,
  metrics,
  messages,
}: {
  readonly update: Update
  readonly metrics: Metrics | undefined
  readonly messages: ReadonlyMap<string, string | null>
}) {
  const numbers = adoption(metrics, update)
  const message = messages.get(update.groupId)

  return (
    <TableRow key={update.id} className="h-14">
      <TableCell className="pl-(--card-spacing)">
        <div className="flex flex-col gap-1">
          <PlatformChip
            platform={update.platform}
            runtimeVersion={update.runtimeVersion}
          />
          <span className="text-xs text-muted-foreground tabular-nums">
            {numbers.devices === 0
              ? "no devices yet"
              : plural(numbers.devices, "device")}
          </span>
        </div>
      </TableCell>
      <TableCell>
        <Link
          to="/groups/$id"
          params={{ id: update.groupId }}
          className="flex max-w-80 flex-col gap-0.5 rounded-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          <span className="truncate font-medium underline-offset-4 hover:underline">
            {update.kind === "rollback"
              ? "Rolled back to embedded"
              : (message ?? "Untitled update")}
          </span>
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span className="font-mono">{shortId(update.id)}</span>
            <span aria-hidden="true">&middot;</span>
            <span>{relativeTime(update.createdAt)}</span>
          </span>
        </Link>
      </TableCell>
      <TableCell className="text-right">
        <AdoptionCell adoption={numbers} />
      </TableCell>
      <TableCell>
        <HealthBadge healthy={numbers.running} faulty={numbers.faulty} />
      </TableCell>
      <TableCell className="pr-(--card-spacing) text-right text-muted-foreground">
        <Tooltip>
          <TooltipTrigger render={<span className="cursor-default" />}>
            {relativeTime(update.createdAt)}
          </TooltipTrigger>
          <TooltipContent>{absoluteTime(update.createdAt)}</TooltipContent>
        </Tooltip>
      </TableCell>
    </TableRow>
  )
}
