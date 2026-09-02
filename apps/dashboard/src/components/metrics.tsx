import { HugeiconsIcon } from "@hugeicons/react"
import {
  AndroidIcon,
  AppleIcon,
  Copy01Icon,
  InformationCircleIcon,
  SmartPhone01Icon,
} from "@hugeicons/core-free-icons"

import type { Platform } from "@/lib/api"
import { plural, shortId } from "@/lib/format"
import type { Adoption } from "@/lib/metrics"
import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Progress } from "@/components/ui/progress"
import { toast } from "@/components/ui/toast"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"

const runtimePreview = 8

const platformIcons = {
  ios: AppleIcon,
  android: AndroidIcon,
}

/** Percent above a 64px bar, with the raw counts on hover. */
export function AdoptionCell({ adoption }: { readonly adoption: Adoption }) {
  if (adoption.devices === 0) {
    return <span className="text-xs text-muted-foreground">no data</span>
  }
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <div className="ml-auto flex w-16 cursor-default flex-col items-end gap-1" />
        }
      >
        <span className="text-sm tabular-nums">{adoption.percent}%</span>
        <Progress value={adoption.percent} className="w-16" />
      </TooltipTrigger>
      <TooltipContent>
        {adoption.running.toLocaleString()} of{" "}
        {plural(adoption.devices, "device")} on this runtime
      </TooltipContent>
    </Tooltip>
  )
}

/** Platform and the runtime version it targets, as one chip. */
export function PlatformChip({
  platform,
  runtimeVersion,
}: {
  readonly platform: Platform
  readonly runtimeVersion: string
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={<Badge variant="outline" className="cursor-default gap-1.5" />}
      >
        <HugeiconsIcon
          icon={platformIcons[platform] ?? SmartPhone01Icon}
          strokeWidth={2}
          data-icon="inline-start"
        />
        <span className="font-mono">
          {runtimeVersion.slice(0, runtimePreview)}
        </span>
      </TooltipTrigger>
      <TooltipContent className="font-mono text-xs">
        {platform} {runtimeVersion}
      </TooltipContent>
    </Tooltip>
  )
}

/** Fingerprints are long; show the head and keep the whole value one hover away. */
export function RuntimeVersion({ value }: { readonly value: string }) {
  if (value.length <= runtimePreview + 2) {
    return <span className="font-mono text-xs">{value}</span>
  }
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span className="cursor-default font-mono text-xs underline decoration-muted-foreground/50 decoration-dotted underline-offset-4" />
        }
      >
        {value.slice(0, runtimePreview)}...
      </TooltipTrigger>
      <TooltipContent className="font-mono text-xs">{value}</TooltipContent>
    </Tooltip>
  )
}

export function CommitBadge({ value }: { readonly value: string }) {
  return <span className="font-mono">{value.slice(0, 7)}</span>
}

/** The short id, with the full one a click away on the clipboard. */
export function CopyId({ value }: { readonly value: string }) {
  return <CopyButton value={value} label={shortId(value)} />
}

/** A hash is unreadable in full; the ends are enough to tell two apart. */
export function maskHash(value: string): string {
  return value.length <= 14
    ? value
    : `${value.slice(0, 8)}...${value.slice(-4)}`
}

export function CopyButton({
  value,
  label,
}: {
  readonly value: string
  readonly label: string
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="xs"
            className="font-mono"
            onClick={(event) => {
              event.stopPropagation()
              void navigator.clipboard
                .writeText(value)
                .then(() => toast.add({ title: "Copied.", type: "success" }))
                .catch(() =>
                  toast.add({ title: "Could not copy.", type: "error" })
                )
            }}
          />
        }
      >
        {label}
        <HugeiconsIcon icon={Copy01Icon} strokeWidth={2} />
      </TooltipTrigger>
      <TooltipContent className="font-mono text-xs">{value}</TooltipContent>
    </Tooltip>
  )
}

/** Exactly one chip says what a group is doing on its branch. */
export function StatusChip({
  serving,
  rollout,
  rollback,
}: {
  readonly serving: boolean
  readonly rollout: number
  readonly rollback: boolean
}) {
  if (rollback) {
    return (
      <Badge variant="destructive">
        <Dot className="bg-destructive" />
        Rollback
      </Badge>
    )
  }
  if (serving && rollout < 100) {
    return (
      <Badge variant="secondary" className="tabular-nums">
        <Dot className="bg-amber-500" />
        Rolling out {rollout}%
      </Badge>
    )
  }
  if (serving) {
    return (
      <Badge variant="secondary">
        <Dot className="bg-emerald-500" />
        Serving
      </Badge>
    )
  }
  return (
    <Badge variant="outline" className="text-muted-foreground">
      Superseded
    </Badge>
  )
}

export function Dot({ className }: { readonly className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn("size-1.5 shrink-0 rounded-full", className)}
    />
  )
}

/**
 * One number an operator reads after a publish, with the line that explains it.
 * A null value means the server has not told us yet, which is not a zero.
 */
export function StatCard({
  index,
  label,
  value,
  suffix,
  hint,
}: {
  readonly index: number
  readonly label: string
  readonly value: string | null
  readonly suffix?: string
  readonly hint: string
}) {
  return (
    <Card
      size="sm"
      className="animate-in duration-200 ease-out fade-in-0 [animation-fill-mode:backwards] slide-in-from-bottom-1"
      style={{ animationDelay: `${index * 40}ms` }}
    >
      <CardContent className="flex flex-col gap-2">
        <span className="flex items-start justify-between gap-2">
          <span className="text-xs font-medium text-muted-foreground">
            {label}
          </span>
          <Tooltip>
            <TooltipTrigger
              render={
                <span
                  tabIndex={0}
                  aria-label={hint}
                  className="-m-1 cursor-default rounded-sm p-1 text-muted-foreground/60 transition-colors duration-150 ease-out outline-none hover:text-muted-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
                />
              }
            >
              <HugeiconsIcon
                icon={InformationCircleIcon}
                strokeWidth={2}
                className="size-3.5"
              />
            </TooltipTrigger>
            <TooltipContent className="max-w-56 text-pretty">
              {hint}
            </TooltipContent>
          </Tooltip>
        </span>
        <span className="flex items-baseline gap-1.5">
          <span
            className={cn(
              "text-2xl leading-none font-semibold tabular-nums",
              value === null && "text-base font-normal text-muted-foreground"
            )}
          >
            {value ?? "no data"}
          </span>
          {value !== null && suffix ? (
            <span className="text-sm text-muted-foreground tabular-nums">
              {suffix}
            </span>
          ) : null}
        </span>
      </CardContent>
    </Card>
  )
}
