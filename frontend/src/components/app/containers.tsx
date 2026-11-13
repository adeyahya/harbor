import { MoreHorizontal, Play, RotateCw, ScrollText, Square, Trash2 } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { Link, useNavigate } from 'react-router'
import type { ContainerInspect, ContainerSummary, Port } from '@/api'
import { DropdownMenu, DropdownMenuDivider, DropdownMenuItem } from '@astryxdesign/core/DropdownMenu'
import { IconButton } from '@astryxdesign/core/IconButton'
import { Popover } from '@astryxdesign/core/Popover'
import { Table, TableBody, TableCell, TableHeader, TableHeaderCell, TableRow } from '@astryxdesign/core/Table'
import { containerName, shortId, timeAgo } from '@/lib/format'
import { Confirm } from './confirm'
import { Status } from './status'
import { useRunAction } from './updates'

const chip = 'rounded-md border px-1.5 py-0.5 font-mono text-[11px] whitespace-nowrap'

const portLabel = (p: Port) => `${p.PublicPort ? `${p.PublicPort}:` : ''}${p.PrivatePort}${p.Type !== 'tcp' ? `/${p.Type}` : ''}`

/** Published ports (reachable from the host) first, then exposed-only ones, each by port number. */
function sortedPorts(ports: Port[]): Port[] {
  // Docker reports IPv4 and IPv6 bindings separately; show each mapping once.
  const unique = [...new Map(ports.map((p) => [`${p.PublicPort}-${p.PrivatePort}-${p.Type}`, p])).values()]
  return unique.sort((a, b) => Number(!a.PublicPort) - Number(!b.PublicPort) || a.PrivatePort - b.PrivatePort || a.Type.localeCompare(b.Type))
}

function PortChip({ port }: { port: Port }) {
  const label = portLabel(port)
  return port.PublicPort ? (
    <a
      href={`http://${window.location.hostname}:${port.PublicPort}`}
      target="_blank"
      rel="noreferrer"
      onClick={(e) => e.stopPropagation()}
      className={`${chip} border-brand/25 bg-brand/10 text-brand hover:underline`}
    >
      {label}
    </a>
  ) : (
    <span className={`${chip} bg-muted text-muted-foreground`}>{label}</span>
  )
}

/**
 * A container's ports as chips. With `limit`, shows that many and a "+N" chip
 * that opens a popover listing every port.
 */
export function PortChips({ ports, limit }: { ports?: Port[] | null; limit?: number }) {
  const all = sortedPorts(ports ?? [])
  if (!all.length) return <span className="text-muted-foreground/60">—</span>
  const shown = limit === undefined ? all : all.slice(0, limit)
  const hidden = all.length - shown.length
  return (
    <div className="flex flex-wrap items-center gap-1">
      {shown.map((p) => (
        <PortChip key={portLabel(p)} port={p} />
      ))}
      {hidden > 0 && <AllPorts ports={all} more={hidden} />}
    </div>
  )
}

function AllPorts({ ports, more }: { ports: Port[]; more: number }) {
  const published = ports.filter((p) => p.PublicPort)
  const exposed = ports.filter((p) => !p.PublicPort)
  return (
    <Popover
      label="All ports"
      placement="below"
      alignment="start"
      width={320}
      content={
        // The popover portals out, but React events still bubble to the table row.
        <div className="space-y-3" onClick={(e) => e.stopPropagation()}>
          <p className="text-sm font-medium">{ports.length} ports</p>
          {[
            { title: 'Published', hint: 'Open on the host', list: published },
            { title: 'Exposed only', hint: 'Reachable from other containers', list: exposed },
          ]
            .filter((g) => g.list.length)
            .map((g) => (
              <div key={g.title}>
                <p className="mb-1.5 text-xs text-muted-foreground">
                  {g.title} · {g.hint}
                </p>
                <div className="flex flex-wrap gap-1">
                  {g.list.map((p) => (
                    <PortChip key={portLabel(p)} port={p} />
                  ))}
                </div>
              </div>
            ))}
        </div>
      }
    >
      {(trigger) => (
        <button
          {...trigger}
          type="button"
          aria-label={`Show all ${ports.length} ports`}
          onClick={(e) => {
            e.stopPropagation()
            trigger.onClick(e)
          }}
          className={`${chip} bg-transparent text-muted-foreground hover:bg-muted hover:text-foreground`}
        >
          +{more}
        </button>
      )}
    </Popover>
  )
}

