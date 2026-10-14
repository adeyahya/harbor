import { MoreHorizontal, Play, RotateCw, ScrollText, Square, Trash2 } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { Link, useNavigate } from 'react-router'
import type { ContainerInspect, ContainerSummary, Port } from '@/api'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { containerName, shortId, timeAgo } from '@/lib/format'
import { Confirm } from './confirm'
import { Status } from './status'
import { useRunAction } from './updates'

export function PortChips({ ports }: { ports?: Port[] | null }) {
  ports = ports ?? []
  // Docker reports IPv4 and IPv6 bindings separately; show each mapping once.
  const unique = [...new Map(ports.map((p) => [`${p.PublicPort}-${p.PrivatePort}-${p.Type}`, p])).values()].sort((a, b) => a.PrivatePort - b.PrivatePort)
  if (!unique.length) return <span className="text-muted-foreground/60">—</span>
  return (
    <div className="flex flex-wrap gap-1">
      {unique.map((p) => {
        const label = `${p.PublicPort ? `${p.PublicPort}:` : ''}${p.PrivatePort}${p.Type !== 'tcp' ? `/${p.Type}` : ''}`
        return p.PublicPort ? (
          <a
            key={label}
            href={`http://${window.location.hostname}:${p.PublicPort}`}
            target="_blank"
            rel="noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="rounded-md border border-brand/25 bg-brand/10 px-1.5 py-0.5 font-mono text-[11px] text-brand hover:underline"
          >
            {label}
          </a>
        ) : (
          <span key={label} className="rounded-md border bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
            {label}
          </span>
        )
      })}
    </div>
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
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" onClick={(e) => e.stopPropagation()} aria-label="Container actions">
          <MoreHorizontal />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
        <DropdownMenuItem onSelect={() => navigate(`/containers/${id}`)}>
          <ScrollText /> View logs
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {state === 'running' ? (
          <>
            <DropdownMenuItem onSelect={() => act('restart')}>
              <RotateCw /> Restart
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => act('stop')}>
              <Square /> Stop
            </DropdownMenuItem>
          </>
        ) : (
          <DropdownMenuItem onSelect={() => act('start')}>
            <Play /> Start
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onSelect={() => setConfirming(true)}>
          <Trash2 /> Remove
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
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
    <Table>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead className="pl-4">Name</TableHead>
          <TableHead>Status</TableHead>
          <TableHead className="hidden md:table-cell">Image</TableHead>
          <TableHead>Ports</TableHead>
          {showStack && <TableHead className="hidden lg:table-cell">Stack</TableHead>}
          <TableHead className="hidden sm:table-cell">Created</TableHead>
          <TableHead className="w-10" />
        </TableRow>
      </TableHeader>
      <TableBody>
        {containers.map((c) => {
          const project = c.Labels?.['com.docker.compose.project']
          const name = containerName(c.Names)
          return (
            <TableRow key={c.Id} className="cursor-pointer" onClick={() => navigate(`/containers/${c.Id}`)}>
              <TableCell className="pl-4">
                <div className="font-medium">{name}</div>
                <div className="text-xs text-muted-foreground">{c.Status}</div>
              </TableCell>
              <TableCell>
                <Status status={c.State} />
              </TableCell>
              <TableCell className="hidden max-w-52 truncate font-mono text-xs text-muted-foreground md:table-cell" title={c.Image}>
                {c.Image}
              </TableCell>
              <TableCell>
                <PortChips ports={c.Ports} />
              </TableCell>
              {showStack && (
                <TableCell className="hidden lg:table-cell">
                  {project ? (
                    <Link to={`/stacks/${project}`} onClick={(e) => e.stopPropagation()} className="text-brand hover:underline">
                      {project}
                    </Link>
                  ) : (
                    <span className="text-muted-foreground/60">—</span>
                  )}
                </TableCell>
              )}
              <TableCell className="hidden text-muted-foreground sm:table-cell">{timeAgo(c.Created)}</TableCell>
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
