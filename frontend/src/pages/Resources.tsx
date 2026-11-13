import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Boxes, Gauge, HardDrive, Network as NetworkIcon, Search, Trash2 } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { Outlet, useNavigate } from 'react-router'
import { api, type ImageSummary, type Network, type Volume, type VolumeUsageReport } from '@/api'
import { Confirm } from '@/components/app/confirm'
import { EmptyState, ErrorAlert, Loading, Page, PageHeader, Surface } from '@/components/app/page'
import { Status } from '@/components/app/status'
import { useRunAction } from '@/components/app/updates'
import { Button } from '@astryxdesign/core/Button'
import { IconButton } from '@astryxdesign/core/IconButton'
import { Table, TableBody, TableCell, TableHeader, TableHeaderCell, TableRow } from '@astryxdesign/core/Table'
import { TextInput } from '@astryxdesign/core/TextInput'
import { bytes, shortId, timeAgo } from '@/lib/format'
import { toast } from '@/lib/toast'
import { fitColumn } from '@/lib/utils'

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
  /** Extra header actions, shown before "Prune unused". */
  actions?: ReactNode
  sort?: (a: T, b: T) => number
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
  if (props.sort) items.sort(props.sort)

  return (
    <Page>
      <PageHeader
        title={props.title}
        description={data && props.description?.(data)}
        actions={
          <>
            {props.actions}
            <Confirm title={props.prune.title} description={props.prune.description} confirmLabel="Prune" onConfirm={() => run.mutate({ path: `/docker/prune/${props.prune.kind}` })}>
              <Button variant="secondary" size="sm" label="Prune unused" />
            </Confirm>
          </>
        }
      />
      <ErrorAlert error={error} className="mb-4" />
      <TextInput
        type="search"
        label={`Search ${props.title.toLowerCase()}`}
        isLabelHidden
        placeholder={`Search ${props.title.toLowerCase()}`}
        startIcon={Search}
        value={search}
        onChange={setSearch}
        containerClassName="mb-3 w-full sm:w-72"
      />
      <Surface>
        {isLoading ? (
          <Loading />
        ) : items.length ? (
          <Table hasHover={!!props.linkOf}>
            <TableHeader>
              <TableRow isHeaderRow>
                {props.columns.map((c, i) => (
                  <TableHeaderCell key={c.head} className={i === 0 ? `pl-4 ${c.className ?? ''}` : c.className}>
                    {c.head}
                  </TableHeaderCell>
                ))}
                <TableHeaderCell className="w-14 min-w-14" />
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
                      <IconButton variant="ghost" size="sm" className="text-muted-foreground hover:text-destructive" label="Remove" icon={<Trash2 />} onClick={() => setPending(item)} />
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
const fit = fitColumn

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
            <div className={`flex flex-col gap-0.5 break-words ${mono}`}>
              {i.RepoTags?.length ? i.RepoTags.map((t) => <span key={t}>{t}</span>) : <span className="text-muted-foreground">&lt;none&gt;</span>}
            </div>
          ),
        },
        { head: 'ID', cell: (i) => <span className={`${mono} text-muted-foreground`}>{shortId(i.Id)}</span>, className: `hidden md:table-cell ${fit}` },
        { head: 'Usage', cell: (i) => <Status status={i.InUse ? 'in_use' : 'unused'} />, className: fit },
        { head: 'Size', cell: (i) => <span className="tabular-nums">{bytes(i.Size)}</span>, className: fit },
        { head: 'Created', cell: (i) => <span className="text-muted-foreground">{timeAgo(i.Created)}</span>, className: `hidden sm:table-cell ${fit}` },
      ]}
    />
  )
}

export function VolumesPage() {
  // Docker walks every volume's files to size them, so the scan only runs when asked.
  const usage = useQuery({
    queryKey: ['volume-usage'],
    queryFn: () => api.get<VolumeUsageReport>('/docker/volume-usage'),
    enabled: false,
    staleTime: Infinity,
  })
  const sizes = new Map(usage.data?.volumes.map((v) => [v.name, v]))
  const largest = Math.max(1, ...(usage.data?.volumes.map((v) => v.size ?? 0) ?? []))
  const sizeOf = (v: Volume) => sizes.get(v.Name)?.size ?? -1

  return (
    <ResourcePage<Volume>
      title="Volumes"
      icon={<HardDrive />}
      description={(items) =>
        usage.data
          ? `${items.length} volumes · ${bytes(usage.data.total_size)} on disk · ${bytes(usage.data.reclaimable)} in unused volumes`
          : `${items.length} volumes · click one to browse its files`
      }
      actions={
        <Button
          variant="secondary"
          size="sm"
          icon={<Gauge />}
          label={usage.data ? 'Rescan disk usage' : 'Scout disk usage'}
          tooltip="Measure how much disk each volume uses"
          isLoading={usage.isFetching}
          onClick={() => usage.refetch().then((r) => r.error && toast.error(r.error.message))}
        />
      }
      sort={usage.data ? (a, b) => sizeOf(b) - sizeOf(a) : undefined}
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
        ...(usage.data ? [{ head: 'Size', cell: (v: Volume) => <UsageCell usage={sizes.get(v.Name)} largest={largest} />, className: 'w-56 min-w-44' }] : []),
        { head: 'Driver', cell: (v) => v.Driver, className: `hidden sm:table-cell ${fit}` },
        { head: 'Stack', cell: (v) => v.Labels?.['com.docker.compose.project'] ?? <span className="text-muted-foreground/60">—</span>, className: fit },
        { head: 'Created', cell: (v) => <span className="text-muted-foreground">{v.CreatedAt ? timeAgo(v.CreatedAt) : '—'}</span>, className: `hidden sm:table-cell ${fit}` },
      ]}
    />
  )
}

/** A volume's size with a bar scaled to the largest volume; unused volumes are flagged. */
function UsageCell({ usage, largest }: { usage?: VolumeUsageReport['volumes'][number]; largest: number }) {
  // Missing: created after the scan. Null size: the driver can't report one.
  if (!usage || usage.size === null) return <span className="text-muted-foreground/60">—</span>
  return (
    <div className="flex flex-col gap-1">
      <span className="tabular-nums">
        {bytes(usage.size)}
        {usage.ref_count === 0 && <span className="ml-2 text-xs text-muted-foreground">unused</span>}
      </span>
      <div className="h-1 w-full overflow-hidden rounded-full bg-muted" aria-hidden>
        <div className={`h-full rounded-full ${usage.ref_count === 0 ? 'bg-warning' : 'bg-brand'}`} style={{ width: usage.size > 0 ? `${Math.max(2, (usage.size / largest) * 100)}%` : 0 }} />
      </div>
    </div>
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
        { head: 'Driver', cell: (n) => n.Driver, className: fit },
        { head: 'Subnet', cell: (n) => <span className={mono}>{n.IPAM?.Config?.map((c) => c.Subnet).filter(Boolean).join(', ') || '—'}</span>, className: `hidden sm:table-cell ${fit}` },
        { head: 'Created', cell: (n) => <span className="text-muted-foreground">{timeAgo(n.Created)}</span>, className: `hidden md:table-cell ${fit}` },
      ]}
    />
  )
}
