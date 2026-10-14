import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowDown, ArrowUp, ChevronRight, FolderInput, FolderMinus, FolderPlus, MoreHorizontal, Pencil, Pin, PinOff, Trash2 } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { Link } from 'react-router'
import { toast } from 'sonner'
import { api, type CanvasGroup } from '@/api'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { Confirm } from './confirm'
import { Status, StatusDot } from './status'

export type ItemKind = 'stack' | 'deployment'

/** A service on the canvas, independent of whether it's a stack or deployment. */
export interface CanvasItem {
  kind: ItemKind
  name: string
  status: string
  pinned: boolean
  groupId: number | null
  to: string
}

export function useCanvasGroups() {
  return useQuery({ queryKey: ['canvas-groups'], queryFn: () => api.get<CanvasGroup[]>('/canvas/groups') })
}

/** Canvas mutations; everything refetches the lists afterwards. */
export function useCanvasActions() {
  const qc = useQueryClient()
  const refresh = () => Promise.all(['stacks', 'deployments', 'canvas-groups'].map((k) => qc.invalidateQueries({ queryKey: [k] })))
  const onError = (e: Error) => toast.error(e.message)
  const setItem = useMutation({
    mutationFn: ({ item, patch }: { item: CanvasItem; patch: { pinned?: boolean; group_id?: number | null } }) =>
      api.put(`/canvas/items/${item.kind}/${encodeURIComponent(item.name)}`, patch),
    onSuccess: refresh,
    onError,
  })
  const createGroup = useMutation({ mutationFn: (name: string) => api.post<CanvasGroup>('/canvas/groups', { name }), onSuccess: refresh, onError })
  const updateGroup = useMutation({
    mutationFn: ({ id, patch }: { id: number; patch: { name?: string; collapsed?: boolean } }) => api.put<CanvasGroup>(`/canvas/groups/${id}`, patch),
    onSuccess: refresh,
    onError,
  })
  const deleteGroup = useMutation({ mutationFn: (id: number) => api.del(`/canvas/groups/${id}`), onSuccess: refresh, onError })
  const reorder = useMutation({ mutationFn: (ids: number[]) => api.put<CanvasGroup[]>('/canvas/groups/order', { ids }), onSuccess: refresh, onError })
  return { setItem, createGroup, updateGroup, deleteGroup, reorder }
}

/** Small dialog asking for a group name. */
export function GroupNameDialog({
  open,
  onOpenChange,
  title,
  initial = '',
  submitLabel,
  onSubmit,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  title: string
  initial?: string
  submitLabel: string
  onSubmit: (name: string) => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-0 p-0 sm:max-w-sm">
        {open && <GroupNameForm title={title} initial={initial} submitLabel={submitLabel} onCancel={() => onOpenChange(false)} onSubmit={onSubmit} />}
      </DialogContent>
    </Dialog>
  )
}

function GroupNameForm({ title, initial, submitLabel, onCancel, onSubmit }: { title: string; initial: string; submitLabel: string; onCancel: () => void; onSubmit: (name: string) => void }) {
  const [name, setName] = useState(initial)
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        if (name.trim()) onSubmit(name.trim())
      }}
    >
      <DialogHeader className="border-b px-5 py-4">
        <DialogTitle>{title}</DialogTitle>
      </DialogHeader>
      <div className="px-5 py-4">
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Production, Side projects" autoFocus maxLength={60} required />
      </div>
      <div className="flex justify-end gap-2 border-t bg-muted/30 px-5 py-3">
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit">{submitLabel}</Button>
      </div>
    </form>
  )
}