/** Start/stop/restart/remove menu for one container. */
export function ContainerMenu({ id, state, name }: { id: string; state: string; name: string }) {
  const run = useRunAction()
  const navigate = useNavigate()
  const [confirming, setConfirming] = useState(false)
  const act = (action: string) => run.mutate({ path: `/docker/containers/${id}/${action}` })
  return (
    <>
    {/* Menus render inside this span in the React tree; keep their clicks off parent rows. */}
    <span className="contents" onClick={(e) => e.stopPropagation()}>
      <DropdownMenu
        alignment="end"
        hasChevron={false}
        renderTrigger={(props) => <IconButton {...props} variant="ghost" size="sm" label="Container actions" icon={<MoreHorizontal />} />}
      >
        <DropdownMenuItem icon={<ScrollText />} label="View logs" onClick={() => navigate(`/containers/${id}`)} />
        <DropdownMenuDivider />
        {state === 'running' ? (
          <>
            <DropdownMenuItem icon={<RotateCw />} label="Restart" onClick={() => act('restart')} />
            <DropdownMenuItem icon={<Square />} label="Stop" onClick={() => act('stop')} />
          </>
        ) : (
          <DropdownMenuItem icon={<Play />} label="Start" onClick={() => act('start')} />
        )}
        <DropdownMenuDivider />
        <DropdownMenuItem variant="destructive" icon={<Trash2 />} label="Remove" onClick={() => setConfirming(true)} />
      </DropdownMenu>
    </span>
    <Confirm
      open={confirming}
      onOpenChange={setConfirming}
      title={`Remove ${name}?`}
      description="The container is force-removed. Named volumes are kept."
      confirmLabel="Remove"
      onConfirm={() => run.mutate({ path: `/docker/containers/${id}`, method: 'del' })}
    />
    </>
  )
}

export function ContainersTable({ containers, showStack = true }: { containers: ContainerSummary[]; showStack?: boolean }) {
  const navigate = useNavigate()
  return (
    <Table hasHover>
      <TableHeader>
        <TableRow isHeaderRow>
          <TableHeaderCell className="min-w-44 pl-4">Name</TableHeaderCell>
          <TableHeaderCell className="min-w-28">Status</TableHeaderCell>
          <TableHeaderCell className="hidden md:table-cell">Image</TableHeaderCell>
          <TableHeaderCell className="min-w-40">Ports</TableHeaderCell>
          {showStack && <TableHeaderCell className="hidden min-w-32 lg:table-cell">Stack</TableHeaderCell>}
          <TableHeaderCell className="hidden min-w-28 sm:table-cell">Created</TableHeaderCell>
          <TableHeaderCell className="w-14 min-w-14" />
        </TableRow>
      </TableHeader>
      <TableBody>
        {containers.map((c) => {
          const project = c.Labels?.['com.docker.compose.project']
          const name = containerName(c.Names)
          return (
            <TableRow key={c.Id} className="cursor-pointer" onClick={() => navigate(`/containers/${c.Id}`)}>
              <TableCell className="pl-4">
                <div className="font-medium break-words">{name}</div>
                <div className="text-xs text-muted-foreground">{c.Status}</div>
              </TableCell>
              <TableCell className="whitespace-nowrap">
                <Status status={c.State} />
              </TableCell>
              <TableCell className="hidden max-w-52 font-mono text-xs text-muted-foreground md:table-cell">
                <div className="truncate" title={c.Image}>
                  {c.Image}
                </div>
              </TableCell>
              <TableCell>
                <PortChips ports={c.Ports} limit={2} />
              </TableCell>
              {showStack && (
                <TableCell className="hidden break-words lg:table-cell">
                  {project ? (
                    <Link to={`/stacks/${project}`} onClick={(e) => e.stopPropagation()} className="text-brand hover:underline">
                      {project}
                    </Link>
                  ) : (
                    <span className="text-muted-foreground/60">—</span>
                  )}
                </TableCell>
              )}
              <TableCell className="hidden whitespace-nowrap text-muted-foreground sm:table-cell">{timeAgo(c.Created)}</TableCell>
              {/* Dialogs portal out but their events still bubble here; keep them off the row. */}
              <TableCell className="pr-3 text-right" onClick={(e) => e.stopPropagation()}>
                <ContainerMenu id={c.Id} state={c.State} name={name} />
              </TableCell>
            </TableRow>
          )
        })}
      </TableBody>
    </Table>
  )
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-1 gap-1 px-4 py-3 text-sm sm:grid-cols-[9rem_1fr] sm:gap-4">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  )
}

