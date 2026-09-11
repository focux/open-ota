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

import { api, devicePageSize } from "@/lib/api"
import type { Device, DeviceCheck } from "@/lib/api"
import { Route as DeviceRoute } from "./_dashboard.devices.$clientId"
import { Route as DevicesRoute } from "./_dashboard.devices.index"

const navigate = vi.fn()

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof TanStackRouter>()),
  useNavigate: () => navigate,
  Link: ({ children }: { children: ReactNode }) => <a href="/">{children}</a>,
}))

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  navigate.mockReset()
})

const device: Device = {
  clientId: "8b2f77c0-0000-4000-8000-000000000001",
  platform: "ios",
  runtimeVersion: "3f2a9c11d4",
  channel: "production",
  currentUpdateId: "11111111-0000-4000-8000-000000000000",
  embeddedUpdateId: "22222222-0000-4000-8000-000000000000",
  servedUpdateId: "33333333-0000-4000-8000-000000000000",
  country: "CA",
  city: "Montreal",
  firstSeenAt: "2026-09-01T10:00:00.000Z",
  lastSeenAt: "2026-09-10T10:00:00.000Z",
}

const check: DeviceCheck = {
  firstCheckedAt: "2026-09-10T09:00:00.000Z",
  lastCheckedAt: "2026-09-10T10:00:00.000Z",
  checks: 42,
  platform: "ios",
  runtimeVersion: "3f2a9c11d4",
  channel: "production",
  currentUpdateId: device.currentUpdateId,
  embeddedUpdateId: device.embeddedUpdateId,
  decision: "none",
  reason: "no-update-for-runtime",
  servedUpdateId: null,
  fatalError: null,
}

const mount = async (
  Page: React.ComponentType & { preload?: () => unknown }
) => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  await Page.preload?.()
  await act(async () => {
    render(
      <QueryClientProvider client={client}>
        <Page />
      </QueryClientProvider>
    )
  })
  return client
}

describe("the device pages", () => {
  it("says why the newest check was answered with nothing", async () => {
    vi.spyOn(DeviceRoute, "useParams").mockReturnValue({
      clientId: device.clientId,
    })
    vi.spyOn(api, "device").mockResolvedValue({ device, checks: [check] })
    const Page = DeviceRoute.options.component!
    const client = await mount(Page)

    expect(
      await screen.findAllByText(
        "Nothing to serve: the branch has no update for runtime 3f2a9c11…"
      )
    ).toHaveLength(2)
    expect(screen.getByText(/Recorded 42 times/)).toBeDefined()
    // Served and running disagree on the device row, which is its own answer.
    expect(screen.getByText(/Served is ahead of running/)).toBeDefined()
    client.clear()
  })

  it("sends a client id straight to that device", async () => {
    vi.spyOn(api, "overview").mockResolvedValue({
      channels: [],
      branches: [],
      latest: [],
    })
    const search = vi.spyOn(api, "devices").mockResolvedValue({ devices: [] })
    const Page = DevicesRoute.options.component!
    const client = await mount(Page)

    fireEvent.change(screen.getByLabelText("Client id"), {
      target: { value: ` ${device.clientId} ` },
    })
    await waitFor(() => {
      expect(navigate).toHaveBeenCalledWith({
        to: "/devices/$clientId",
        params: { clientId: device.clientId },
      })
    })
    expect(search).toHaveBeenCalledWith({}, undefined)
    client.clear()
  })

  it("asks for the next page starting at the device this one ended with", async () => {
    vi.spyOn(api, "overview").mockResolvedValue({
      channels: [],
      branches: [],
      latest: [],
    })
    const page = Array.from({ length: devicePageSize }, (_, index) => ({
      ...device,
      clientId: `device-${index}`,
    }))
    const search = vi
      .spyOn(api, "devices")
      .mockResolvedValueOnce({ devices: page })
      .mockResolvedValue({ devices: [] })
    const Page = DevicesRoute.options.component!
    const client = await mount(Page)

    await act(async () => {
      fireEvent.click(await screen.findByRole("button", { name: "Load more" }))
    })
    expect(search).toHaveBeenLastCalledWith({}, `device-${devicePageSize - 1}`)
    client.clear()
  })

  it("searches on the filters that were filled in", async () => {
    vi.spyOn(api, "overview").mockResolvedValue({
      channels: [],
      branches: [],
      latest: [],
    })
    const search = vi.spyOn(api, "devices").mockResolvedValue({ devices: [] })
    const Page = DevicesRoute.options.component!
    const client = await mount(Page)

    fireEvent.click(screen.getByRole("button", { name: /Filters/ }))
    fireEvent.click(screen.getByRole("button", { name: /^Country/ }))
    fireEvent.change(await screen.findByLabelText("Country"), {
      target: { value: "CA" },
    })
    await waitFor(() => {
      expect(search).toHaveBeenLastCalledWith(
        { runtimeVersion: "", currentUpdateId: "", country: "CA" },
        undefined
      )
    })
    expect(navigate).not.toHaveBeenCalled()
    client.clear()
  })
})