/** The ⋯ menu on a service card: pin and move between groups. */
export function CardMenu({ item, groups }: { item: CanvasItem; groups: CanvasGroup[] }) {
  const { setItem, createGroup } = useCanvasActions()
  const [creating, setCreating] = useState(false)
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-sm" className="text-muted-foreground opacity-70 hover:opacity-100 data-[state=open]:opacity-100" aria-label={`Organize ${item.name}`}>
            <MoreHorizontal />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-52">
          <DropdownMenuItem onSelect={() => setItem.mutate({ item, patch: { pinned: !item.pinned } })}>
            {item.pinned ? <PinOff /> : <Pin />} {item.pinned ? 'Unpin' : 'Pin to top'}
          </DropdownMenuItem>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <FolderInput /> Move to group
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="w-48">
              {groups.map((g) => (
                <DropdownMenuItem key={g.id} disabled={g.id === item.groupId} onSelect={() => setItem.mutate({ item, patch: { group_id: g.id, pinned: false } })}>
                  {g.name}
                </DropdownMenuItem>
              ))}
              {groups.length > 0 && <DropdownMenuSeparator />}
              <DropdownMenuItem onSelect={() => setCreating(true)}>
                <FolderPlus /> New group…
              </DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          {item.groupId !== null && (
            <DropdownMenuItem onSelect={() => setItem.mutate({ item, patch: { group_id: null } })}>
              <FolderMinus /> Remove from group
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <GroupNameDialog
        open={creating}
        onOpenChange={setCreating}
        title={`New group for ${item.name}`}
        submitLabel="Create & move"
        onSubmit={(name) =>
          createGroup.mutate(name, {
            onSuccess: (g) => {
              setCreating(false)
              setItem.mutate({ item, patch: { group_id: g.id, pinned: false } })
            },
          })
        }
      />
    </>
  )
}

/**
 * A service card. It's a div with a full-size link underneath the content,
 * so interactive bits (menu, port links) can sit on top without navigating.
 */
export function ServiceCard({
  item,
  groups,
  icon,
  selected,
  children,
}: {
  item: CanvasItem
  groups: CanvasGroup[]
  icon: ReactNode
  selected: boolean
  children?: ReactNode
}) {
  return (
    <div
      data-service-card
      className={cn(
        'group relative flex w-full min-w-0 flex-col rounded-2xl border bg-card p-4 shadow-sm transition-all hover:-translate-y-0.5 hover:border-brand/40 hover:shadow-lg hover:shadow-black/20 sm:w-72',
        selected && 'border-brand/70 ring-3 ring-brand/20',
      )}
    >
      <Link to={item.to} className="absolute inset-0 rounded-2xl" aria-label={`Open ${item.name}`} />
      <div className="pointer-events-none relative flex items-center gap-3">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-lg border bg-muted/60 text-brand">{icon}</div>
        <div className="min-w-0 flex-1 truncate font-semibold">{item.name}</div>
        {item.pinned && <Pin className="size-3.5 shrink-0 text-brand" aria-label="Pinned" />}
        <div className="pointer-events-auto -mr-1.5">
          <CardMenu item={item} groups={groups} />
        </div>
      </div>
      <div className="pointer-events-none relative mt-3 min-h-10 space-y-2 text-sm [&_a]:pointer-events-auto">{children}</div>
      <div className="pointer-events-none relative mt-4 flex items-center border-t pt-3">
        <Status status={item.status} />
      </div>
    </div>
  )
}

function summary(items: CanvasItem[]) {
  const online = items.filter((i) => i.status === 'running').length
  const problems = items.filter((i) => ['unhealthy', 'dead', 'restarting', 'exited', 'stopped'].includes(i.status)).length
  return { online, problems }
}

/** A titled section of the canvas. */
export function Section({ title, icon, actions, children }: { title: ReactNode; icon?: ReactNode; actions?: ReactNode; children: ReactNode }) {
  return (
    <section>
      <div className="mb-3 flex min-h-8 items-center gap-2">
        {icon}
        <h2 className="text-xs font-semibold tracking-wider text-muted-foreground uppercase">{title}</h2>
        <div className="h-px flex-1 bg-border" />
        {actions}
      </div>
      {children}
    </section>
  )
}

/** A collapsible group of services with its own menu. */
export function GroupSection({
  group,
  index,
  groups,
  items,
  children,
}: {
  group: CanvasGroup
  index: number
  groups: CanvasGroup[]
  items: CanvasItem[]
  children: ReactNode
}) {
  const { updateGroup, deleteGroup, reorder } = useCanvasActions()
  const [renaming, setRenaming] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const { online, problems } = summary(items)
  const move = (delta: number) => {
    const ids = groups.map((g) => g.id)
    const [moved] = ids.splice(index, 1)
    ids.splice(index + delta, 0, moved)
    reorder.mutate(ids)
  }
  const toggle = () => updateGroup.mutate({ id: group.id, patch: { collapsed: !group.collapsed } })

  return (
    <section className={cn('rounded-2xl border border-dashed p-3 transition-colors sm:p-4', group.collapsed ? 'bg-card/40' : 'bg-card/20')}>
      <div className="flex min-h-8 items-center gap-2">
        <button onClick={toggle} className="flex min-w-0 flex-1 items-center gap-2 text-left" aria-expanded={!group.collapsed}>
          <ChevronRight className={cn('size-4 shrink-0 text-muted-foreground transition-transform', !group.collapsed && 'rotate-90')} />
          <span className="truncate font-semibold">{group.name}</span>
          <span className="shrink-0 text-xs text-muted-foreground">
            {items.length} service{items.length === 1 ? '' : 's'}
            {items.length > 0 && ` · ${online} online`}
          </span>
          {problems > 0 && <span className="shrink-0 text-xs text-warning">· {problems} need attention</span>}
        </button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" className="text-muted-foreground" aria-label={`Group ${group.name} options`}>
              <MoreHorizontal />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-44">
            <DropdownMenuItem onSelect={() => setRenaming(true)}>
              <Pencil /> Rename
            </DropdownMenuItem>
            <DropdownMenuItem disabled={index === 0} onSelect={() => move(-1)}>
              <ArrowUp /> Move up
            </DropdownMenuItem>
            <DropdownMenuItem disabled={index === groups.length - 1} onSelect={() => move(1)}>
              <ArrowDown /> Move down
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onSelect={() => setDeleting(true)}>
              <Trash2 /> Delete group
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {group.collapsed ? (
        items.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {items.map((i) => (
              <Link
                key={`${i.kind}-${i.name}`}
                to={i.to}
                data-service-card
                className="inline-flex items-center gap-1.5 rounded-lg border bg-card px-2 py-1 text-xs transition-colors hover:border-brand/40"
              >
                <StatusDot status={i.status} className="size-1.5" />
                {i.name}
              </Link>
            ))}
          </div>
        )
      ) : items.length ? (
        <div className="mt-4">{children}</div>
      ) : (
        <p className="mt-3 rounded-xl border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
          Empty group. Use a service's ⋯ menu → Move to group.
        </p>
      )}

      <GroupNameDialog
        open={renaming}
        onOpenChange={setRenaming}
        title="Rename group"
        initial={group.name}
        submitLabel="Rename"
        onSubmit={(name) => updateGroup.mutate({ id: group.id, patch: { name } }, { onSuccess: () => setRenaming(false) })}
      />
      <Confirm
        open={deleting}
        onOpenChange={setDeleting}
        title={`Delete ${group.name}?`}
        description="The services in it stay where they are on the server and move back to the ungrouped section."
        confirmLabel="Delete group"
        onConfirm={() => deleteGroup.mutate(group.id)}
      />
    </section>
  )
}
