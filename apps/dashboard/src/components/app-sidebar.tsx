import * as React from "react"
import { Link } from "@tanstack/react-router"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  DashboardSquare01Icon,
  GitBranchIcon,
} from "@hugeicons/core-free-icons"

import { NavMain } from "@/components/nav-main"
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from "@/components/ui/sidebar"

export function AppSidebar({ ...props }: React.ComponentProps<typeof Sidebar>) {
  return (
    <Sidebar className="border-r-0" {...props}>
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" render={<Link to="/" />}>
              <img
                src="/open-ota-wordmark.png"
                alt="Open OTA"
                className="h-5 w-auto dark:invert"
              />
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <NavMain
            items={[
              {
                title: "Overview",
                icon: (
                  <HugeiconsIcon icon={DashboardSquare01Icon} strokeWidth={2} />
                ),
                to: "/",
                exact: true,
              },
              {
                title: "Branches",
                icon: <HugeiconsIcon icon={GitBranchIcon} strokeWidth={2} />,
                to: "/branches",
              },
            ]}
          />
        </SidebarGroup>
      </SidebarContent>
      <SidebarRail />
    </Sidebar>
  )
}
