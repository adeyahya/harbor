import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Boxes, HardDrive, Network as NetworkIcon, Search, Trash2 } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { Outlet, useNavigate } from 'react-router'
import { toast } from 'sonner'
import { api, type ImageSummary, type Network, type Volume } from '@/api'
import { Confirm } from '@/components/app/confirm'
import { EmptyState, ErrorAlert, Loading, Page, PageHeader, Surface } from '@/components/app/page'
import { Status } from '@/components/app/status'
import { useRunAction } from '@/components/app/updates'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { bytes, shortId, timeAgo } from '@/lib/format'

interface Column<T> {
  head: string
  cell: (item: T) => ReactNode
  className?: string
}

function ResourcePage<T>(props: {
  title: string
  icon: ReactNode
  description?: (items: T[]) => ReactNode
  queryKey: string
  path: string
  prune: { kind: string; title: string; description: string }
  idOf: (item: T) => string
  labelOf: (item: T) => string
  removable?: (item: T) => boolean
  search: (item: T) => string
  columns: Column<T>[]
  /** Opens a detail panel (rendered through the route's Outlet). */
  linkOf?: (item: T) => string
  empty: string
}) {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const run = useRunAction()
  const { data, isLoading, error } = useQuery({ queryKey: [props.queryKey], queryFn: () => api.get<T[]>(props.path), refetchInterval: 10000 })
  const remove = useMutation({
    mutationFn: (id: string) => api.del(`${props.path}/${encodeURIComponent(id)}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [props.queryKey] })
      toast.success('Removed')
    },
    onError: (e) => toast.error(e.message),
  })
  const [search, setSearch] = useState('')
  const [pending, setPending] = useState<T | null>(null)
  const items = (data ?? []).filter((i) => props.search(i).toLowerCase().includes(search.toLowerCase()))

  return (
    <Page>
      <PageHeader
        title={props.title}
        description={data && props.description?.(data)}
        actions={
          <Confirm title={props.prune.title} description={props.prune.description} confirmLabel="Prune" onConfirm={() => run.mutate({ path: `/docker/prune/${props.prune.kind}` })}>
            <Button variant="outline" size="sm">
              Prune unused
            </Button>
          </Confirm>
        }
      />
      <ErrorAlert error={error} className="mb-4" />
      <div className="relative mb-3 w-full sm:w-72">
        <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input placeholder={`Search ${props.title.toLowerCase()}`} value={search} onChange={(e) => setSearch(e.target.value)} className="pl-8" />
      </div>
      <Surface>
        {isLoading ? (
          <Loading />
        ) : items.length ? (
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                {props.columns.map((c, i) => (
                  <TableHead key={c.head} className={i === 0 ? `pl-4 ${c.className ?? ''}` : c.className}>
                    {c.head}
                  </TableHead>
                ))}
                <TableHead className="w-12" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((item) => (
                <TableRow
                  key={props.idOf(item)}
                  className={props.linkOf ? 'cursor-pointer' : undefined}
                  onClick={props.linkOf ? () => navigate(props.linkOf!(item)) : undefined}
                >
                  {props.columns.map((c, i) => (
                    <TableCell key={c.head} className={i === 0 ? `pl-4 ${c.className ?? ''}` : c.className}>
                      {c.cell(item)}
                    </TableCell>
                  ))}
                  {/* Dialogs portal out but their events still bubble here; keep them off the row. */}
                  <TableCell className="pr-3 text-right" onClick={(e) => e.stopPropagation()}>
                    {(props.removable?.(item) ?? true) && (
                      <Button variant="ghost" size="icon-sm" className="text-muted-foreground hover:text-destructive" onClick={() => setPending(item)} aria-label="Remove">
                        <Trash2 />
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <EmptyState icon={props.icon} title={data?.length ? 'No matches' : props.empty} />
        )}
      </Surface>
      <Outlet />
      <Confirm
        open={pending !== null}
        onOpenChange={(o) => !o && setPending(null)}
        title={`Remove ${pending ? props.labelOf(pending) : ''}?`}
        description="This can't be undone."
        confirmLabel="Remove"
        onConfirm={() => pending && remove.mutate(props.idOf(pending))}
      />
    </Page>
  )
}

const mono = 'font-mono text-[12px]'

export function ImagesPage() {
  return (
    <ResourcePage<ImageSummary>
      title="Images"
      icon={<Boxes />}
      description={(items) => `${items.length} images · ${bytes(items.reduce((s, i) => s + i.Size, 0))} on disk`}
      queryKey="images"
      path="/docker/images"
      prune={{ kind: 'images', title: 'Prune unused images?', description: 'Every image not used by a container is deleted, including tagged ones.' }}
      idOf={(i) => i.Id}
      labelOf={(i) => i.RepoTags?.[0] ?? shortId(i.Id)}
      search={(i) => (i.RepoTags ?? []).join(' ') + i.Id}
      empty="No images"
      columns={[
        {
          head: 'Repository',
          cell: (i) => (
            <div className={`flex flex-col gap-0.5 ${mono}`}>
              {i.RepoTags?.length ? i.RepoTags.map((t) => <span key={t}>{t}</span>) : <span className="text-muted-foreground">&lt;none&gt;</span>}
            </div>
          ),
        },
        { head: 'ID', cell: (i) => <span className={`${mono} text-muted-foreground`}>{shortId(i.Id)}</span>, className: 'hidden md:table-cell' },
        { head: 'Usage', cell: (i) => <Status status={i.InUse ? 'in_use' : 'unused'} /> },
        { head: 'Size', cell: (i) => <span className="tabular-nums">{bytes(i.Size)}</span> },
        { head: 'Created', cell: (i) => <span className="text-muted-foreground">{timeAgo(i.Created)}</span>, className: 'hidden sm:table-cell' },
      ]}
    />
  )
}

export function VolumesPage() {
  return (
    <ResourcePage<Volume>
      title="Volumes"
      icon={<HardDrive />}
      description={(items) => `${items.length} volumes · click one to browse its files`}
      queryKey="volumes"
      path="/docker/volumes"
      prune={{ kind: 'volumes', title: 'Prune unused volumes?', description: 'Every volume not attached to a container is deleted along with its data.' }}
      idOf={(v) => v.Name}
      labelOf={(v) => v.Name}
      linkOf={(v) => `/volumes/${encodeURIComponent(v.Name)}`}
      search={(v) => v.Name}
      empty="No volumes"
      columns={[
        { head: 'Name', cell: (v) => <span className={`${mono} block max-w-md truncate`} title={v.Mountpoint}>{v.Name}</span> },
        { head: 'Driver', cell: (v) => v.Driver, className: 'hidden sm:table-cell' },
        { head: 'Stack', cell: (v) => v.Labels?.['com.docker.compose.project'] ?? <span className="text-muted-foreground/60">—</span> },
        { head: 'Created', cell: (v) => <span className="text-muted-foreground">{v.CreatedAt ? timeAgo(v.CreatedAt) : '—'}</span>, className: 'hidden sm:table-cell' },
      ]}
    />
  )
}

const BUILTIN_NETWORKS = ['bridge', 'host', 'none']

export function NetworksPage() {
  return (
    <ResourcePage<Network>
      title="Networks"
      icon={<NetworkIcon />}
      description={(items) => `${items.length} networks`}
      queryKey="networks"
      path="/docker/networks"
      prune={{ kind: 'networks', title: 'Prune unused networks?', description: 'Every network without connected containers is removed.' }}
      idOf={(n) => n.Id}
      labelOf={(n) => n.Name}
      removable={(n) => !BUILTIN_NETWORKS.includes(n.Name)}
      search={(n) => n.Name}
      empty="No networks"
      columns={[
        {
          head: 'Name',
          cell: (n) => (
            <span className="font-medium">
              {n.Name}
              {n.Internal && <span className="ml-2 text-xs font-normal text-muted-foreground">internal</span>}
            </span>
          ),
        },
        { head: 'Driver', cell: (n) => n.Driver },
        { head: 'Subnet', cell: (n) => <span className={mono}>{n.IPAM?.Config?.map((c) => c.Subnet).filter(Boolean).join(', ') || '—'}</span>, className: 'hidden sm:table-cell' },
        { head: 'Created', cell: (n) => <span className="text-muted-foreground">{timeAgo(n.Created)}</span>, className: 'hidden md:table-cell' },
      ]}
    />
  )
}
