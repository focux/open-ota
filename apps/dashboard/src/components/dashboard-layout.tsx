import { Outlet } from "@tanstack/react-router"

import { AppSidebar } from "@/components/app-sidebar"
import { NavActions } from "@/components/nav-actions"
import { NavBreadcrumb } from "@/components/nav-breadcrumb"
import { UnreachableBanner } from "@/components/unreachable-banner"
import { Separator } from "@/components/ui/separator"
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar"

export function DashboardLayout() {
  return (
    <SidebarProvider>
      <AppSidebar />
      <SidebarInset className="min-w-0">
        <header className="flex h-14 shrink-0 items-center gap-2">
          <div className="flex flex-1 items-center gap-2 px-3">
            <SidebarTrigger />
            <Separator
              orientation="vertical"
              className="mr-2 data-vertical:h-4 data-vertical:self-auto"
            />
            <NavBreadcrumb />
          </div>
          <div className="ml-auto px-3">
            <NavActions />
          </div>
        </header>
        <div className="flex min-w-0 flex-1 flex-col space-y-6 px-6 py-6">
          <UnreachableBanner />
          <Outlet />
        </div>
      </SidebarInset>
    </SidebarProvider>
  )
}
