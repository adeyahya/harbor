import { useQuery } from '@tanstack/react-query'
import { ArrowRight, Box, Cpu, FolderPlus, GitBranch, HardDrive, Layers, MemoryStick, PackageOpen, Pin, Plus } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { Link, Outlet, useLocation } from 'react-router'
import { api, repoLabel, type ContainerSummary, type DeploymentListItem, type Port, type StackListItem, type SystemOverview } from '@/api'
import { GroupNameDialog, GroupSection, Section, ServiceCard, useCanvasActions, useCanvasGroups, type CanvasItem } from '@/components/app/canvas'
import { useCreate } from '@/components/app/CreateDialog'
import { GithubIcon } from '@/components/app/GithubIcon'
import { ErrorAlert, Loading } from '@/components/app/page'
import { StatusDot } from '@/components/app/status'
import { Button } from '@/components/ui/button'
import { bytes, containerName, percent } from '@/lib/format'
import { importableCount, useImportCandidates } from '@/pages/Import'
import { cn } from '@/lib/utils'

function Meter({ icon, label, value, detail }: { icon: ReactNode; label: string; value: number; detail: string }) {
  return (
    <div className="min-w-0 flex-1">
      <div className="mb-1.5 flex items-center gap-1.5 text-xs text-muted-foreground">
        {icon}
        <span className="font-medium text-foreground">{label}</span>
        <span className="ml-auto truncate font-mono text-[11px]">{detail}</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-muted">
        <div
          className={cn('h-full rounded-full transition-[width] duration-700', value > 90 ? 'bg-destructive' : value > 75 ? 'bg-warning' : 'bg-brand')}
          style={{ width: `${Math.min(100, Math.max(2, value))}%` }}
        />
      </div>
    </div>
  )
}

function HostBar({ system }: { system?: SystemOverview }) {
  const host = system?.host
  if (!host || host.cpu_count === 0) return null
  const docker = system.docker
  return (
    <div className="flex flex-col gap-4 rounded-xl border bg-card/80 p-4 shadow-sm backdrop-blur sm:flex-row sm:items-center sm:gap-6">
      <div className="shrink-0">
        <div className="text-sm font-semibold">{host.hostname.replace(/\.local$/, '')}</div>
        <div className="text-xs text-muted-foreground">{docker ? `Docker ${docker.version} · ${docker.containers_running}/${docker.containers} containers up` : 'Docker unreachable'}</div>
      </div>
      <div className="flex flex-1 flex-col gap-3 sm:flex-row sm:gap-5">
        <Meter icon={<Cpu className="size-3.5" />} label="CPU" value={host.cpu_percent} detail={`${host.cpu_percent.toFixed(0)}% of ${host.cpu_count}`} />
        <Meter icon={<MemoryStick className="size-3.5" />} label="Memory" value={percent(host.mem_used, host.mem_total)} detail={`${bytes(host.mem_used)} / ${bytes(host.mem_total)}`} />
        <Meter icon={<HardDrive className="size-3.5" />} label="Disk" value={percent(host.disk_used, host.disk_total)} detail={`${bytes(host.disk_used)} / ${bytes(host.disk_total)}`} />
      </div>
    </div>
  )
}

function publicPorts(ports: Port[]) {
  return [...new Set(ports.filter((p) => p.PublicPort).map((p) => p.PublicPort!))].sort((a, b) => a - b)
}

function PortLinks({ ports }: { ports: number[] }) {
  if (!ports.length) return null
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-1">
      {ports.slice(0, 3).map((p) => (
        <a
          key={p}
          href={`http://${window.location.hostname}:${p}`}
          target="_blank"
          rel="noreferrer"
          onClick={(e) => e.stopPropagation()}
          className="truncate font-mono text-[11.5px] text-brand hover:underline"
        >
          {window.location.hostname}:{p}
        </a>
      ))}
    </div>
  )
}

