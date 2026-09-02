import { useState } from "react"
import { useNavigate } from "@tanstack/react-router"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"

import { api } from "@/lib/api"
import type { RollbackMode, RollbackTarget } from "@/lib/api"
import { plural, relativeTime, shortId } from "@/lib/format"
import { rollbackPlanQueryOptions } from "@/lib/queries"
import { DialogError, ErrorState } from "@/components/feedback"
import { PlatformChip } from "@/components/metrics"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { toast } from "@/components/ui/toast"

interface Choice {
  readonly included: boolean
  readonly mode: RollbackMode
}

const keyOf = (target: RollbackTarget) =>
  `${target.platform} ${target.runtimeVersion}`

/**
 * The on-call flow: pick which builds go back and to what, without ever
 * naming a runtime version by hand.
 */
export function RollbackDialog({
  branch,
  open,
  onOpenChange,
  messages,
}: {
  readonly branch: string
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
  /** Group id to message, so a row can name what it is serving. */
  readonly messages: ReadonlyMap<string, string | null>
}) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const plan = useQuery({ ...rollbackPlanQueryOptions(branch), enabled: open })
  const [choices, setChoices] = useState<ReadonlyMap<string, Choice>>(new Map())

  const targets = plan.data?.targets ?? []
  const choiceFor = (target: RollbackTarget): Choice =>
    choices.get(keyOf(target)) ?? {
      included: true,
      mode: target.previous === null ? "embedded" : "previous",
    }
  const set = (target: RollbackTarget, next: Partial<Choice>) =>
    setChoices(
      new Map(choices).set(keyOf(target), { ...choiceFor(target), ...next })
    )

  const chosen = targets.filter((target) => choiceFor(target).included)
  const toPrevious = chosen.filter(
    (target) => choiceFor(target).mode === "previous"
  )
  const toEmbedded = chosen.filter(
    (target) => choiceFor(target).mode === "embedded"
  )
  const devicesIn = (rows: ReadonlyArray<RollbackTarget>) =>
    rows.reduce((total, target) => total + target.devices, 0)

  const rollback = useMutation({
    mutationFn: () =>
      api.rollback(branch, {
        targets: chosen.map((target) => ({
          platform: target.platform,
          runtimeVersion: target.runtimeVersion,
          mode: choiceFor(target).mode,
        })),
      }),
    onSuccess: async () => {
      onOpenChange(false)
      toast.add({ title: `Rolled back ${branch}`, type: "success" })
      await queryClient.invalidateQueries()
      await navigate({ to: "/branches/$name", params: { name: branch } })
    },
  })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Roll back {branch}</DialogTitle>
          <DialogDescription className="text-pretty">
            Every build below goes to the chosen state on its next launch.
          </DialogDescription>
        </DialogHeader>

        {plan.isError ? (
          <ErrorState
            thing="the rollback plan"
            error={plan.error}
            onRetry={() => void plan.refetch()}
          />
        ) : plan.isPending ? (
          <div className="flex flex-col gap-3">
            <Skeleton className="h-20 w-full" />
            <Skeleton className="h-20 w-full" />
          </div>
        ) : targets.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {branch} is not serving anything, so there is nothing to roll back.
          </p>
        ) : (
          <div className="flex max-h-80 flex-col gap-2 overflow-y-auto">
            {targets.map((target) => {
              const choice = choiceFor(target)
              const previousLabel =
                target.previous === null
                  ? null
                  : (messages.get(target.previous.groupId) ??
                    shortId(target.previous.id))
              return (
                <div
                  key={keyOf(target)}
                  className="flex flex-col gap-2 rounded-lg border p-3"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <Checkbox
                      id={`include-${keyOf(target)}`}
                      checked={choice.included}
                      onCheckedChange={(checked) =>
                        set(target, { included: Boolean(checked) })
                      }
                    />
                    <PlatformChip
                      platform={target.platform}
                      runtimeVersion={target.runtimeVersion}
                    />
                    <span className="text-xs text-muted-foreground">
                      Now serving:{" "}
                      {target.current.kind === "rollback"
                        ? "Rolled back to embedded"
                        : (messages.get(target.current.groupId) ??
                          shortId(target.current.id))}
                    </span>
                    <span className="ml-auto text-xs text-muted-foreground tabular-nums">
                      {plural(target.devices, "device")}
                    </span>
                  </div>
                  <RadioGroup
                    value={choice.mode}
                    disabled={!choice.included}
                    onValueChange={(mode) =>
                      mode !== null &&
                      set(target, { mode: mode as RollbackMode })
                    }
                    className="grid-cols-1 gap-1.5 sm:grid-cols-2"
                  >
                    {target.previous !== null && (
                      <Label className="flex items-start gap-2 rounded-lg border p-2 text-xs font-normal has-data-checked:border-primary/40 has-data-checked:bg-primary/5">
                        <RadioGroupItem value="previous" />
                        <span className="flex flex-col gap-0.5">
                          <span className="font-medium">Previous update</span>
                          <span className="text-muted-foreground">
                            {previousLabel},{" "}
                            {relativeTime(target.previous.createdAt)}
                          </span>
                        </span>
                      </Label>
                    )}
                    <Label className="flex items-start gap-2 rounded-lg border p-2 text-xs font-normal has-data-checked:border-primary/40 has-data-checked:bg-primary/5">
                      <RadioGroupItem value="embedded" />
                      <span className="flex flex-col gap-0.5">
                        <span className="font-medium">
                          Embedded JS of the build
                        </span>
                        {target.previous === null && (
                          <span className="text-muted-foreground">
                            No earlier update on this branch
                          </span>
                        )}
                      </span>
                    </Label>
                  </RadioGroup>
                </div>
              )
            })}
          </div>
        )}

        {chosen.length > 0 && (
          <p className="text-sm text-pretty text-muted-foreground tabular-nums">
            {toPrevious.length > 0 &&
              `${plural(devicesIn(toPrevious), "device")} go back to their previous update`}
            {toPrevious.length > 0 && toEmbedded.length > 0 && ", "}
            {toEmbedded.length > 0 &&
              `${plural(devicesIn(toEmbedded), "device")} go back to their build's embedded JS`}
            .
          </p>
        )}

        <DialogError error={rollback.error} />
        <DialogFooter>
          <DialogClose render={<Button variant="outline" />}>
            Cancel
          </DialogClose>
          <Button
            variant="destructive"
            disabled={rollback.isPending || chosen.length === 0}
            onClick={() => rollback.mutate()}
          >
            {rollback.isPending && <Spinner />}
            Roll back
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
