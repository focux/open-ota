import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar"

/**
 * The block's nav takes a url and renders an anchor; ours takes the router
 * Link element so the active state and preloading come from the router.
 */
export function NavMain({
  items,
}: {
  readonly items: ReadonlyArray<{
    readonly title: string
    readonly icon: React.ReactNode
    readonly render: React.ReactElement
  }>
}) {
  return (
    <SidebarMenu>
      {items.map((item) => (
        <SidebarMenuItem key={item.title}>
          <SidebarMenuButton render={item.render}>
            {item.icon}
            <span>{item.title}</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
      ))}
    </SidebarMenu>
  )
}
