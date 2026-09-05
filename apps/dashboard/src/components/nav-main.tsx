import { Link, useMatchRoute } from "@tanstack/react-router"
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar"

export function NavMain({
  items,
}: {
  readonly items: ReadonlyArray<{
    readonly title: string
    readonly icon: React.ReactNode
    readonly to: "/" | "/branches"
    readonly exact?: boolean
  }>
}) {
  const matchRoute = useMatchRoute()

  return (
    <SidebarMenu>
      {items.map((item) => (
        <SidebarMenuItem key={item.title}>
          <SidebarMenuButton
            render={<Link to={item.to} activeOptions={{ exact: item.exact }} />}
            isActive={matchRoute({ to: item.to, fuzzy: !item.exact }) !== false}
          >
            {item.icon}
            <span>{item.title}</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
      ))}
    </SidebarMenu>
  )
}
