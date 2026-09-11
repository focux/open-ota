import { useState } from "react"
import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { useInfiniteQuery, useQuery } from "@tanstack/react-query"

import type { DeviceFilters } from "@/lib/api"
import {
  devicesQueryOptions,
  overviewQueryOptions,
  useHydrated,
} from "@/lib/queries"
import { ErrorState, isUnreachable } from "@/components/feedback"
import {
  anyDeviceFilter,
  DeviceDataTable,
} from "@/components/device-data-table"
import type { DeviceFilterForm } from "@/components/device-data-table"
import { PageHeader } from "@/components/page-header"

export const Route = createFileRoute("/_dashboard/devices/")({
  component: DevicesPage,
})

const empty: DeviceFilterForm = {
  platform: anyDeviceFilter,
  runtimeVersion: "",
  channel: anyDeviceFilter,
  currentUpdateId: "",
  country: "",
  seenWithinMinutes: anyDeviceFilter,
}

function toFilters(form: DeviceFilterForm): DeviceFilters {
  return {
    ...(form.platform === anyDeviceFilter
      ? {}
      : { platform: form.platform as DeviceFilters["platform"] }),
    ...(form.channel === anyDeviceFilter ? {} : { channel: form.channel }),
    ...(form.seenWithinMinutes === anyDeviceFilter
      ? {}
      : { seenWithinMinutes: Number(form.seenWithinMinutes) }),
    runtimeVersion: form.runtimeVersion,
    currentUpdateId: form.currentUpdateId,
    country: form.country,
  }
}

function DevicesPage() {
  const hydrated = useHydrated()
  const navigate = useNavigate()
  const [form, setForm] = useState(empty)
  const [applied, setApplied] = useState<DeviceFilters>({})
  const [clientId, setClientId] = useState("")

  const overview = useQuery({ ...overviewQueryOptions, enabled: hydrated })
  const devices = useInfiniteQuery({
    ...devicesQueryOptions(applied),
    enabled: hydrated,
  })

  if (isUnreachable(overview.error)) return null

  const rows = devices.data?.pages.flatMap((page) => page.devices) ?? []
  const submit = (searchClientId = clientId) => {
    const id = searchClientId.trim()
    if (id !== "") {
      void navigate({
        to: "/devices/$clientId",
        params: { clientId: id },
      })
      return
    }
    setApplied(toFilters(form))
  }
  const clear = () => {
    setForm(empty)
    setClientId("")
    setApplied({})
  }

  return (
    <>
      <PageHeader
        title="Devices"
        subtitle="Which devices checked in, and what did the server last answer them?"
      />

      {devices.isError && (
        <ErrorState
          thing="devices"
          error={devices.error}
          onRetry={() => void devices.refetch()}
        />
      )}

      <DeviceDataTable
        entries={rows}
        isPending={devices.isPending}
        hasNextPage={devices.hasNextPage}
        isFetchingNextPage={devices.isFetchingNextPage}
        onLoadMore={() => void devices.fetchNextPage()}
        clientId={clientId}
        filters={form}
        channels={(overview.data?.channels ?? []).map(
          (channel) => channel.name
        )}
        onClientIdChange={setClientId}
        onFilterChange={(field, value) =>
          setForm((current) => ({ ...current, [field]: value }))
        }
        onApplyFilters={(nextFilters) => setApplied(toFilters(nextFilters))}
        onSubmit={submit}
        onClear={clear}
      />
    </>
  )
}
