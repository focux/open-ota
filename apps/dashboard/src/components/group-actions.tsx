import { useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  ArrowMoveUpRightIcon,
  MoreHorizontalIcon,
  RefreshIcon,
  SlidersHorizontalIcon,
} from "@hugeicons/core-free-icons"

import { useNavigate } from "@tanstack/react-router"

import { api } from "@/lib/api"
import type { Channel, Group, Metrics } from "@/lib/api"
import { absoluteTime, plural, relativeTime, shortId } from "@/lib/format"
import { deviceCount } from "@/lib/metrics"
import { cn } from "@/lib/utils"
import { DialogError } from "@/components/feedback"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { CommitBadge, PlatformChip } from "@/components/metrics"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
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
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Spinner } from "@/components/ui/spinner"
import { toast } from "@/components/ui/toast"

const quickPicks = [5, 10, 25, 50, 75, 100]
const promoteQuickPicks = [10, 25, 50, 100]

/**
 * Promote, roll back and rollout, used from the branch table and the group
 * page. Every one of them changes what a device would be served next, so they
 * all invalidate every read rather than guess which ones moved.
 */
export function GroupActions({
  group,
  branches,
  channels,
  metrics,
  current,
  layout = "menu",
  className,
}: {
  readonly group: Group
  readonly branches: ReadonlyArray<string>
  readonly channels: ReadonlyArray<Channel>
  readonly metrics: Metrics | undefined
  /** Whether devices are being served this group right now. */
  readonly current: boolean
  /** A kebab in a table row, plain buttons in a page header. */
  readonly layout?: "menu" | "buttons"
  readonly className?: string
}) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [open, setOpen] = useState<"promote" | "rollback" | "rollout" | null>(
    null
  )
  const [promoteRollout, setPromoteRollout] = useState("100")
  const destinations = branches.filter((branch) => branch !== group.branch)
  const [target, setTarget] = useState(destinations[0] ?? group.branch)
  const [message, setMessage] = useState("")
  const currentPercent = group.updates[0]?.rolloutPercent ?? 100
  const [percentInput, setPercentInput] = useState("100")
  const nextPercent = Number(percentInput)
  const validPercent =
    Number.isInteger(nextPercent) &&
    nextPercent > currentPercent &&
    nextPercent <= 100
  const canPromote = destinations.length > 0
  // Rolling back to what is already being served would only duplicate it.
  const canRollbackToThis = !current
  // A finished rollout has nowhere to go, a rollback group has no share to set,
  // and a superseded group's share changes nothing.
  const canRollout =
    current &&
    currentPercent < 100 &&
    group.updates.some((update) => update.kind === "bundle")

  const settled = (title: string) => {
    setOpen(null)
    toast.add({ title, type: "success" })
    return queryClient.invalidateQueries()
  }
  // What the promoted update would reach on the destination today.
  const destinationChannels = channels
    .filter((channel) => channel.branch === target)
    .map((channel) => channel.name)
  const reach = group.updates.map((update) => ({
    update,
    devices: deviceCount(
      metrics,
      update.platform,
      update.runtimeVersion,
      destinationChannels
    ),
  }))
  const unreachable = reach.filter((entry) => entry.devices === 0)

  const promote = useMutation({
    mutationFn: (input: {
      readonly branch: string
      readonly message?: string
      readonly rolloutPercent?: number
    }) => api.promote(group.id, input),
    onSuccess: (result, input) => {
      setOpen(null)
      toast.add({
        title:
          input.branch === group.branch
            ? `Republished on ${group.branch}`
            : `Promoted to ${input.branch}`,
        type: "success",
        actionProps: {
          children: "View",
          onClick: () =>
            void navigate({
              to: "/groups/$id",
              params: { id: result.groupId },
            }),
        },
      })
      return queryClient.invalidateQueries()
    },
  })

  const rollout = useMutation({
    mutationFn: (next: number) => api.setRollout(group.id, next),
    onSuccess: (_result, next) => settled(`Rollout set to ${next} percent`),
  })

  if (!canPromote && !canRollbackToThis && !canRollout) return null

  const openPromote = () => {
    setTarget(destinations[0] ?? group.branch)
    setMessage("")
    setPromoteRollout("100")
    setOpen("promote")
  }
  const openRollout = () => {
    setPercentInput("100")
    setOpen("rollout")
  }

  return (
    <div className={cn("flex items-center gap-2", className)}>
      {layout === "buttons" ? (
        <>
          {canRollbackToThis && (
            <Button variant="outline" onClick={() => setOpen("rollback")}>
              <HugeiconsIcon icon={RefreshIcon} strokeWidth={2} />
              Republish
            </Button>
          )}
          {canPromote && (
            <Button variant="outline" onClick={openPromote}>
              <HugeiconsIcon icon={ArrowMoveUpRightIcon} strokeWidth={2} />
              Promote to...
            </Button>
          )}
          {canRollout && (
            <Button onClick={openRollout}>
              <HugeiconsIcon icon={SlidersHorizontalIcon} strokeWidth={2} />
              Rollout...
            </Button>
          )}
        </>
      ) : (
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                variant="ghost"
                size="icon"
                aria-label="Update group actions"
                className="opacity-60 transition-opacity duration-150 ease-out group-hover/row:opacity-100 focus-visible:opacity-100 aria-expanded:opacity-100"
              />
            }
          >
            <HugeiconsIcon icon={MoreHorizontalIcon} strokeWidth={2} />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-48">
            {canRollbackToThis && (
              <DropdownMenuItem
                className="whitespace-nowrap"
                onClick={() => setOpen("rollback")}
              >
                <HugeiconsIcon icon={RefreshIcon} strokeWidth={2} />
                Republish...
              </DropdownMenuItem>
            )}
            {canPromote && (
              <DropdownMenuItem
                className="whitespace-nowrap"
                onClick={openPromote}
              >
                <HugeiconsIcon icon={ArrowMoveUpRightIcon} strokeWidth={2} />
                Promote to...
              </DropdownMenuItem>
            )}
            {canRollout && (
              <DropdownMenuItem
                className="whitespace-nowrap"
                onClick={openRollout}
              >
                <HugeiconsIcon icon={SlidersHorizontalIcon} strokeWidth={2} />
                Rollout...
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      )}

      <Dialog
        open={open === "promote"}
        onOpenChange={(next) => !next && setOpen(null)}
      >
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {destinations.length === 1
                ? `Promote to ${destinations[0]}`
                : "Promote this update"}
            </DialogTitle>
            <DialogDescription className="text-pretty">
              Copy this group into another branch. The same bundles are
              republished there with new update ids.
            </DialogDescription>
          </DialogHeader>

          <GroupPreview group={group} />

          <div className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">Reaches</span>
            <div className="flex flex-col gap-1">
              {reach.map((entry) => (
                <span
                  key={entry.update.id}
                  className="flex items-center gap-2 text-xs text-muted-foreground tabular-nums"
                >
                  <PlatformChip
                    platform={entry.update.platform}
                    runtimeVersion={entry.update.runtimeVersion}
                  />
                  {entry.devices === 0
                    ? "no devices"
                    : plural(entry.devices, "device")}
                </span>
              ))}
            </div>
          </div>

          {unreachable.length > 0 && (
            <Alert>
              <AlertTitle>Some builds have no devices yet</AlertTitle>
              <AlertDescription className="text-pretty">
                No {target} build reports{" "}
                {unreachable
                  .map(
                    (entry) =>
                      `${entry.update.platform} ${entry.update.runtimeVersion.slice(0, 8)}`
                  )
                  .join(" or ")}{" "}
                yet, so those updates reach nobody until one ships.
              </AlertDescription>
            </Alert>
          )}

          <FieldGroup>
            {destinations.length > 1 && (
              <Field>
                <FieldLabel>Destination branch</FieldLabel>
                <Select
                  value={target}
                  onValueChange={(branch) =>
                    branch !== null && setTarget(branch)
                  }
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {destinations.map((branch) => (
                      <SelectItem key={branch} value={branch}>
                        {branch}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            )}
            <Field>
              <FieldLabel htmlFor="promote-rollout">Rollout</FieldLabel>
              <Input
                id="promote-rollout"
                type="number"
                inputMode="numeric"
                min={0}
                max={100}
                className="tabular-nums"
                value={promoteRollout}
                onChange={(event) => setPromoteRollout(event.target.value)}
              />
              <div className="flex flex-wrap gap-1.5 pt-1">
                {promoteQuickPicks.map((pick) => (
                  <Button
                    key={pick}
                    size="xs"
                    variant={
                      Number(promoteRollout) === pick ? "default" : "outline"
                    }
                    className="tabular-nums"
                    onClick={() => setPromoteRollout(String(pick))}
                  >
                    {pick}%
                  </Button>
                ))}
              </div>
            </Field>
            <Field>
              <FieldLabel htmlFor="promote-message">Message</FieldLabel>
              <Input
                id="promote-message"
                value={message}
                placeholder="Optional"
                onChange={(event) => setMessage(event.target.value)}
              />
            </Field>
          </FieldGroup>

          <DialogError error={promote.error} />
          <DialogFooter>
            <DialogClose render={<Button variant="outline" />}>
              Cancel
            </DialogClose>
            <Button
              disabled={promote.isPending || !canPromote}
              onClick={() =>
                promote.mutate({
                  branch: target,
                  rolloutPercent: Math.min(
                    100,
                    Math.max(0, Number(promoteRollout) || 0)
                  ),
                  ...(message.trim() === "" ? {} : { message: message.trim() }),
                })
              }
            >
              {promote.isPending && <Spinner />}
              Promote
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={open === "rollback"}
        onOpenChange={(next) => !next && setOpen(null)}
      >
        <AlertDialogContent className="sm:max-w-sm">
          <AlertDialogHeader>
            <AlertDialogTitle>Republish {shortId(group.id)}?</AlertDialogTitle>
            <AlertDialogDescription className="text-pretty">
              Becomes the update {group.branch} serves for{" "}
              {group.updates
                .map(
                  (update) =>
                    `${update.platform} ${update.runtimeVersion.slice(0, 8)}`
                )
                .join(" and ")}
              .
            </AlertDialogDescription>
          </AlertDialogHeader>
          <GroupPreview group={group} />
          <DialogError error={promote.error} />
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={promote.isPending}
              onClick={() => promote.mutate({ branch: group.branch })}
            >
              {promote.isPending && <Spinner />}
              Republish
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog
        open={open === "rollout"}
        onOpenChange={(next) => !next && setOpen(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rollout for {shortId(group.id)}</DialogTitle>
            <DialogDescription className="text-pretty">
              Rollouts only increase, so the new share has to be above the
              current one. 100 completes it and every device gets the update.
            </DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="rollout-percent">New share</FieldLabel>
              <Input
                id="rollout-percent"
                type="number"
                inputMode="numeric"
                min={currentPercent + 1}
                max={100}
                className="tabular-nums"
                value={percentInput}
                onChange={(event) => setPercentInput(event.target.value)}
              />
              <FieldDescription>
                Between {currentPercent + 1} and 100 percent.
              </FieldDescription>
            </Field>
            <div className="flex flex-wrap gap-1.5">
              {quickPicks.map((pick) => (
                <Button
                  key={pick}
                  size="xs"
                  variant={
                    nextPercent === pick && validPercent ? "default" : "outline"
                  }
                  disabled={pick <= currentPercent}
                  className="tabular-nums"
                  onClick={() => setPercentInput(String(pick))}
                >
                  {pick}%
                </Button>
              ))}
            </div>
          </FieldGroup>
          <div className="flex items-center gap-2 rounded-lg bg-muted/40 px-3 py-2 text-sm tabular-nums">
            <span className="text-muted-foreground">{currentPercent}%</span>
            <span aria-hidden="true" className="text-muted-foreground">
              →
            </span>
            <span className="font-medium">
              {validPercent ? `${nextPercent}%` : "pick a higher share"}
            </span>
          </div>
          <DialogError error={rollout.error} />
          <DialogFooter>
            <DialogClose render={<Button variant="outline" />}>
              Cancel
            </DialogClose>
            <Button
              disabled={rollout.isPending || !validPercent}
              onClick={() => rollout.mutate(nextPercent)}
            >
              {rollout.isPending && <Spinner />}
              {nextPercent === 100 ? "Complete rollout" : "Set rollout"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

/** What is actually in the group, so a republish is never a guess. */
function GroupPreview({ group }: { readonly group: Group }) {
  return (
    <div className="flex flex-col gap-2 rounded-lg bg-muted/40 p-3 text-sm">
      <div className="flex flex-wrap gap-1.5">
        {group.updates.map((update) => (
          <PlatformChip
            key={update.id}
            platform={update.platform}
            runtimeVersion={update.runtimeVersion}
          />
        ))}
      </div>
      <span className="truncate">{group.message ?? "Untitled update"}</span>
      <span className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
        {group.gitCommit !== null && (
          <>
            <CommitBadge value={group.gitCommit} />
            <span aria-hidden="true">&middot;</span>
          </>
        )}
        {group.actor !== null && (
          <>
            <span>by {group.actor}</span>
            <span aria-hidden="true">&middot;</span>
          </>
        )}
        <span title={absoluteTime(group.createdAt)}>
          {relativeTime(group.createdAt)}
        </span>
      </span>
    </div>
  )
}
