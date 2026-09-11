import { useMemo, useRef, useState } from "react"
import {
  ArrowDown01Icon,
  ArrowUp01Icon,
  ArrowUpDownIcon,
  AddCircleIcon,
  Cancel01Icon,
  FilterIcon,
  Search01Icon,
  Settings02Icon,
  SmartphoneIcon,
  ViewOffIcon,
} from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
} from "@tanstack/react-table"
import type {
  Column,
  ColumnDef,
  SortingState,
  Table,
  VisibilityState,
} from "@tanstack/react-table"
import { Link } from "@tanstack/react-router"

import type { Device } from "@/lib/api"
import { flagEmoji, relativeTime, shortId } from "@/lib/format"
import { cn } from "@/lib/utils"
import { CopyId, EmptyValue, PlatformChip } from "@/components/metrics"
import { TableSkeleton } from "@/components/page-state"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { Input } from "@/components/ui/input"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group"
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import {
  Table as UiTable,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"

declare module "@tanstack/react-table" {
  interface ColumnMeta<TData, TValue> {
    readonly label?: string
  }
}

export const anyDeviceFilter = "any"

export interface DeviceFilterForm {
  readonly platform: string
  readonly runtimeVersion: string
  readonly channel: string
  readonly currentUpdateId: string
  readonly country: string
  readonly seenWithinMinutes: string
}

interface DeviceDataTableProps {
  readonly entries: ReadonlyArray<Device>
  readonly isPending: boolean
  readonly hasNextPage: boolean
  readonly isFetchingNextPage: boolean
  readonly onLoadMore: () => void
  readonly clientId: string
  readonly filters: DeviceFilterForm
  readonly channels: ReadonlyArray<string>
  readonly onClientIdChange: (value: string) => void
  readonly onFilterChange: (
    field: keyof DeviceFilterForm,
    value: string
  ) => void
  readonly onApplyFilters: (filters: DeviceFilterForm) => void
  readonly onSubmit: (clientId?: string) => void
  readonly onClear: () => void
}

const recency: ReadonlyArray<readonly [string, string]> = [
  [anyDeviceFilter, "Any time"],
  ["20", "Last 20 minutes"],
  ["60", "Last hour"],
  ["1440", "Last 24 hours"],
]

export function DeviceDataTable({
  entries,
  isPending,
  hasNextPage,
  isFetchingNextPage,
  onLoadMore,
  clientId,
  filters,
  channels,
  onClientIdChange,
  onFilterChange,
  onApplyFilters,
  onSubmit,
  onClear,
}: DeviceDataTableProps) {
  const [sorting, setSorting] = useState<SortingState>([
    { id: "lastSeenAt", desc: true },
  ])
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>({
    currentUpdateId: true,
    country: true,
  })
  const [filtersExpanded, setFiltersExpanded] = useState(false)
  const clientIdTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const textFilterTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const currentFilters = useRef(filters)
  currentFilters.current = filters
  const data = useMemo(() => [...entries], [entries])
  const columns = useMemo<ColumnDef<Device>[]>(
    () => [
      {
        accessorKey: "clientId",
        ...labeled("Device"),
        enableHiding: false,
        cell: ({ row }) => (
          <Link
            to="/devices/$clientId"
            params={{ clientId: row.original.clientId }}
            className="flex items-center gap-3 rounded-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            <span
              aria-hidden="true"
              className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground"
            >
              <HugeiconsIcon
                icon={SmartphoneIcon}
                strokeWidth={2}
                className="size-4"
              />
            </span>
            <span className="font-mono text-xs underline-offset-4 hover:underline">
              {shortId(row.original.clientId)}
            </span>
          </Link>
        ),
      },
      {
        accessorKey: "platform",
        ...labeled("Build"),
        cell: ({ row }) => (
          <PlatformChip
            platform={row.original.platform}
            runtimeVersion={row.original.runtimeVersion}
          />
        ),
      },
      {
        accessorKey: "channel",
        ...labeled("Channel"),
      },
      {
        accessorKey: "currentUpdateId",
        ...labeled("Running"),
        cell: ({ row }) =>
          row.original.currentUpdateId === null ? (
            <EmptyValue reason="No update reported yet" />
          ) : (
            <CopyId value={row.original.currentUpdateId} kind="Update" />
          ),
      },
      {
        accessorKey: "country",
        ...labeled("Where"),
        cell: ({ row }) =>
          row.original.country === null ? (
            <EmptyValue reason="No country reported" />
          ) : (
            <span className="flex items-center gap-2">
              <span aria-hidden="true">{flagEmoji(row.original.country)}</span>
              <span className="font-mono text-xs">{row.original.country}</span>
            </span>
          ),
      },
      {
        accessorKey: "lastSeenAt",
        ...labeled("Last seen", "ml-auto"),
        cell: ({ row }) => (
          <span className="text-muted-foreground">
            {relativeTime(row.original.lastSeenAt)}
          </span>
        ),
      },
    ],
    []
  )
  const table = useReactTable({
    data,
    columns,
    state: { sorting, columnVisibility },
    onSortingChange: setSorting,
    onColumnVisibilityChange: setColumnVisibility,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getRowId: (row) => row.clientId,
  })
  const activeFilterCount = Object.values(filters).filter(
    (value) => value !== "" && value !== anyDeviceFilter
  ).length
  const hasQuery = clientId.trim() !== "" || activeFilterCount > 0
  const applyFilter = (field: keyof DeviceFilterForm, value: string) => {
    onFilterChange(field, value)
    onApplyFilters({ ...currentFilters.current, [field]: value })
  }
  const debounceTextFilter = (field: keyof DeviceFilterForm, value: string) => {
    onFilterChange(field, value)
    if (textFilterTimer.current !== null) {
      clearTimeout(textFilterTimer.current)
    }
    textFilterTimer.current = setTimeout(() => {
      onApplyFilters({ ...currentFilters.current, [field]: value })
    }, 350)
  }
  const debounceClientIdSearch = (value: string) => {
    onClientIdChange(value)
    if (clientIdTimer.current !== null) {
      clearTimeout(clientIdTimer.current)
    }
    clientIdTimer.current = setTimeout(() => {
      const trimmed = value.trim()
      if (trimmed === "" || trimmed.length >= 8) onSubmit(trimmed)
    }, 450)
  }

  return (
    <div className="flex flex-col gap-1.5 rounded-2xl bg-muted/60 p-1.5 shadow-recessed dark:bg-muted/25">
      <form
        onSubmit={(event) => {
          event.preventDefault()
          onSubmit()
        }}
      >
        <div className="flex flex-col gap-2 px-2 py-1.5 lg:flex-row lg:items-center">
          <InputGroup className="w-full lg:max-w-sm">
            <InputGroupInput
              id="device-client-id"
              aria-label="Client id"
              placeholder="Search by client id..."
              value={clientId}
              onChange={(event) => debounceClientIdSearch(event.target.value)}
              autoComplete="off"
            />
            <InputGroupAddon>
              <HugeiconsIcon icon={Search01Icon} strokeWidth={2} />
            </InputGroupAddon>
          </InputGroup>
          <div className="flex flex-wrap items-center gap-2 lg:ml-auto">
            <Button
              type="button"
              variant="outline"
              className="font-normal"
              aria-expanded={filtersExpanded}
              aria-controls="device-filters"
              onClick={() => setFiltersExpanded((expanded) => !expanded)}
            >
              <HugeiconsIcon icon={FilterIcon} strokeWidth={2} />
              Filters
              {activeFilterCount > 0 ? (
                <Badge
                  variant="secondary"
                  className="rounded-md px-1.5 font-normal tabular-nums"
                >
                  {activeFilterCount}
                </Badge>
              ) : null}
              <HugeiconsIcon
                icon={ArrowDown01Icon}
                strokeWidth={2}
                className={cn(
                  "text-muted-foreground transition-transform duration-[200ms] motion-reduce:transition-none",
                  filtersExpanded && "rotate-180"
                )}
              />
            </Button>
            <DeviceViewOptions table={table} />
            {hasQuery ? (
              <Button
                type="button"
                variant="ghost"
                className="font-normal"
                onClick={onClear}
              >
                Reset filters
              </Button>
            ) : null}
          </div>
        </div>
        <div
          id="device-filters"
          data-expanded={filtersExpanded ? "" : undefined}
          className="grid grid-rows-[0fr] transition-[grid-template-rows] duration-[250ms] ease-[var(--ease-out-ui)] data-expanded:grid-rows-[1fr] motion-reduce:transition-none"
        >
          <div className="overflow-hidden">
            <div className="flex flex-wrap items-center gap-2 border-t px-2 pt-3 pb-2">
              <ServerFacetedFilter
                label="Platform"
                value={filters.platform}
                onChange={(value) => applyFilter("platform", value)}
                options={[
                  [anyDeviceFilter, "Any platform"],
                  ["ios", "iOS"],
                  ["android", "Android"],
                ]}
              />
              <ServerFacetedFilter
                label="Channel"
                value={filters.channel}
                onChange={(value) => applyFilter("channel", value)}
                options={[
                  [anyDeviceFilter, "Any channel"],
                  ...channels.map((channel) => [channel, channel] as const),
                ]}
              />
              <ServerFacetedFilter
                label="Last seen"
                value={filters.seenWithinMinutes}
                onChange={(value) => applyFilter("seenWithinMinutes", value)}
                options={recency}
              />
              <ServerTextFilter
                label="Runtime version"
                value={filters.runtimeVersion}
                placeholder="Any runtime"
                onChange={(value) =>
                  debounceTextFilter("runtimeVersion", value)
                }
              />
              <ServerTextFilter
                label="Running update id"
                value={filters.currentUpdateId}
                placeholder="Any update"
                onChange={(value) =>
                  debounceTextFilter("currentUpdateId", value)
                }
              />
              <ServerTextFilter
                label="Country"
                value={filters.country}
                placeholder="Any country"
                onChange={(value) => debounceTextFilter("country", value)}
              />
            </div>
          </div>
        </div>
      </form>

      <div className="overflow-hidden rounded-xl bg-card shadow-raised">
        {isPending ? (
          <TableSkeleton
            widths={["w-32", "w-20", "w-24", "w-24", "w-20"]}
            rowClassName="h-14"
          />
        ) : entries.length === 0 ? (
          <Empty className="min-h-80 bg-transparent shadow-none">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <HugeiconsIcon icon={SmartphoneIcon} strokeWidth={2} />
              </EmptyMedia>
              <EmptyTitle>
                {hasQuery ? "No matching devices" : "No devices yet"}
              </EmptyTitle>
              <EmptyDescription>
                {hasQuery
                  ? "Try changing or clearing one of the filters above."
                  : "A device appears here after its first check-in."}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <>
            <UiTable className="min-w-176">
              <TableHeader>
                {table.getHeaderGroups().map((headerGroup) => (
                  <TableRow
                    key={headerGroup.id}
                    className="hover:bg-transparent"
                  >
                    {headerGroup.headers.map((header) => (
                      <TableHead
                        key={header.id}
                        className={cn(
                          "px-3 text-xs text-muted-foreground",
                          header.column.id === "clientId" && "min-w-48",
                          header.column.id === "lastSeenAt" && "pr-4 text-right"
                        )}
                      >
                        {header.isPlaceholder
                          ? null
                          : flexRender(
                              header.column.columnDef.header,
                              header.getContext()
                            )}
                      </TableHead>
                    ))}
                  </TableRow>
                ))}
              </TableHeader>
              <TableBody>
                {table.getRowModel().rows.map((row) => (
                  <TableRow key={row.id} className="h-14">
                    {row.getVisibleCells().map((cell) => (
                      <TableCell
                        key={cell.id}
                        className={cn(
                          "px-3",
                          cell.column.id === "lastSeenAt" && "pr-4 text-right"
                        )}
                      >
                        {flexRender(
                          cell.column.columnDef.cell,
                          cell.getContext()
                        )}
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
              </TableBody>
            </UiTable>
            <DeviceTableFooter
              count={entries.length}
              hasNextPage={hasNextPage}
              isFetchingNextPage={isFetchingNextPage}
              onLoadMore={onLoadMore}
            />
          </>
        )}
      </div>
    </div>
  )
}

function ServerFacetedFilter({
  label,
  value,
  options,
  onChange,
}: {
  readonly label: string
  readonly value: string
  readonly options: ReadonlyArray<readonly [string, string]>
  readonly onChange: (value: string) => void
}) {
  const selected = value !== anyDeviceFilter && value !== ""
  const selectedLabel = options.find(
    ([optionValue]) => optionValue === value
  )?.[1]

  return (
    <Popover>
      <PopoverTrigger
        render={<Button variant="outline" className="font-normal" />}
      >
        <HugeiconsIcon
          icon={selected ? FilterIcon : AddCircleIcon}
          strokeWidth={2}
        />
        {selected ? selectedLabel : label}
        {selected ? (
          <Badge variant="secondary" className="rounded-md px-1.5 font-normal">
            1
          </Badge>
        ) : null}
      </PopoverTrigger>
      <PopoverContent align="start" className="w-56 p-0">
        <Command>
          <CommandInput placeholder={`Search ${label.toLowerCase()}...`} />
          <CommandList>
            <CommandEmpty>No options found.</CommandEmpty>
            <CommandGroup>
              {options
                .filter(([optionValue]) => optionValue !== anyDeviceFilter)
                .map(([optionValue, optionLabel]) => (
                  <CommandItem
                    key={optionValue}
                    data-checked={value === optionValue}
                    onSelect={() => onChange(optionValue)}
                  >
                    <span className="truncate">{optionLabel}</span>
                  </CommandItem>
                ))}
            </CommandGroup>
            {selected ? (
              <>
                <CommandSeparator />
                <CommandGroup>
                  <CommandItem
                    className="justify-center"
                    onSelect={() => onChange(anyDeviceFilter)}
                  >
                    Clear filter
                  </CommandItem>
                </CommandGroup>
              </>
            ) : null}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

function ServerTextFilter({
  label,
  value,
  placeholder,
  onChange,
}: {
  readonly label: string
  readonly value: string
  readonly placeholder: string
  readonly onChange: (value: string) => void
}) {
  const selected = value.trim() !== ""
  return (
    <Popover>
      <PopoverTrigger
        render={<Button variant="outline" className="font-normal" />}
      >
        <HugeiconsIcon
          icon={selected ? FilterIcon : AddCircleIcon}
          strokeWidth={2}
        />
        {label}
        {selected ? (
          <Badge
            variant="secondary"
            className="max-w-32 truncate rounded-md px-1.5 font-normal"
          >
            1
          </Badge>
        ) : null}
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64">
        <div className="grid gap-2">
          <p className="text-sm font-medium">{label}</p>
          <Input
            aria-label={label}
            value={value}
            placeholder={placeholder}
            autoComplete="off"
            onChange={(event) => onChange(event.target.value)}
          />
          {selected ? (
            <Button
              variant="ghost"
              className="w-full"
              onClick={() => onChange("")}
            >
              Clear filter
            </Button>
          ) : null}
        </div>
      </PopoverContent>
    </Popover>
  )
}

function labeled<TData>(
  label: string,
  className?: string
): Pick<ColumnDef<TData>, "header" | "meta"> {
  return {
    header: ({ column }) => (
      <DataTableColumnHeader
        column={column}
        label={label}
        className={className}
      />
    ),
    meta: { label },
  }
}

function DataTableColumnHeader<TData, TValue>({
  column,
  label,
  className,
}: {
  readonly column: Column<TData, TValue>
  readonly label: string
  readonly className?: string
}) {
  const sorted = column.getIsSorted()
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className={cn(
          "-ml-1.5 flex h-8 items-center gap-1.5 rounded-md px-1.5 text-sm font-medium text-foreground outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 data-popup-open:bg-muted",
          className
        )}
      >
        {label}
        <HugeiconsIcon
          icon={sorted === false ? ArrowUpDownIcon : ArrowDown01Icon}
          strokeWidth={2}
          className={cn(
            "size-3.5 text-muted-foreground transition-transform duration-[200ms] motion-reduce:transition-none",
            sorted === "asc" && "rotate-180"
          )}
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-36">
        <DropdownMenuCheckboxItem
          checked={sorted === "asc"}
          onClick={() => column.toggleSorting(false)}
        >
          <HugeiconsIcon icon={ArrowUp01Icon} strokeWidth={2} />
          Ascending
        </DropdownMenuCheckboxItem>
        <DropdownMenuCheckboxItem
          checked={sorted === "desc"}
          onClick={() => column.toggleSorting(true)}
        >
          <HugeiconsIcon icon={ArrowDown01Icon} strokeWidth={2} />
          Descending
        </DropdownMenuCheckboxItem>
        {sorted === false ? null : (
          <DropdownMenuItem onClick={() => column.clearSorting()}>
            <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} />
            Reset sort
          </DropdownMenuItem>
        )}
        {column.getCanHide() ? (
          <DropdownMenuItem onClick={() => column.toggleVisibility(false)}>
            <HugeiconsIcon icon={ViewOffIcon} strokeWidth={2} />
            Hide
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function DeviceViewOptions<TData>({ table }: { readonly table: Table<TData> }) {
  const columns = table
    .getAllColumns()
    .filter(
      (column) =>
        typeof column.accessorFn !== "undefined" && column.getCanHide()
    )

  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-input bg-background px-2.5 text-sm font-normal shadow-hairline outline-none hover:text-foreground hover:shadow-control focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 [&_svg]:size-4 [&_svg]:shrink-0">
        <HugeiconsIcon
          icon={Settings02Icon}
          strokeWidth={2}
          className="size-4 shrink-0"
        />
        View
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-44">
        <DropdownMenuLabel>Columns</DropdownMenuLabel>
        {columns.map((column) => (
          <DropdownMenuCheckboxItem
            key={column.id}
            checked={column.getIsVisible()}
            onClick={() => column.toggleVisibility(!column.getIsVisible())}
          >
            <span className="truncate">
              {column.columnDef.meta?.label ?? column.id}
            </span>
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function DeviceTableFooter({
  count,
  hasNextPage,
  isFetchingNextPage,
  onLoadMore,
}: {
  readonly count: number
  readonly hasNextPage: boolean
  readonly isFetchingNextPage: boolean
  readonly onLoadMore: () => void
}) {
  return (
    <div className="flex flex-col gap-3 border-t px-3 py-3 sm:flex-row sm:items-center sm:justify-between">
      <p className="text-sm text-muted-foreground">
        <span className="font-medium text-foreground tabular-nums">
          {count}
        </span>{" "}
        devices{hasNextPage ? " loaded so far" : ""}
      </p>
      {hasNextPage ? (
        <Button
          variant="outline"
          size="sm"
          disabled={isFetchingNextPage}
          onClick={onLoadMore}
        >
          {isFetchingNextPage ? "Loading" : "Load more"}
        </Button>
      ) : null}
    </div>
  )
}
