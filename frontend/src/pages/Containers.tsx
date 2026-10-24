import { useQuery } from '@tanstack/react-query'
import { Container, Search } from 'lucide-react'
import { useState } from 'react'
import { Outlet, useParams } from 'react-router'
import { api, type ContainerInspect, type ContainerSummary } from '@/api'
import { Confirm } from '@/components/app/confirm'
import { ContainerDetails, ContainersTable, ContainerMenu } from '@/components/app/containers'
import { LogViewer } from '@/components/app/LogViewer'
import { Terminal } from '@/components/app/Terminal'
import { EmptyState, ErrorAlert, Loading, Page, PageHeader, Surface } from '@/components/app/page'
import { ServicePanel, usePanelTab } from '@/components/app/panel'
import { Status } from '@/components/app/status'
import { useRunAction } from '@/components/app/updates'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { containerName } from '@/lib/format'

export function ContainersPage() {
  const { data, isLoading, error } = useQuery({
    queryKey: ['containers'],
    queryFn: () => api.get<ContainerSummary[]>('/docker/containers'),
    refetchInterval: 4000,
  })
  const run = useRunAction()
  const [search, setSearch] = useState('')
  const [state, setState] = useState('all')

  const running = data?.filter((c) => c.State === 'running').length ?? 0
  const filtered = (data ?? []).filter(
    (c) =>
      (state === 'all' || (state === 'running' ? c.State === 'running' : c.State !== 'running')) &&
      (containerName(c.Names) + ' ' + c.Image).toLowerCase().includes(search.toLowerCase()),
  )

  return (
    <Page>
      <PageHeader
        title="Containers"
        description={data ? `${running} running · ${data.length - running} stopped` : 'Every container on this Docker engine'}
        actions={
          <Confirm title="Prune stopped containers?" description="All stopped containers are removed. This can't be undone." confirmLabel="Prune" onConfirm={() => run.mutate({ path: '/docker/prune/containers' })}>
            <Button variant="outline" size="sm">
              Prune stopped
            </Button>
          </Confirm>
        }
      />
      <ErrorAlert error={error} className="mb-4" />
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="relative w-full sm:w-72">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input placeholder="Search containers" value={search} onChange={(e) => setSearch(e.target.value)} className="pl-8" />
        </div>
        <Tabs value={state} onValueChange={setState}>
          <TabsList>
            <TabsTrigger value="all">All</TabsTrigger>
            <TabsTrigger value="running">Running</TabsTrigger>
            <TabsTrigger value="stopped">Stopped</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>
      <Surface>
        {isLoading ? (
          <Loading />
        ) : filtered.length ? (
          <ContainersTable containers={filtered} />
        ) : (
          <EmptyState icon={<Container />} title={data?.length ? 'No matching containers' : 'No containers'}>
            {data?.length ? 'Try a different search or filter.' : 'Deploy a stack or a deployment to create containers.'}
          </EmptyState>
        )}
      </Surface>
      <Outlet />
    </Page>
  )
}

const TABS = ['logs', 'terminal', 'details', 'inspect'] as const

export function ContainerPanel() {
  const { id = '' } = useParams()
  const [tab, setTab] = usePanelTab(TABS, 'logs')
  const { data, isLoading, error } = useQuery({
    queryKey: ['container', id],
    queryFn: () => api.get<ContainerInspect>(`/docker/containers/${id}`),
    refetchInterval: 4000,
  })
  const name = data?.Name.replace(/^\//, '') ?? id.slice(0, 12)

  return (
    <ServicePanel
      closeTo="/containers"
      icon={<Container />}
      title={name}
      subtitle={
        data ? (
          <>
            <Status status={data.State.Status} />
            <span className="font-mono text-xs">{data.Config.Image}</span>
          </>
        ) : (
          'Container'
        )
      }
      tabs={[
        { id: 'logs', label: 'Logs' },
        { id: 'terminal', label: 'Terminal' },
        { id: 'details', label: 'Details' },
        { id: 'inspect', label: 'Inspect' },
      ]}
      tab={tab}
      onTabChange={setTab}
      actions={data && <ContainerMenu id={data.Id} state={data.State.Status} name={name} />}
    >
      {isLoading ? (
        <Loading />
      ) : !data ? (
        <ErrorAlert error={error ?? 'Container not found'} />
      ) : (
        <>
          {tab === 'logs' && <LogViewer containerId={data.Id} className="h-[calc(100vh-15rem)] min-h-96" />}
          {tab === 'terminal' && <Terminal containerId={data.Id} running={data.State.Running} className="h-[calc(100vh-15rem)] min-h-96" />}
          {tab === 'details' && <ContainerDetails c={data} />}
          {tab === 'inspect' && <pre className="scrollbar-thin overflow-auto rounded-xl border bg-log p-4 font-mono text-[12px] leading-5">{JSON.stringify(data, null, 2)}</pre>}
        </>
      )}
    </ServicePanel>
  )
}
