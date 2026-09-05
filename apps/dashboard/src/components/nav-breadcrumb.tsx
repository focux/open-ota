import { Link, useRouterState } from "@tanstack/react-router"

import { shortId } from "@/lib/format"
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb"

/** What sits after the "Overview" root crumb, for each shape of URL. */
function trail(pathname: string): ReadonlyArray<string> {
  const [section, value] = pathname.split("/").filter(Boolean)
  if (section === "branches") {
    return value ? ["Branches", decodeURIComponent(value)] : ["Branches"]
  }
  if (section === "groups" && value)
    return ["Update group", shortId(decodeURIComponent(value))]
  return []
}

export function NavBreadcrumb() {
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  })
  const crumbs = trail(pathname)

  return (
    <Breadcrumb className="hidden sm:block">
      <BreadcrumbList>
        <BreadcrumbItem>
          {crumbs.length === 0 ? (
            <BreadcrumbPage>Overview</BreadcrumbPage>
          ) : (
            <BreadcrumbLink
              render={
                <Link
                  to="/"
                  className="rounded-sm transition-colors duration-150 ease-out outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
                />
              }
            >
              Overview
            </BreadcrumbLink>
          )}
        </BreadcrumbItem>
        {crumbs.map((crumb, index) => (
          <span key={crumb} className="contents">
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              {index === crumbs.length - 1 ? (
                <BreadcrumbPage>{crumb}</BreadcrumbPage>
              ) : (
                crumb
              )}
            </BreadcrumbItem>
          </span>
        ))}
      </BreadcrumbList>
    </Breadcrumb>
  )
}
