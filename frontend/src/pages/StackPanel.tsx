import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowDownToLine, GitBranch, Layers, MoreHorizontal, Play, Power, RotateCw, Square, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import { toast } from 'sonner'
import { api, repoLabel, type Stack, type StackDetail } from '@/api'
import { Confirm } from '@/components/app/confirm'
import { ContainersTable } from '@/components/app/containers'
import { LogViewer } from '@/components/app/LogViewer'
import { GithubIcon } from '@/components/app/GithubIcon'
import { EmptyState, ErrorAlert, Loading } from '@/components/app/page'
import { AutoDeploySettings, StackSourceSettings, type StackSourceConfig } from '@/components/app/SourceSettings'
import { ChangesBar, CodeEditor, ServicePanel, SettingsSection, usePanelTab, VariablesEditor } from '@/components/app/panel'
import { Status } from '@/components/app/status'
import { DeploymentHistory, useRunAction } from '@/components/app/updates'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { containerName, timeAgo } from '@/lib/format'

const TABS = ['deployments', 'services', 'logs', 'variables', 'settings'] as const

const FIELDS = ['compose', 'env', 'source', 'git_url', 'git_branch', 'compose_path', 'project_dir', 'auto_deploy', 'git_account_id'] as const satisfies readonly (keyof Stack)[]
type Config = Pick<Stack, (typeof FIELDS)[number]>
const pick = (s: Stack) => Object.fromEntries(FIELDS.map((f) => [f, s[f]])) as Config

export function StackPanel() {
  const { name = '' } = useParams()
  // Remount per stack so drafts never leak between services.
  return <StackPanelInner key={name} name={name} />
}

