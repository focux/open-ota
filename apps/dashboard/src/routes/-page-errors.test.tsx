// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import type * as TanStackRouter from "@tanstack/react-router"
import type { ReactNode } from "react"

import { api, DashboardApiError } from "@/lib/api"
import { Route as BranchRoute } from "./_dashboard.branches.$name"
import { Route as GroupRoute } from "./_dashboard.groups.$id"
import { Route as BranchesRoute } from "./_dashboard.branches.index"

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof TanStackRouter>()),
  useNavigate: () => vi.fn(),
  Link: ({ children }: { children: ReactNode }) => <a href="/">{children}</a>,
}))

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe("page-specific request failures", () => {
  it("distinguishes pending and failed branch summaries from empty history", async () => {
    vi.spyOn(api, "overview").mockResolvedValue({
      channels: [],
      branches: ["staging"],
      latest: [],
    })
    let rejectSummary!: (error: Error) => void
    const pending = new Promise<never>((_resolve, reject) => {
      rejectSummary = reject
    })
    const read = vi
      .spyOn(api, "groups")
      .mockReturnValueOnce(pending)
      .mockResolvedValue({ groups: [] })
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    const Page = BranchesRoute.options.component!
    await Page.preload?.()
    await act(async () => {
      render(
        <QueryClientProvider client={client}>
          <Page />
        </QueryClientProvider>
      )
    })

    expect(await screen.findByText("Loading updates")).toBeDefined()
    expect(screen.queryByText("No updates yet")).toBeNull()
    await waitFor(() => expect(read).toHaveBeenCalledTimes(1))
    await act(async () => rejectSummary(new Error("Summary unavailable")))
    expect(await screen.findByText("Could not load updates")).toBeDefined()
    expect(screen.queryByText("No updates yet")).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "Try again" }))
    expect(await screen.findByText("No updates yet")).toBeDefined()
    expect(read).toHaveBeenCalledTimes(2)
    client.clear()
  })

  it.each(["branch", "group"] as const)(
    "keeps an error and retry visible when only the %s request fails",
    async (page) => {
      vi.spyOn(api, "overview").mockResolvedValue({
        channels: [],
        branches: ["staging"],
        latest: [],
      })
      vi.spyOn(api, "metrics").mockResolvedValue({
        online: 0,
        runtimes: [],
        updates: [],
        failures: [],
        countries: [],
        segments: [],
      })
      vi.spyOn(BranchRoute, "useParams").mockReturnValue({ name: "staging" })
      vi.spyOn(GroupRoute, "useParams").mockReturnValue({ id: "group-1" })
      const read = vi.spyOn(api, page === "branch" ? "groups" : "group")
      read.mockRejectedValue(
        new DashboardApiError({
          message: "The updates server is temporarily unavailable.",
          kind: "unreachable",
          status: 503,
        })
      )
      const client = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      })
      const Page =
        page === "branch"
          ? BranchRoute.options.component!
          : GroupRoute.options.component!
      await Page.preload?.()

      await act(async () => {
        render(
          <QueryClientProvider client={client}>
            <Page />
          </QueryClientProvider>
        )
      })

      expect(
        await screen.findByText(
          "The updates server is temporarily unavailable."
        )
      ).toBeDefined()
      fireEvent.click(screen.getByRole("button", { name: "Try again" }))
      await waitFor(() => expect(read).toHaveBeenCalledTimes(2))
      client.clear()
    }
  )
})
