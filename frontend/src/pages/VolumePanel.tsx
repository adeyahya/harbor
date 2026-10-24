import { useQuery } from '@tanstack/react-query'
import { ArrowLeft, ChevronRight, Download, File, FileText, Folder, HardDrive, Image as ImageIcon, Link2, Lock, Search } from 'lucide-react'
import { useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router'
import { api, type VolumeDetail, type VolumeEntry, type VolumeFilePreview, type VolumeListing } from '@/api'
import { VolumeBackups } from '@/components/app/backups'
import { EmptyState, ErrorAlert, Loading } from '@/components/app/page'
import { ServicePanel, usePanelTab } from '@/components/app/panel'
import { Status } from '@/components/app/status'
import { Button } from '@/components/ui/button'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { bytes, timeAgo } from '@/lib/format'
import { cn } from '@/lib/utils'

const TABS = ['files', 'backups', 'details'] as const
const IMAGE = /\.(png|jpe?g|gif|webp|svg|ico|bmp)$/i

const join = (dir: string, name: string) => (dir ? `${dir}/${name}` : name)
const parent = (path: string) => path.split('/').slice(0, -1).join('/')

export function VolumePanel() {
  const { name = '' } = useParams()
  return <VolumePanelInner key={name} name={name} />
}

function VolumePanelInner({ name }: { name: string }) {
  const [tab, setTab] = usePanelTab(TABS, 'files')
  const detail = useQuery({ queryKey: ['volume', name], queryFn: () => api.get<VolumeDetail>(`/docker/volumes/${encodeURIComponent(name)}`) })
  const used = detail.data?.used_by ?? []

  return (
    <ServicePanel
      closeTo="/volumes"
      icon={<HardDrive />}
      title={name}
      subtitle={
        <>
          {tab === 'files' && (
            <span className="flex items-center gap-1 text-xs">
              <Lock className="size-3" /> Read-only
            </span>
          )}
          {detail.data && (
            <span>
              {used.length ? `Used by ${used.map((u) => u.name).join(', ')}` : 'Not used by any container'}
            </span>
          )}
        </>
      }
      tabs={[
        { id: 'files', label: 'Files' },
        { id: 'backups', label: 'Backups' },
        { id: 'details', label: 'Details' },
      ]}
      tab={tab}
      onTabChange={setTab}
    >
      {tab === 'files' && <Explorer volume={name} />}
      {tab === 'backups' && <VolumeBackups volume={name} />}
      {tab === 'details' &&
        (detail.isLoading ? (
          <Loading />
        ) : detail.data ? (
          <div className="space-y-5">
            <dl className="divide-y overflow-hidden rounded-xl border bg-card text-sm">
              {[
                ['Driver', detail.data.driver],
                ['Mount point', detail.data.mountpoint],
                ['Created', detail.data.created_at ? timeAgo(detail.data.created_at) : '—'],
                ['Stack', detail.data.labels['com.docker.compose.project'] ?? '—'],
              ].map(([k, v]) => (
                <div key={k} className="grid grid-cols-[8rem_1fr] gap-4 px-4 py-3">
                  <dt className="text-muted-foreground">{k}</dt>
                  <dd className="min-w-0 font-mono text-[12px] break-all">{v}</dd>
                </div>
              ))}
            </dl>
            <div>
              <h3 className="mb-2 text-sm font-semibold">Used by</h3>
              {used.length ? (
                <div className="divide-y overflow-hidden rounded-xl border bg-card">
                  {used.map((u) => (
                    <Link key={u.id} to={`/containers/${u.id}`} className="flex items-center gap-3 px-4 py-3 text-sm hover:bg-accent/40">
                      <span className="font-medium">{u.name}</span>
                      <span className="font-mono text-xs text-muted-foreground">→ {u.destination}</span>
                      <Status status={u.state} className="ml-auto" />
                    </Link>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">No container mounts this volume.</p>
              )}
            </div>
          </div>
        ) : (
          <ErrorAlert error={detail.error} />
        ))}
    </ServicePanel>
  )
}

function EntryIcon({ entry }: { entry: VolumeEntry }) {
  if (entry.kind === 'dir') return <Folder className="size-4 fill-brand/20 text-brand" />
  if (entry.kind === 'link') return <Link2 className="size-4 text-muted-foreground" />
  if (IMAGE.test(entry.name)) return <ImageIcon className="size-4 text-muted-foreground" />
  if (/\.(txt|md|json|ya?ml|toml|conf|ini|env|log|csv|xml|html?|js|ts|css|sh|py|sql)$/i.test(entry.name)) return <FileText className="size-4 text-muted-foreground" />
  return <File className="size-4 text-muted-foreground" />
}

function Explorer({ volume }: { volume: string }) {
  const [params, setParams] = useSearchParams()
  const path = params.get('path') ?? ''
  const file = params.get('file')
  const [filter, setFilter] = useState('')
  const go = (next: { path?: string; file?: string | null }) =>
    setParams(
      (p) => {
        if (next.path !== undefined) p.set('path', next.path)
        if (next.file === null) p.delete('file')
        else if (next.file !== undefined) p.set('file', next.file)
        return p
      },
      { replace: false },
    )

  const listing = useQuery({
    queryKey: ['volume-files', volume, path],
    queryFn: () => api.get<VolumeListing>(`/docker/volumes/${encodeURIComponent(volume)}/files?${new URLSearchParams({ path })}`),
    enabled: !file,
  })

  if (file) return <FilePreview volume={volume} path={file} onBack={() => go({ file: null })} />

  const crumbs = path ? path.split('/') : []
  const q = filter.toLowerCase()
  const entries = (listing.data?.entries ?? []).filter((e) => e.name.toLowerCase().includes(q))

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <nav className="flex min-w-0 flex-1 flex-wrap items-center gap-0.5 font-mono text-[13px]" aria-label="Path">
          <button onClick={() => go({ path: '' })} className="rounded px-1.5 py-0.5 hover:bg-accent">
            {volume}
          </button>
          {crumbs.map((c, i) => (
            <span key={i} className="flex items-center gap-0.5">
              <ChevronRight className="size-3.5 text-muted-foreground" />
              <button onClick={() => go({ path: crumbs.slice(0, i + 1).join('/') })} className="rounded px-1.5 py-0.5 hover:bg-accent">
                {c}
              </button>
            </span>
          ))}
        </nav>
        <div className="relative w-full sm:w-52">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter this folder"
            className="h-8 w-full rounded-lg border bg-background pr-2 pl-8 text-sm outline-none placeholder:text-muted-foreground focus:border-ring"
          />
        </div>
      </div>

      {listing.isLoading ? (
        <div className="rounded-xl border bg-card">
          <Loading />
          <p className="-mt-10 pb-6 text-center text-xs text-muted-foreground">Opening the volume (the first time takes a few seconds)…</p>
        </div>
      ) : listing.error ? (
        <ErrorAlert error={listing.error} />
      ) : !listing.data?.entries.length ? (
        <div className="rounded-xl border bg-card">
          <EmptyState icon={<Folder />} title="This folder is empty" />
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border bg-card">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="pl-4">Name</TableHead>
                <TableHead className="w-24 text-right">Size</TableHead>
                <TableHead className="hidden w-32 sm:table-cell">Modified</TableHead>
                <TableHead className="hidden w-28 md:table-cell">Permissions</TableHead>
                <TableHead className="w-10" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {path && (
                <TableRow className="cursor-pointer" onClick={() => go({ path: parent(path) })}>
                  <TableCell className="pl-4" colSpan={5}>
                    <span className="flex items-center gap-2 text-muted-foreground">
                      <ArrowLeft className="size-4" /> ..
                    </span>
                  </TableCell>
                </TableRow>
              )}
              {entries.map((e) => {
                const full = join(path, e.name)
                const open = () => (e.kind === 'dir' ? go({ path: full }) : e.kind === 'file' ? go({ file: full }) : undefined)
                return (
                  <TableRow key={e.name} className={cn(e.kind !== 'other' && e.kind !== 'link' && 'cursor-pointer')} onClick={open}>
                    <TableCell className="pl-4">
                      <span className="flex min-w-0 items-center gap-2">
                        <EntryIcon entry={e} />
                        <span className={cn('truncate', e.kind === 'dir' && 'font-medium')}>{e.name}</span>
                        {e.kind === 'link' && <span className="text-xs text-muted-foreground">symlink</span>}
                      </span>
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs text-muted-foreground tabular-nums">{e.kind === 'file' ? bytes(e.size) : '—'}</TableCell>
                    <TableCell className="hidden text-xs text-muted-foreground sm:table-cell">{timeAgo(e.modified)}</TableCell>
                    <TableCell className="hidden font-mono text-xs text-muted-foreground md:table-cell">{e.mode}</TableCell>
                    <TableCell className="pr-3 text-right" onClick={(ev) => ev.stopPropagation()}>
                      {e.kind === 'file' && (
                        <Button variant="ghost" size="icon-sm" asChild>
                          <a href={downloadUrl(volume, full)} title={`Download ${e.name}`} aria-label={`Download ${e.name}`}>
                            <Download />
                          </a>
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
          {listing.data.truncated && <p className="border-t px-4 py-2 text-xs text-muted-foreground">Showing the first 2,000 entries.</p>}
          {q && !entries.length && <p className="px-4 py-6 text-center text-sm text-muted-foreground">No entries match “{filter}”.</p>}
        </div>
      )}
    </div>
  )
}

const downloadUrl = (volume: string, path: string) => `/api/docker/volumes/${encodeURIComponent(volume)}/download?${new URLSearchParams({ path })}`

function FilePreview({ volume, path, onBack }: { volume: string; path: string; onBack: () => void }) {
  const isImage = IMAGE.test(path)
  const preview = useQuery({
    queryKey: ['volume-file', volume, path],
    queryFn: () => api.get<VolumeFilePreview>(`/docker/volumes/${encodeURIComponent(volume)}/file?${new URLSearchParams({ path })}`),
    enabled: !isImage,
  })
  const lines = preview.data?.content?.split('\n') ?? []
  return (
    <div className="flex h-[calc(100vh-15rem)] min-h-96 flex-col gap-3">
      <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" onClick={onBack}>
          <ArrowLeft /> Back
        </Button>
        <span className="min-w-0 flex-1 truncate font-mono text-[13px]">{path}</span>
        <Button size="sm" asChild>
          <a href={downloadUrl(volume, path)}>
            <Download /> Download
          </a>
        </Button>
      </div>
      <div className="scrollbar-thin min-h-0 flex-1 overflow-auto rounded-xl border bg-log">
        {isImage ? (
          <div className="flex h-full items-center justify-center p-6">
            <img src={downloadUrl(volume, path)} alt={path} className="max-h-full max-w-full rounded-md object-contain" />
          </div>
        ) : preview.isLoading ? (
          <Loading />
        ) : preview.error ? (
          <div className="p-4">
            <ErrorAlert error={preview.error} />
          </div>
        ) : preview.data?.binary ? (
          <EmptyState icon={<File />} title="Binary file" action={<Button asChild><a href={downloadUrl(volume, path)}>Download</a></Button>}>
            This file isn't text, so it can't be previewed here.
          </EmptyState>
        ) : (
          <>
            <table className="w-full font-mono text-[12px] leading-5">
              <tbody>
                {lines.map((l, i) => (
                  <tr key={i} className="hover:bg-accent/30">
                    <td className="w-12 pr-3 pl-3 text-right align-top text-muted-foreground/50 select-none">{i + 1}</td>
                    <td className="pr-4 break-all whitespace-pre-wrap">{l || ' '}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {preview.data?.truncated && <p className="border-t px-4 py-2 text-xs text-muted-foreground">Showing the first 1 MB. Download the file to see all of it.</p>}
          </>
        )}
      </div>
    </div>
  )
}