function EmptyCanvas() {
  const create = useCreate()
  return (
    <div className="mx-auto flex max-w-md flex-col items-center rounded-2xl border bg-card/80 px-8 py-12 text-center shadow-xl shadow-black/10 backdrop-blur">
      <div className="mb-5 grid grid-cols-2 gap-1.5 text-brand">
        <Layers className="size-5" />
        <Box className="size-5" />
        <Box className="size-5 opacity-50" />
        <Plus className="size-5" />
      </div>
      <h2 className="text-xl font-semibold">Nothing deployed yet</h2>
      <p className="mt-2 text-sm text-muted-foreground">Deploy from a GitHub repo, run an image, or start a compose stack.</p>
      <div className="mt-6 flex flex-wrap justify-center gap-2">
        <Button onClick={() => create('repo')}>
          <GithubIcon /> GitHub repo
        </Button>
        <Button variant="outline" onClick={() => create('image')}>
          <Box /> Docker image
        </Button>
        <Button variant="outline" onClick={() => create('stack')}>
          <Layers /> Stack
        </Button>
      </div>
    </div>
  )
}

export function CanvasPage() {
  const { pathname } = useLocation()
  const create = useCreate()
  const system = useQuery({ queryKey: ['system'], queryFn: () => api.get<SystemOverview>('/system'), refetchInterval: 3000 })
  const stacks = useQuery({ queryKey: ['stacks'], queryFn: () => api.get<StackListItem[]>('/stacks'), refetchInterval: 4000 })
  const deployments = useQuery({ queryKey: ['deployments'], queryFn: () => api.get<DeploymentListItem[]>('/deployments'), refetchInterval: 4000 })
  const containers = useQuery({ queryKey: ['containers'], queryFn: () => api.get<ContainerSummary[]>('/docker/containers'), refetchInterval: 4000 })
  const importable = importableCount(useImportCandidates().data)

  const byProject = new Map<string, ContainerSummary[]>()
  for (const c of containers.data ?? []) {
    const p = c.Labels?.['com.docker.compose.project']
    if (p) byProject.set(p, [...(byProject.get(p) ?? []), c])
  }
  const byId = new Map((containers.data ?? []).map((c) => [c.Id, c]))
  const groups = useCanvasGroups()
  const { createGroup } = useCanvasActions()
  const [newGroup, setNewGroup] = useState(false)

  // One list of canvas items, each with the card content it renders.
  const items: (CanvasItem & { body: ReactNode; icon: ReactNode })[] = [
    ...(stacks.data ?? []).map((s) => {
      const services = byProject.get(s.name) ?? []
      return {
        kind: 'stack' as const,
        name: s.name,
        status: s.status,
        pinned: s.pinned,
        groupId: s.group_id,
        to: `/stacks/${s.name}`,
        icon: s.source === 'git' ? <GithubIcon className="size-4.5" /> : <Layers className="size-4.5" />,
        body: (
          <>
            {s.source === 'git' && (
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <span className="truncate font-medium text-foreground/90">{repoLabel(s.git_url)}</span>
                <GitBranch className="size-3 shrink-0" />
                <span className="truncate font-mono">{s.git_branch}</span>
                {s.last_commit && <span className="shrink-0 font-mono text-brand">{s.last_commit.slice(0, 7)}</span>}
              </div>
            )}
            {services.length ? (
              <div className="flex flex-wrap gap-1.5">
                {services.map((c) => (
                  <span key={c.Id} className="inline-flex items-center gap-1.5 rounded-md border bg-muted/50 px-1.5 py-0.5 text-xs">
                    <StatusDot status={c.State} className="size-1.5" />
                    {c.Labels['com.docker.compose.service'] ?? containerName(c.Names)}
                  </span>
                ))}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">Compose stack · not running</p>
            )}
            <PortLinks ports={publicPorts(services.flatMap((c) => c.Ports ?? []))} />
          </>
        ),
      }
    }),
    ...(deployments.data ?? []).map((d) => {
      const c = d.container_id ? byId.get(d.container_id) : undefined
      return {
        kind: 'deployment' as const,
        name: d.name,
        status: d.status,
        pinned: d.pinned,
        groupId: d.group_id,
        to: `/deployments/${d.name}`,
        icon: d.source === 'git' ? <GithubIcon className="size-4.5" /> : <Box className="size-4.5" />,
        body: (
          <>
            {d.source === 'git' ? (
              <div className="space-y-1 text-xs">
                <div className="flex items-center gap-1.5 text-muted-foreground">
                  <span className="truncate font-medium text-foreground/90">{repoLabel(d.git_url)}</span>
                  <GitBranch className="size-3 shrink-0" />
                  <span className="truncate font-mono">{d.git_branch}</span>
                </div>
                {d.last_commit && (
                  <div className="flex items-center gap-1.5 text-muted-foreground">
                    <span className="font-mono text-brand">{d.last_commit.slice(0, 7)}</span>
                    <span className="truncate">{d.last_commit_message}</span>
                  </div>
                )}
              </div>
            ) : (
              <p className="truncate font-mono text-xs text-muted-foreground">{d.image}</p>
            )}
            <PortLinks ports={c ? publicPorts(c.Ports ?? []) : []} />
          </>
        ),
      }
    }),
  ].sort((a, b) => a.name.localeCompare(b.name))

  // Pinned services show only in Pinned; a group that no longer exists counts as none.
  const groupIds = new Set((groups.data ?? []).map((g) => g.id))
  const pinned = items.filter((i) => i.pinned)
  const grouped = (id: number) => items.filter((i) => !i.pinned && i.groupId === id)
  const ungrouped = items.filter((i) => !i.pinned && (i.groupId === null || !groupIds.has(i.groupId)))
  const card = (i: (typeof items)[number]) => (
    <ServiceCard key={`${i.kind}-${i.name}`} item={i} groups={groups.data ?? []} icon={i.icon} selected={pathname === i.to}>
      {i.body}
    </ServiceCard>
  )

  const loading = stacks.isLoading || deployments.isLoading
  const empty = !loading && !stacks.data?.length && !deployments.data?.length

  return (
    <div className="bg-dots min-h-full">
      <div className="mx-auto max-w-6xl space-y-8 px-4 py-6 sm:px-6">
        <ErrorAlert error={system.data?.docker_error && `Docker is unreachable: ${system.data.docker_error}`} />
        <HostBar system={system.data} />
        {importable > 0 && (
          <Link
            to="/import"
            className="flex items-center gap-3 rounded-xl border border-brand/30 bg-brand/10 px-4 py-3 text-sm transition-colors hover:border-brand/50 hover:bg-brand/15"
          >
            <PackageOpen className="size-4.5 shrink-0 text-brand" />
            <span className="min-w-0 flex-1">
              <span className="font-medium">
                {importable} {importable === 1 ? 'service on this server isn\'t' : 'services on this server aren\'t'} managed by Harbor yet.
              </span>{' '}
              <span className="text-muted-foreground">Import them to see them here and deploy them from GitHub.</span>
            </span>
            <span className="flex shrink-0 items-center gap-1 font-medium text-brand">
              Review <ArrowRight className="size-4" />
            </span>
          </Link>
        )}

        {loading ? (
          <Loading />
        ) : empty ? (
          <div className="pt-10">
            <EmptyCanvas />
          </div>
        ) : (
          <div className="space-y-8 pb-24">
            {pinned.length > 0 && (
              <Section title="Pinned" icon={<Pin className="size-3.5 text-brand" />}>
                <Grid>{pinned.map(card)}</Grid>
              </Section>
            )}
            {(groups.data ?? []).map((g, i) => {
              const items = grouped(g.id)
              return (
                <GroupSection key={g.id} group={g} index={i} groups={groups.data ?? []} items={items}>
                  <Grid>{items.map(card)}</Grid>
                </GroupSection>
              )
            })}
            <Section
              title={pinned.length || groups.data?.length ? 'Other services' : 'Services'}
              actions={
                <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={() => setNewGroup(true)}>
                  <FolderPlus /> New group
                </Button>
              }
            >
              <Grid>
                {ungrouped.map(card)}
                <button
                  onClick={() => create()}
                  className="flex min-h-40 w-full flex-col items-center justify-center gap-2 rounded-2xl border border-dashed text-sm text-muted-foreground transition-colors hover:border-brand/50 hover:bg-card/50 hover:text-foreground sm:w-72"
                >
                  <Plus className="size-5" />
                  Add a service
                </button>
              </Grid>
            </Section>
          </div>
        )}
      </div>
      <Outlet />
      <GroupNameDialog
        open={newGroup}
        onOpenChange={setNewGroup}
        title="New group"
        submitLabel="Create group"
        onSubmit={(name) => createGroup.mutate(name, { onSuccess: () => setNewGroup(false) })}
      />
    </div>
  )
}

function Grid({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap justify-center gap-5 sm:justify-start">{children}</div>
}
