import { useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"

import { api } from "@/lib/api"
import { DialogError } from "@/components/feedback"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Spinner } from "@/components/ui/spinner"
import { toast } from "@/components/ui/toast"

// Same rule the server applies to channel and branch names.
const namePattern = /^[a-z0-9][a-z0-9._-]{0,63}$/

/**
 * A channel is the name a build carries in its `expo-channel-name` header.
 * Linking that name to a branch is what creates it, the same as EAS.
 */
export function AddChannelDialog({
  channels,
  branches,
}: {
  readonly channels: ReadonlyArray<string>
  readonly branches: ReadonlyArray<string>
}) {
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const [name, setName] = useState("")
  const [branch, setBranch] = useState<string | null>(null)

  const create = useMutation({
    mutationFn: (input: { name: string; branch: string }) =>
      api.setChannel(input.name, input.branch),
    onSuccess: (_result, input) => {
      setOpen(false)
      toast.add({
        title: `Added ${input.name}, linked to ${input.branch}`,
        type: "success",
      })
      return queryClient.invalidateQueries()
    },
  })

  const trimmed = name.trim()
  const taken = channels.includes(trimmed)
  const malformed = trimmed !== "" && !namePattern.test(trimmed)
  const ready = trimmed !== "" && !taken && !malformed && branch !== null

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (next) {
          setName("")
          setBranch(branches[0] ?? null)
          create.reset()
        }
      }}
    >
      <DialogTrigger render={<Button variant="outline" size="sm" />}>
        Add channel
      </DialogTrigger>
      <DialogContent>
        <form
          className="contents"
          onSubmit={(event) => {
            event.preventDefault()
            if (ready) {
              create.mutate({ name: trimmed, branch })
            }
          }}
        >
          <DialogHeader>
            <DialogTitle>Add channel</DialogTitle>
            <DialogDescription className="text-pretty">
              Builds that check in with this channel name start receiving
              updates from the linked branch.
            </DialogDescription>
          </DialogHeader>
          <Field>
            <FieldLabel htmlFor="add-channel-name">Channel</FieldLabel>
            <Input
              id="add-channel-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="beta"
              autoComplete="off"
              autoFocus
              aria-invalid={taken || malformed}
            />
            <FieldDescription>
              {taken
                ? `${trimmed} already exists. Change its linked branch from its card instead.`
                : malformed
                  ? "Lowercase letters, digits, dots, dashes and underscores, up to 64 characters."
                  : "The expo-channel-name the build was made with."}
            </FieldDescription>
          </Field>
          <Field>
            <FieldLabel>Branch</FieldLabel>
            <Select value={branch} onValueChange={setBranch}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Pick a branch" />
              </SelectTrigger>
              <SelectContent>
                {branches.map((candidate) => (
                  <SelectItem key={candidate} value={candidate}>
                    {candidate}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <DialogError error={create.error} />
          <DialogFooter>
            <DialogClose render={<Button variant="outline" type="button" />}>
              Cancel
            </DialogClose>
            <Button type="submit" disabled={!ready || create.isPending}>
              {create.isPending && <Spinner />}
              Add channel
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
