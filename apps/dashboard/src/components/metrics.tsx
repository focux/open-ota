import { HugeiconsIcon } from "@hugeicons/react"
import {
  AndroidIcon,
  AppleIcon,
  Copy01Icon,
  InformationCircleIcon,
} from "@hugeicons/core-free-icons"

import type { Platform } from "@/lib/api"
import { plural, shortId } from "@/lib/format"
import type { Adoption, AdoptionBasis } from "@/lib/metrics"
import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { FrameTile } from "@/components/frame"
import type { IconSvgElement } from "@hugeicons/react"
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

/**
 * A value that does not apply yet. A quiet dash in the cell, the reason for
 * screen readers. Words only belong where the absence itself means something.
 */
export function EmptyValue({ reason }: { readonly reason: string }) {
  return (
    <span className="text-muted-foreground">
      <span aria-hidden="true">&ndash;</span>
      <span className="sr-only">{reason}</span>
    </span>
  )
}

/** The population the percent divides by, named the way the tooltip reads it. */
const population: Record<AdoptionBasis, string> = {
  runtime: "on this runtime",
  directed: "it directed",
  mixed: "these updates target",
}

const nothingYet: Record<AdoptionBasis, string> = {
  runtime: "No devices on this build yet",
  directed: "No devices directed here yet",
  mixed: "No devices for these updates yet",
}

/** Percent above a 64px bar, with the raw counts on hover. */
export function AdoptionCell({ adoption }: { readonly adoption: Adoption }) {
  // Gate on the same population the percent divides by: a rollback can direct
  // devices that no longer report this runtime.
  if (adoption.base === 0) {
    return <EmptyValue reason={nothingYet[adoption.basis]} />
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
        {adoption.running.toLocaleString()} of {plural(adoption.base, "device")}{" "}
        {population[adoption.basis]}
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
          icon={platformIcons[platform]}
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

/** A git sha as an inline code chip. */
export function CommitBadge({ value }: { readonly value: string }) {
  return (
    <span className="rounded-md bg-foreground/[0.04] px-1.5 py-0.5 font-mono text-xs shadow-hairline">
      {value.slice(0, 7)}
    </span>
  )
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
      <Badge variant="outline" className="tabular-nums">
        <Dot className="bg-amber-500" />
        Rolling out {rollout}%
      </Badge>
    )
  }
  if (serving) {
    return (
      <Badge variant="outline">
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
  icon,
  tone,
  label,
  value,
  suffix,
  hint,
}: {
  readonly index: number
  readonly icon: IconSvgElement
  /** The icon tile's fill. The only place a stat spends color. */
  readonly tone: string
  readonly label: string
  readonly value: string | null
  readonly suffix?: string
  readonly hint: string
}) {
  return (
    <FrameTile
      className="animate-in duration-200 ease-out fade-in-0 [animation-fill-mode:backwards] slide-in-from-bottom-1"
      style={{ animationDelay: `${index * 40}ms` }}
    >
      <span className="flex items-start justify-between gap-2">
        <span
          aria-hidden="true"
          className={cn(
            "flex size-9 items-center justify-center rounded-lg text-white",
            tone
          )}
        >
          <HugeiconsIcon icon={icon} strokeWidth={2} className="size-4.5" />
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
      <div className="flex flex-col gap-1">
        <span className="text-sm font-medium">{label}</span>
        <span className="flex items-baseline gap-1.5">
          <span
            className={cn(
              "text-2xl leading-none font-semibold tabular-nums",
              value === null && "text-base font-normal text-muted-foreground"
            )}
          >
            {value ?? "\u2013"}
          </span>
          {value !== null && suffix ? (
            <span className="text-sm text-muted-foreground tabular-nums">
              {suffix}
            </span>
          ) : null}
        </span>
      </div>
    </FrameTile>
  )
}
