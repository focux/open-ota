// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import type * as TanStackRouter from "@tanstack/react-router"
import type { ReactNode } from "react"

import { api } from "@/lib/api"
import type { Group, Metrics } from "@/lib/api"
import { GroupActions } from "@/components/group-actions"
import { RollbackDialog } from "@/components/rollback-dialog"
import { TooltipProvider } from "@/components/ui/tooltip"

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof TanStackRouter>()),
  useNavigate: () => vi.fn(),
}))

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const group: Group = {
  id: "group-1",
  branch: "staging",
  message: "Ready to promote",
  gitCommit: null,
  actor: null,
  createdAt: "2026-09-01T00:00:00.000Z",
  updates: [
    {
      kind: "rollback",
      id: "update-1",
      groupId: "group-1",
      branch: "staging",
      platform: "ios",
      runtimeVersion: "runtime-1",
      rolloutPercent: 100,
      createdAt: "2026-09-01T00:00:00.000Z",
    },
  ],
}

function providers(client: QueryClient, children: ReactNode) {
  return (
    <QueryClientProvider client={client}>
      <TooltipProvider>{children}</TooltipProvider>
    </QueryClientProvider>
  )
}

describe("operation dialogs", () => {
  it("resets rollback selections when switching branches with the same runtime", async () => {
    vi.spyOn(api, "rollbackPlan").mockImplementation(async (branch) => ({
      targets: [
        {
          platform: "ios",
          runtimeVersion: "runtime-1",
          current: { ...group.updates[0], branch },
          previous: null,
          devices: 1,
        },
      ],
    }))
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    const dialog = (branch: string) =>
      providers(
        client,
        <RollbackDialog
          branch={branch}
          open
          onOpenChange={() => {}}
          messages={new Map()}
        />
      )
    const view = render(dialog("staging"))
    const checkbox = await screen.findByRole("checkbox")
    expect(checkbox.getAttribute("aria-checked")).toBe("true")
    fireEvent.click(checkbox)
    expect(checkbox.getAttribute("aria-checked")).toBe("false")

    await act(async () => view.rerender(dialog("production")))

    expect(
      (await screen.findByRole("checkbox")).getAttribute("aria-checked")
    ).toBe("true")
    expect(
      screen.getByRole("button", { name: "Roll back" }).hasAttribute("disabled")
    ).toBe(false)
    client.clear()
  })

  it.each([0, 3])(
    "counts only destination-channel devices in promotion reach (%i devices)",
    async (count) => {
      const metrics: Metrics = {
        online: 0,
        runtimes: [
          {
            channel: "testers",
            platform: "ios",
            runtimeVersion: "runtime-1",
            devices: 80,
          },
          {
            channel: "release",
            platform: "ios",
            runtimeVersion: "runtime-1",
            devices: count,
          },
        ],
        updates: [],
        failures: [],
        countries: [],
        segments: [],
      }
      const client = new QueryClient()
      render(
        providers(
          client,
          <GroupActions
            group={group}
            branches={["staging", "production"]}
            channels={[
              {
                name: "testers",
                branch: "staging",
                updatedAt: group.createdAt,
              },
              {
                name: "release",
                branch: "production",
                updatedAt: group.createdAt,
              },
            ]}
            metrics={metrics}
            current
            layout="buttons"
          />
        )
      )
      fireEvent.click(screen.getByRole("button", { name: "Promote to..." }))

      expect(
        await screen.findByText(count === 0 ? "no devices" : "3 devices")
      ).toBeDefined()
      expect(screen.queryByText(`${80 + count} devices`)).toBeNull()
      expect(
        screen.queryByText("Some builds have no devices yet") !== null
      ).toBe(count === 0)
      client.clear()
    }
  )
})
