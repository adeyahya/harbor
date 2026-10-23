import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowDownToLine, Box, ChevronsUp, CopyPlus, GitBranch, Hammer, Info, MoreHorizontal, Play, Power, RotateCw, Square, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { toast } from 'sonner'
import { api, repoLabel, shortArtifact, type Deployment, type DeploymentDetail } from '@/api'
import { Confirm } from '@/components/app/confirm'
import { ContainerDetails } from '@/components/app/containers'
import { LogViewer } from '@/components/app/LogViewer'
import { Terminal } from '@/components/app/Terminal'
import { GithubIcon } from '@/components/app/GithubIcon'
import { EmptyState, ErrorAlert, Loading } from '@/components/app/page'
import { PortsEditor } from '@/components/app/PortsEditor'
import { AutoPromoteSettings, CreateEnvironmentDialog, PromotePanel, useDeploymentList } from '@/components/app/promote'
import { AutoDeploySettings, SourceSettings, type SourceSettingsSet } from '@/components/app/SourceSettings'
import { ChangesBar, ServicePanel, SettingsSection, usePanelTab, VariablesEditor } from '@/components/app/panel'
import { Status } from '@/components/app/status'
import { DeploymentHistory, useRunAction } from '@/components/app/updates'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { timeAgo } from '@/lib/format'

const TABS = ['deployments', 'logs', 'terminal', 'variables', 'settings', 'container'] as const

const FIELDS = [
  'image',
  'ports',
  'env',
  'volumes',
  'network',
  'restart',
  'command',
  'source',
  'git_url',
  'git_branch',
  'build_context',
  'dockerfile',
  'build_args',
  'auto_deploy',
  'labels',
  'git_account_id',
  'upstream_id',
] as const satisfies readonly (keyof Deployment)[]
type Config = Pick<Deployment, (typeof FIELDS)[number]>
const SETTINGS_FIELDS: (keyof Config)[] = FIELDS.filter((f) => f !== 'env')

export function DeploymentPanel() {
  const { name = '' } = useParams()
  return <DeploymentPanelInner key={name} name={name} />
}

function Field({ label, hint, children, htmlFor }: { label: string; hint?: React.ReactNode; children: React.ReactNode; htmlFor?: string }) {
  return (
    <div className="space-y-2">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  )
}