export function ContainerDetails({ c }: { c: ContainerInspect }) {
  const ports = Object.entries(c.NetworkSettings.Ports ?? {})
  const project = c.Config.Labels?.['com.docker.compose.project']
  const deployment = c.Config.Labels?.['harbor.deployment']
  const mono = 'font-mono text-[12px]'
  return (
    <dl className="divide-y overflow-hidden rounded-xl border bg-card">
      <Row label="Status">
        <Status status={c.State.Health?.Status === 'unhealthy' ? 'unhealthy' : c.State.Status} />
      </Row>
      <Row label="Container ID">
        <span className={mono}>{shortId(c.Id)}</span>
      </Row>
      <Row label="Image">
        <span className={mono}>{c.Config.Image}</span>
      </Row>
      <Row label={c.State.Running ? 'Started' : 'Exit code'}>{c.State.Running ? timeAgo(c.State.StartedAt) : c.State.ExitCode}</Row>
      {project && (
        <Row label="Stack">
          <Link className="text-brand hover:underline" to={`/stacks/${project}`}>
            {project}
          </Link>
        </Row>
      )}
      {deployment && (
        <Row label="Deployment">
          <Link className="text-brand hover:underline" to={`/deployments/${deployment}`}>
            {deployment}
          </Link>
        </Row>
      )}
      <Row label="Restart policy">{c.HostConfig.RestartPolicy?.Name || 'no'}</Row>
      <Row label="Ports">
        {ports.length ? (
          <div className="space-y-0.5">
            {ports.map(([k, v]) => (
              <div key={k} className={mono}>
                {v?.length ? `${v[0].HostPort} → ${k}` : k}
              </div>
            ))}
          </div>
        ) : (
          '—'
        )}
      </Row>
      <Row label="Networks">
        {Object.entries(c.NetworkSettings.Networks ?? {}).map(([name, n]) => (
          <div key={name}>
            {name} {n.IPAddress && <span className={`${mono} text-muted-foreground`}>{n.IPAddress}</span>}
          </div>
        ))}
      </Row>
      <Row label="Mounts">
        {c.Mounts.length
          ? c.Mounts.map((m) => (
              <div key={m.Destination} className={mono}>
                {m.Type === 'volume' && m.Name ? (
                  <Link to={`/volumes/${encodeURIComponent(m.Name)}`} className="text-brand hover:underline" title="Browse this volume">
                    {m.Name}
                  </Link>
                ) : (
                  (m.Name ?? m.Source)
                )}{' '}
                → {m.Destination} {!m.RW && <span className="text-muted-foreground">(ro)</span>}
              </div>
            ))
          : '—'}
      </Row>
      <Row label="Command">
        <span className={mono}>{c.Config.Cmd?.join(' ') || '—'}</span>
      </Row>
    </dl>
  )
}