function StackPanelInner({ name }: { name: string }) {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const run = useRunAction()
  const [tab, setTab] = usePanelTab(TABS, 'deployments')
  const { data, isLoading, error } = useQuery({
    queryKey: ['stack', name],
    queryFn: () => api.get<StackDetail>(`/stacks/${name}`),
    refetchInterval: 4000,
  })

  // Staged edits on top of the saved stack; the token is tri-state like deployments'.
  const [draft, setDraft] = useState<Partial<Config>>({})
  const [token, setToken] = useState<string | null>(null)
  const config: Config | null = data ? { ...pick(data), ...draft } : null
  const changed: string[] = data ? FIELDS.filter((f) => draft[f] !== undefined && draft[f] !== data[f]) : []
  if (token !== null) changed.push('git_token')
  const changes = changed.length
  const set =
    <K extends keyof Config>(k: K) =>
    (v: Config[K]) =>
      setDraft((d) => ({ ...d, [k]: v }))
  const setSource = set as <K extends keyof StackSourceConfig>(k: K) => (v: StackSourceConfig[K]) => void
  const setCompose = set('compose')
  const setEnv = set('env')
  const [confirm, setConfirm] = useState<'down' | 'delete' | null>(null)
  const [logContainer, setLogContainer] = useState('')

  const save = useMutation({
    mutationFn: () => api.put<Stack>(`/stacks/${name}`, { ...config, git_token: token ?? undefined }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['stack', name] })
      setDraft({})
      setToken(null)
      toast.success('Changes saved')
    },
    onError: (e) => toast.error(e.message),
  })
  const remove = useMutation({
    mutationFn: () => api.del(`/stacks/${name}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['stacks'] })
      toast.success(`Deleted ${name}`)
      navigate('/')
    },
    onError: (e) => toast.error(e.message),
  })

  const action = async (a: string) => {
    if (changes) await save.mutateAsync()
    run.mutate({ path: `/stacks/${name}/${a}` })
    if (a === 'deploy') setTab('deployments')
  }

  const shell = (body: React.ReactNode) => (
    <ServicePanel icon={<Layers />} title={name} subtitle="Stack" tabs={TABS.map((id) => ({ id, label: id[0].toUpperCase() + id.slice(1) }))} tab={tab} onTabChange={setTab}>
      {body}
    </ServicePanel>
  )
  if (isLoading) return shell(<Loading />)
  if (!data || !config) return shell(<ErrorAlert error={error ?? 'Stack not found'} />)
  const git = data.source === 'git'
  const dot = (fields: string[]) => (fields.some((f) => changed.includes(f)) ? ' •' : '')
  const compose = draft.compose ?? null
  const env = draft.env ?? null

  const up = data.status !== 'down'
  const selectedLog = data.containers.find((c) => c.Id === logContainer) ?? data.containers[0]

  return (
    <ServicePanel
      icon={git ? <GithubIcon /> : <Layers />}
      title={data.name}
      subtitle={
        <>
          <Status status={data.status} />
          {git ? (
            <span className="flex min-w-0 items-center gap-1.5 text-xs">
              <span className="truncate font-medium text-foreground/90">{repoLabel(data.git_url)}</span>
              <GitBranch className="size-3 shrink-0" />
              <span className="font-mono">{data.git_branch}</span>
              {data.last_commit && <span className="font-mono text-brand">{data.last_commit.slice(0, 7)}</span>}
            </span>
          ) : (
            <span>Compose stack</span>
          )}
          <span>
            {data.containers.length} service{data.containers.length === 1 ? '' : 's'}
          </span>
          <span>Updated {timeAgo(data.updated_at)}</span>
        </>
      }
      tabs={[
        { id: 'deployments', label: 'Deployments' },
        { id: 'services', label: `Services${data.containers.length ? ` · ${data.containers.length}` : ''}` },
        { id: 'logs', label: 'Logs' },
        { id: 'variables', label: `Variables${dot(['env'])}` },
        { id: 'settings', label: `Settings${dot(['compose', 'source', 'git_url', 'git_branch', 'compose_path', 'project_dir', 'auto_deploy', 'git_account_id', 'git_token'])}` },
      ]}
      tab={tab}
      onTabChange={setTab}
      actions={
        <>
          <Button size="sm" onClick={() => action('deploy')} disabled={run.isPending || save.isPending}>
            <Play /> {up ? 'Redeploy' : 'Deploy'}
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="icon-sm" aria-label="More actions">
                <MoreHorizontal />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
              <DropdownMenuItem onSelect={() => action('pull')}>
                <ArrowDownToLine /> Pull images
              </DropdownMenuItem>
              {up && (
                <>
                  <DropdownMenuItem onSelect={() => action('restart')}>
                    <RotateCw /> Restart
                  </DropdownMenuItem>
                  {data.status === 'stopped' ? (
                    <DropdownMenuItem onSelect={() => action('start')}>
                      <Power /> Start
                    </DropdownMenuItem>
                  ) : (
                    <DropdownMenuItem onSelect={() => action('stop')}>
                      <Square /> Stop
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuSeparator />
                  <DropdownMenuItem variant="destructive" onSelect={() => setConfirm('down')}>
                    <Power /> Take down
                  </DropdownMenuItem>
                </>
              )}
              {!up && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem variant="destructive" onSelect={() => setConfirm('delete')}>
                    <Trash2 /> Delete stack
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </>
      }
      footer={
        <ChangesBar
          count={changes}
          saving={save.isPending}
          onDiscard={() => (setDraft({}), setToken(null))}
          onSave={() => save.mutate()}
          onDeploy={() => action('deploy')}
        />
      }
    >
      {tab === 'deployments' && <DeploymentHistory targetType="stack" targetName={name} />}

      {tab === 'services' &&
        (data.containers.length ? (
          <div className="overflow-hidden rounded-xl border bg-card">
            <ContainersTable containers={data.containers} showStack={false} />
          </div>
        ) : (
          <EmptyState icon={<Layers />} title="Stack is not running" action={<Button onClick={() => action('deploy')}>Deploy now</Button>}>
            Deploy the stack to start its services.
          </EmptyState>
        ))}

      {tab === 'logs' &&
        (selectedLog ? (
          <div className="flex h-[calc(100vh-15rem)] min-h-96 flex-col gap-3">
            {data.containers.length > 1 && (
              <Select value={selectedLog.Id} onValueChange={setLogContainer}>
                <SelectTrigger className="w-64">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {data.containers.map((c) => (
                    <SelectItem key={c.Id} value={c.Id}>
                      {c.Labels['com.docker.compose.service'] ?? containerName(c.Names)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            <LogViewer key={selectedLog.Id} containerId={selectedLog.Id} className="min-h-0 flex-1" />
          </div>
        ) : (
          <EmptyState title="No running services">Deploy the stack to see its logs.</EmptyState>
        ))}

      {tab === 'variables' && (
        <VariablesEditor
          value={env ?? data.env}
          onChange={setEnv}
          description={
            <>
              Written to <code className="font-mono text-xs">.env</code> and available as <code className="font-mono text-xs">{'${VAR}'}</code> in the compose file.
            </>
          }
        />
      )}

      {tab === 'settings' && (
        <div className="space-y-5">
          <StackSourceSettings key={data.updated_at} config={config} set={setSource} hasToken={data.has_token} token={token} onTokenChange={setToken} />
          {config.source === 'git' ? (
            <AutoDeploySettings
              webhookPath={`/api/webhooks/github/stacks/${data.name}`}
              repo={config.git_url}
              branch={config.git_branch}
              enabled={config.auto_deploy}
              onEnabledChange={set('auto_deploy')}
              secret={data.webhook_secret}
            />
          ) : (
            <SettingsSection title="Compose file" description="The compose.yaml for this stack. ⌘S saves, Tab indents.">
              <CodeEditor value={compose ?? data.compose} onChange={setCompose} onSave={() => changes && save.mutate()} />
            </SettingsSection>
          )}
          <SettingsSection title="Danger zone" description="Deleting removes the stack from Harbor. Take it down first to stop its containers." danger>
            <div className="flex flex-wrap gap-2">
              <Button variant="destructive" size="sm" disabled={!up} onClick={() => setConfirm('down')}>
                <Power /> Take down
              </Button>
              <Button variant="destructive" size="sm" disabled={up} onClick={() => setConfirm('delete')}>
                <Trash2 /> Delete stack
              </Button>
            </div>
          </SettingsSection>
        </div>
      )}

      <Confirm
        open={confirm === 'down'}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={`Take down ${name}?`}
        description="Runs docker compose down: containers and networks are removed. Named volumes are kept."
        confirmLabel="Take down"
        onConfirm={() => action('down')}
      />
      <Confirm
        open={confirm === 'delete'}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={`Delete ${name}?`}
        description="The stack's compose file and variables are deleted from Harbor. This can't be undone."
        confirmLabel="Delete stack"
        onConfirm={() => remove.mutate()}
      />
    </ServicePanel>
  )
}