function DeploymentPanelInner({ name }: { name: string }) {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const run = useRunAction()
  const [tab, setTab] = usePanelTab(TABS, 'deployments')
  const { data, isLoading, error } = useQuery({
    queryKey: ['deployment', name],
    queryFn: () => api.get<DeploymentDetail>(`/deployments/${name}`),
    refetchInterval: 4000,
  })
  const [draft, setDraft] = useState<Partial<Config>>({})
  // null = unchanged, '' = remove, otherwise the replacement token.
  const [token, setToken] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<'destroy' | 'delete' | null>(null)
  const [newEnv, setNewEnv] = useState(false)
  const deployments = useDeploymentList().data

  const config: Config | null = data ? { ...pick(data), ...draft } : null
  const changed: string[] = data ? FIELDS.filter((f) => draft[f] !== undefined && draft[f] !== data[f]) : []
  if (token !== null) changed.push('git_token')
  const set =
    <K extends keyof Config>(k: K) =>
    (v: Config[K]) =>
      setDraft((d) => ({ ...d, [k]: v }))
  const setSource: SourceSettingsSet = (k) => (v) => setDraft((d) => ({ ...d, [k]: v }))

  const save = useMutation({
    mutationFn: () => api.put<Deployment>(`/deployments/${name}`, { ...config, git_token: token ?? undefined }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['deployment', name] })
      setDraft({})
      setToken(null)
      toast.success('Changes saved')
    },
    onError: (e) => toast.error(e.message),
  })
  const remove = useMutation({
    mutationFn: () => api.del(`/deployments/${name}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['deployments'] })
      toast.success(`Deleted ${name}`)
      navigate('/')
    },
    onError: (e) => toast.error(e.message),
  })

  const action = async (a: string) => {
    if (changed.length) await save.mutateAsync()
    run.mutate({ path: `/deployments/${name}/${a}` })
    if (a === 'deploy' || a === 'rebuild') setTab('deployments')
  }

  const shell = (body: React.ReactNode) => (
    <ServicePanel icon={<Box />} title={name} subtitle="Deployment" tabs={TABS.map((id) => ({ id, label: id[0].toUpperCase() + id.slice(1) }))} tab={tab} onTabChange={setTab}>
      {body}
    </ServicePanel>
  )
  if (isLoading) return shell(<Loading />)
  if (!data || !config) return shell(<ErrorAlert error={error ?? 'Deployment not found'} />)

  const deployed = data.status !== 'not_deployed'
  const git = data.source === 'git'
  const promoted = data.source === 'promote'
  const upstream = deployments?.find((x) => x.id === data.upstream_id)
  // Git and promote deployments set their image from each deploy, so only image deployments can drift.
  // A rollback runs an exact image ID (sha256:…), which is expected to differ from the tag.
  const runningImage = data.container?.Config.Image ?? ''
  const drift = data.source === 'image' && !!data.container && !runningImage.startsWith('sha256:') && runningImage !== data.image
  const dot = (fields: string[]) => (fields.some((f) => changed.includes(f)) ? ' •' : '')

  return (
    <ServicePanel
      icon={git ? <GithubIcon /> : promoted ? <ChevronsUp /> : <Box />}
      title={data.name}
      subtitle={
        <>
          <Status status={data.status} />
          {promoted ? (
            <span className="flex min-w-0 items-center gap-1.5 text-xs">
              <span>from</span>
              {upstream ? (
                <Link to={`/deployments/${upstream.name}`} className="truncate font-medium text-foreground/90 hover:underline">
                  {upstream.name}
                </Link>
              ) : (
                <span className="text-warning">missing upstream</span>
              )}
              {data.last_commit ? (
                <span className="font-mono text-brand">{data.last_commit.slice(0, 7)}</span>
              ) : (
                data.image && <span className="truncate font-mono">{shortArtifact(data.image)}</span>
              )}
            </span>
          ) : git ? (
            <span className="flex min-w-0 items-center gap-1.5 text-xs">
              <span className="truncate font-medium text-foreground/90">{repoLabel(data.git_url)}</span>
              <GitBranch className="size-3 shrink-0" />
              <span className="font-mono">{data.git_branch}</span>
              {data.last_commit && <span className="font-mono text-brand">{data.last_commit.slice(0, 7)}</span>}
            </span>
          ) : (
            <span className="font-mono text-xs">{data.image}</span>
          )}
          <span>Updated {timeAgo(data.updated_at)}</span>
        </>
      }
      tabs={[
        { id: 'deployments', label: 'Deployments' },
        { id: 'logs', label: 'Logs' },
        { id: 'terminal', label: 'Terminal' },
        { id: 'variables', label: `Variables${dot(['env'])}` },
        { id: 'settings', label: `Settings${dot([...SETTINGS_FIELDS, 'git_token'])}` },
        { id: 'container', label: 'Container' },
      ]}
      tab={tab}
      onTabChange={setTab}
      actions={
        <>
          <Button size="sm" onClick={() => action('deploy')} disabled={run.isPending || save.isPending} title={promoted ? `Promote ${upstream?.name ?? 'the upstream'}'s current deploy` : undefined}>
            {promoted ? <ChevronsUp /> : <Play />} {promoted ? 'Promote' : deployed ? 'Redeploy' : 'Deploy'}
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="icon-sm" aria-label="More actions">
                <MoreHorizontal />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
              {git && (
                <DropdownMenuItem onSelect={() => action('rebuild')} title="Build the branch again even if its commit was built before, checking for newer base images">
                  <Hammer /> Rebuild
                </DropdownMenuItem>
              )}
              {data.source === 'image' && (
                <DropdownMenuItem onSelect={() => action('pull')}>
                  <ArrowDownToLine /> Pull image
                </DropdownMenuItem>
              )}
              <DropdownMenuItem onSelect={() => setNewEnv(true)}>
                <CopyPlus /> New environment…
              </DropdownMenuItem>
              {deployed && (
                <>
                  {data.status === 'running' ? (
                    <>
                      <DropdownMenuItem onSelect={() => action('restart')}>
                        <RotateCw /> Restart
                      </DropdownMenuItem>
                      <DropdownMenuItem onSelect={() => action('stop')}>
                        <Square /> Stop
                      </DropdownMenuItem>
                    </>
                  ) : (
                    <DropdownMenuItem onSelect={() => action('start')}>
                      <Power /> Start
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuSeparator />
                  <DropdownMenuItem variant="destructive" onSelect={() => setConfirm('destroy')}>
                    <Trash2 /> Remove container
                  </DropdownMenuItem>
                </>
              )}
              {!deployed && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem variant="destructive" onSelect={() => setConfirm('delete')}>
                    <Trash2 /> Delete deployment
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </>
      }
      footer={<ChangesBar count={changed.length} saving={save.isPending} onDiscard={() => setDraft({})} onSave={() => save.mutate()} onDeploy={() => action('deploy')} />}
    >
      {data.adopted_container && (
        <div className="mb-4 flex gap-2 rounded-lg border border-brand/30 bg-brand/10 px-3 py-2 text-sm">
          <Info className="mt-0.5 size-4 shrink-0 text-brand" />
          <span>
            Imported from the container <code className="font-mono text-xs">{data.adopted_container}</code>, which is still running unchanged. The next deploy replaces it with
            a container Harbor manages{data.adopted_container !== data.name ? <> named <code className="font-mono text-xs">{data.name}</code></> : null}.
          </span>
        </div>
      )}
      {drift && (
        <div className="mb-4 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-sm text-warning">
          Running <code className="font-mono text-xs">{data.container!.Config.Image}</code>. Redeploy to apply the saved image.
        </div>
      )}

      {tab === 'deployments' && (
        <>
          {promoted && <PromotePanel deployment={data} />}
          <DeploymentHistory targetType="deployment" targetName={name} />
        </>
      )}

      {tab === 'logs' &&
        (data.container ? (
          <LogViewer containerId={data.container.Id} className="h-[calc(100vh-15rem)] min-h-96" />
        ) : (
          <EmptyState icon={<Box />} title="Not deployed" action={<Button onClick={() => action('deploy')}>Deploy now</Button>}>
            Deploy to start a container and stream its logs.
          </EmptyState>
        ))}

      {tab === 'terminal' &&
        (data.container ? (
          <Terminal containerId={data.container.Id} running={data.container.State.Running} className="h-[calc(100vh-15rem)] min-h-96" />
        ) : (
          <EmptyState icon={<Box />} title="Not deployed" action={<Button onClick={() => action('deploy')}>Deploy now</Button>}>
            Deploy to start a container you can open a terminal in.
          </EmptyState>
        ))}

      {tab === 'variables' && <VariablesEditor value={config.env} onChange={set('env')} description="Passed to the container as environment variables." />}

      {tab === 'settings' && (
        <div className="space-y-5">
          <SourceSettings key={data.updated_at} config={config} set={setSource} hasToken={data.has_token} token={token} onTokenChange={setToken} selfId={data.id} />
          {config.source === 'git' && (
            <AutoDeploySettings
              webhookPath={`/api/webhooks/github/${data.name}`}
              repo={config.git_url}
              branch={config.git_branch}
              enabled={config.auto_deploy}
              onEnabledChange={set('auto_deploy')}
              secret={data.webhook_secret}
            />
          )}
          {config.source === 'promote' && (
            <AutoPromoteSettings
              upstream={deployments?.find((x) => x.id === config.upstream_id)?.name ?? ''}
              enabled={config.auto_deploy}
              onEnabledChange={set('auto_deploy')}
            />
          )}
          <SettingsSection title="Networking" description="Publish container ports on this host. Taken ports are flagged as you type.">
            <div className="space-y-4">
              <PortsEditor value={config.ports} onChange={set('ports')} owner={`deployment:${data.name}`} image={data.image} />
              <Field label="Network" hint="Empty uses the default bridge network.">
                <Input value={config.network} onChange={(e) => set('network')(e.target.value)} placeholder="bridge" className="font-mono sm:w-72" />
              </Field>
            </div>
          </SettingsSection>
          <SettingsSection title="Labels" description="Container labels, e.g. Traefik routing rules. Applied on the next deploy.">
            <VariablesEditor value={config.labels} onChange={set('labels')} secret={false} keyPlaceholder="traefik.enable" noun="label" />
          </SettingsSection>
          <SettingsSection title="Volumes" description="Mount host paths or named volumes into the container.">
            <Textarea value={config.volumes} onChange={(e) => set('volumes')(e.target.value)} rows={3} placeholder={'app-data:/data\n/srv/config:/config:ro'} className="font-mono text-[12.5px]" />
          </SettingsSection>
          <SettingsSection title="Deploy" description="How the container runs.">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Restart policy">
                <Select value={config.restart} onValueChange={set('restart')}>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {['unless-stopped', 'always', 'on-failure', 'no'].map((r) => (
                      <SelectItem key={r} value={r}>
                        {r}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field label="Start command" hint="Overrides the image's default command.">
                <Input value={config.command} onChange={(e) => set('command')(e.target.value)} placeholder="(image default)" className="font-mono" />
              </Field>
            </div>
          </SettingsSection>
          <SettingsSection title="Danger zone" description="Remove the container first, then the deployment can be deleted." danger>
            <div className="flex flex-wrap gap-2">
              <Button variant="destructive" size="sm" disabled={!deployed} onClick={() => setConfirm('destroy')}>
                <Trash2 /> Remove container
              </Button>
              <Button variant="destructive" size="sm" disabled={deployed} onClick={() => setConfirm('delete')}>
                <Trash2 /> Delete deployment
              </Button>
            </div>
          </SettingsSection>
        </div>
      )}

      {tab === 'container' &&
        (data.container ? (
          <div className="space-y-3">
            <ContainerDetails c={data.container} />
            <Button variant="outline" size="sm" asChild>
              <Link to={`/containers/${data.container.Id}`}>Open in containers</Link>
            </Button>
          </div>
        ) : (
          <EmptyState icon={<Box />} title="No container">This deployment hasn't been deployed yet.</EmptyState>
        ))}

      {newEnv && <CreateEnvironmentDialog source={data} open={newEnv} onOpenChange={setNewEnv} />}
      <Confirm
        open={confirm === 'destroy'}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={`Remove ${name}'s container?`}
        description="The container is stopped and removed. Its configuration stays, so you can deploy it again."
        confirmLabel="Remove container"
        onConfirm={() => action('destroy')}
      />
      <Confirm
        open={confirm === 'delete'}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={`Delete ${name}?`}
        description="The deployment's configuration is deleted from Harbor. This can't be undone."
        confirmLabel="Delete deployment"
        onConfirm={() => remove.mutate()}
      />
    </ServicePanel>
  )
}

function pick(d: Deployment): Config {
  return Object.fromEntries(FIELDS.map((f) => [f, d[f]])) as Config
}
