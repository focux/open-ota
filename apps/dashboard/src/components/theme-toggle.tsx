import { HugeiconsIcon } from "@hugeicons/react"
import { Moon02Icon, Sun03Icon } from "@hugeicons/core-free-icons"
import { useTheme } from "next-themes"

import { useHydrated } from "@/lib/queries"
import { Button } from "@/components/ui/button"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"

/** Flips the document theme. Ghost until hover. */
export function ThemeToggle() {
  const hydrated = useHydrated()
  const { resolvedTheme, setTheme } = useTheme()
  const dark = hydrated && resolvedTheme === "dark"
  const label = dark ? "Switch to light mode" : "Switch to dark mode"

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={label}
            onClick={() => setTheme(dark ? "light" : "dark")}
          />
        }
      >
        <HugeiconsIcon icon={dark ? Sun03Icon : Moon02Icon} strokeWidth={2} />
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}
