import { useMatchRoute } from "@tanstack/react-router"
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
  const matchRoute = useMatchRoute()

  const activeItem = (render: React.ReactElement): boolean => {
    const linkProps = render.props as {
      to?: string
      from?: string
      activeOptions?: { exact?: boolean }
    }
    const to = linkProps.to
    if (typeof to !== "string") {
      return false
    }

    const from = linkProps.from
    const exact = !!linkProps.activeOptions?.exact
    return (
      matchRoute({
        to: to as any,
        fuzzy: !exact,
        from: from as any,
        // useMatchRoute uses `fuzzy` for prefix matching; exact mode is fuzzy: false
      }) !== false
    )
  }

  return (
    <SidebarMenu>
      {items.map((item) => (
        <SidebarMenuItem key={item.title}>
          <SidebarMenuButton
            render={item.render}
            isActive={activeItem(item.render)}
          >
            {item.icon}
            <span>{item.title}</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
      ))}
    </SidebarMenu>
  )
}
