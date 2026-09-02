import type { CountryDevices } from "@/lib/api"
import { flagEmoji } from "@/lib/format"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Progress } from "@/components/ui/progress"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"

/** Where the devices are, from Cloudflare's request geolocation. */
export function CountriesCard({
  countries,
}: {
  readonly countries: ReadonlyArray<CountryDevices>
}) {
  if (countries.length === 0) return null
  const total = countries.reduce((sum, entry) => sum + entry.devices, 0)

  return (
    <Card>
      <CardHeader className="border-b">
        <CardTitle>Devices by country</CardTitle>
        <CardDescription>
          Where devices were when they last checked in.
        </CardDescription>
      </CardHeader>
      <CardContent className="p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="pl-(--card-spacing)">Country</TableHead>
              <TableHead className="w-28 text-right">Devices</TableHead>
              <TableHead className="w-48 pr-(--card-spacing)">Share</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody className="[&_tr:last-child]:border-0">
            {countries.map((entry) => (
              <TableRow key={entry.country}>
                <TableCell className="pl-(--card-spacing)">
                  <span className="flex items-center gap-2">
                    <span aria-hidden="true">{flagEmoji(entry.country)}</span>
                    <span className="font-mono text-xs">{entry.country}</span>
                  </span>
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {entry.devices.toLocaleString()}
                </TableCell>
                <TableCell className="pr-(--card-spacing)">
                  <div className="flex items-center gap-2">
                    <Progress
                      value={total === 0 ? 0 : (entry.devices / total) * 100}
                      className="flex-1"
                    />
                    <span className="w-9 text-right text-xs text-muted-foreground tabular-nums">
                      {total === 0
                        ? 0
                        : Math.round((entry.devices / total) * 100)}
                      %
                    </span>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  )
}
