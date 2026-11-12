import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query'
import { AlertTriangle, ArrowLeft, Box, Layers, Loader2, PackageOpen, RefreshCw } from 'lucide-react'
import { createContext, useContext, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router'
import { api } from '@/api'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'
import { GithubIcon } from './GithubIcon'
import { ErrorAlert } from './page'

/** `repo` and `image` both create deployments, from different sources. */
type Kind = 'repo' | 'image' | 'stack'

const STACK_TEMPLATE = `services:
  app:
    image: nginx:alpine
    restart: unless-stopped
    ports:
      - "\${PORT:-8080}:80"
`

const CreateContext = createContext<(kind?: Kind) => void>(() => {})
export const useCreate = () => useContext(CreateContext)

export function CreateProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false)
  const [kind, setKind] = useState<Kind | null>(null)
  const openWith = (k?: Kind) => {
    setKind(k ?? null)
    setOpen(true)
  }
  return (
    <CreateContext.Provider value={openWith}>
      {children}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-md">
          {kind ? <CreateForm kind={kind} onBack={() => setKind(null)} onDone={() => setOpen(false)} /> : <KindPicker onPick={setKind} onImport={() => setOpen(false)} />}
        </DialogContent>
      </Dialog>
    </CreateContext.Provider>
  )
}

function KindPicker({ onPick, onImport }: { onPick: (k: Kind) => void; onImport: () => void }) {
  const navigate = useNavigate()
  const options = [
    { kind: 'repo' as const, icon: <GithubIcon className="size-4.5" />, title: 'GitHub repo', body: 'Build a Dockerfile from a repository and redeploy on push.' },
    { kind: 'image' as const, icon: <Box className="size-4.5" />, title: 'Docker image', body: 'Run a single container from a registry image.' },
    { kind: 'stack' as const, icon: <Layers className="size-4.5" />, title: 'Compose stack', body: 'A Docker Compose project with one or more services.' },
  ]
  return (
    <>
      <DialogHeader className="border-b px-5 py-4">
        <DialogTitle>What would you like to create?</DialogTitle>
        <DialogDescription>Services run on this server's Docker engine.</DialogDescription>
      </DialogHeader>
      <div className="space-y-1 p-2">
        {options.map((o) => (
          <button key={o.kind} onClick={() => onPick(o.kind)} className="flex w-full items-center gap-3 rounded-lg px-3 py-3 text-left transition-colors hover:bg-accent">
            <div className="flex size-9 items-center justify-center rounded-lg border bg-muted text-brand">
              {o.icon}
            </div>
            <div>
              <div className="text-sm font-medium">{o.title}</div>
              <div className="text-xs text-muted-foreground">{o.body}</div>
            </div>
          </button>
        ))}
        <button
          onClick={() => {
            onImport()
            navigate('/import')
          }}
          className="flex w-full items-center gap-3 rounded-lg border-t px-3 py-3 text-left transition-colors hover:bg-accent"
        >
          <div className="flex size-9 items-center justify-center rounded-lg border bg-muted text-brand">
            <PackageOpen className="size-4.5" />
          </div>
          <div>
            <div className="text-sm font-medium">Import existing containers</div>
            <div className="text-xs text-muted-foreground">Take over containers already running here, e.g. from Komodo.</div>
          </div>
        </button>
      </div>
    </>
  )
}

interface ComposeFiles {
  git_branch: string
  files: string[]
  main: string | null
  overrides: string[]
}

/** Deployment settings for one compose service, as the backend maps them. */
export interface ServiceSettings {
  service: string
  build: boolean
  build_context: string
  dockerfile: string
  build_args: string
  image: string
  ports: string
  env: string
  volumes: string
  network: string
  restart: string
  command: string
  labels: string
  devices: string
  group_add: string
  warnings: string[]
}

interface ComposeSettings {
  git_branch: string
  services: ServiceSettings[]
  warnings: string[]
}

const dirOf = (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '')

/** Files that can be layered on `main`, those in its folder first. */
export function overrideCandidates(files: string[], main: string) {
  const others = files.filter((f) => f !== main)
  const near = others.filter((f) => dirOf(f) === dirOf(main))
  return [...near, ...others.filter((f) => dirOf(f) !== dirOf(main))]
}

/** The service to prefill from by default: the first one the repo builds. */
export function defaultService(services: ServiceSettings[]) {
  return (services.find((s) => s.build) ?? services[0])?.service ?? ''
}

const nonEmpty = (s: string) => s.split('\n').filter((l) => l.trim() !== '')

/** One line per setting the service fills in, for the form's summary. */
export function summarize(s: ServiceSettings): [string, string][] {
  const rows: [string, string][] = []
  if (s.build) rows.push(['Build', [s.build_context === '.' ? '' : s.build_context, s.dockerfile].filter(Boolean).join('/')])
  else rows.push(['Image', s.image])
  const list = (label: string, value: string, noun?: string) => {
    const items = nonEmpty(value)
    if (items.length === 0) return
    rows.push([label, noun ? `${items.length} ${noun}${items.length === 1 ? '' : 's'}` : items.join(', ')])
  }
  list('Ports', s.ports)
  list('Devices', s.devices)
  list('Groups', s.group_add)
  list('Volumes', s.volumes)
  list('Variables', s.env, 'variable')
  list('Build args', s.build_args, 'arg')
  list('Labels', s.labels, 'label')
  if (s.network) rows.push(['Network', s.network])
  if (s.command) rows.push(['Command', s.command])
  rows.push(['Restart', s.restart])
  return rows
}

const titles: Record<Kind, string> = { repo: 'Deploy from GitHub', image: 'Deploy an image', stack: 'New stack' }
const descriptions: Record<Kind, string> = {
  repo: 'Harbor clones the branch, builds its Dockerfile and runs the image.',
  image: 'You can add ports, volumes and variables next.',
  stack: 'Starts from a sample compose file you can edit next.',
}

/** Suggests a service name from a repo like `acme/web-api` or a URL. */
function nameFromRepo(repo: string) {
  const last = repo.trim().replace(/\/$/, '').replace(/\.git$/, '').split(/[/:]/).pop() ?? ''
  return last.toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/^[-_]+/, '').slice(0, 63)
}

function CreateForm({ kind, onBack, onDone }: { kind: Kind; onBack: () => void; onDone: () => void }) {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const [name, setName] = useState('')
  const [nameTouched, setNameTouched] = useState(false)
  const [image, setImage] = useState('')
  const [repo, setRepo] = useState('')
  const [branch, setBranch] = useState('')
  const [fromCompose, setFromCompose] = useState(false)
  // The repo/branch last scanned for compose files; updated on blur, not per keystroke.
  const [scan, setScan] = useState({ repo: '', branch: '' })
  const prefill = kind === 'repo' && fromCompose
  const detected = useQuery({
    queryKey: ['compose-files', scan.repo, scan.branch],
    queryFn: () => api.post<ComposeFiles>('/git/compose-files', { git_url: scan.repo, git_branch: scan.branch }),
    enabled: prefill && scan.repo !== '',
    retry: false,
    staleTime: 60_000,
  })
  // The user's choices, tied to the scan they were made for so a rescan resets them.
  const scanKey = `${scan.repo}\n${scan.branch}`
  const [choice, setChoice] = useState<{ key: string; main: string; extra: string[] } | null>(null)
  const [serviceChoice, setServiceChoice] = useState<{ key: string; service: string } | null>(null)
  const found = detected.data
  const selected =
    choice && choice.key === scanKey ? choice : found?.main ? { key: scanKey, main: found.main, extra: found.overrides } : null
  const candidates = found && selected ? overrideCandidates(found.files, selected.main) : []
  // Files in the order compose merges them: the main one, then the ticked ones as listed.
  const files = selected ? [selected.main, ...candidates.filter((f) => selected.extra.includes(f))] : []
  const rescan = () => setScan({ repo: repo.trim(), branch: branch.trim() })
  // The fields changed since the last scan (e.g. Enter pressed without leaving them).
  const stale = prefill && (scan.repo !== repo.trim() || scan.branch !== branch.trim())

  // Named volumes are named after the deployment, as compose names them
  // after the project, so the name is part of the request.
  const settingsQuery = (forName: string) => ({
    queryKey: ['compose-settings', scan.repo, scan.branch, files.join('\n'), forName],
    queryFn: () =>
      api.post<ComposeSettings>('/git/compose-settings', { git_url: scan.repo, git_branch: scan.branch, files, name: forName }),
    retry: false,
    staleTime: 60_000,
  })
  const [settingsName, setSettingsName] = useState('')
  const settings = useQuery({ ...settingsQuery(settingsName), enabled: prefill && !stale && files.length > 0 })
  const services = settings.data?.services ?? []
  const service =
    services.find((s) => s.service === (serviceChoice?.key === scanKey ? serviceChoice.service : defaultService(services))) ?? null

  const path = kind === 'stack' ? 'stacks' : 'deployments'
  const create = useMutation({
    mutationFn: async () => {
      if (kind === 'stack') return api.post('/stacks', { name, compose: STACK_TEMPLATE, env: 'PORT=8080\n' })
      if (kind === 'image') return api.post('/deployments', { name, source: 'image', image, restart: 'unless-stopped' })
      if (!prefill || !service) return api.post('/deployments', { name, source: 'git', git_url: repo, git_branch: branch, restart: 'unless-stopped' })
      // Re-read with the final name if it changed since, for volume names.
      const fresh = name === settingsName ? settings.data! : await qc.fetchQuery(settingsQuery(name))
      const s = fresh.services.find((x) => x.service === service.service) ?? service
      const { service: _service, build, warnings: _warnings, ...rest } = s
      return api.post('/deployments', {
        ...rest,
        name,
        source: build ? 'git' : 'image',
        git_url: repo,
        git_branch: branch || fresh.git_branch,
      })
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [path] })
      onDone()
      navigate(`/${path}/${name}?tab=settings`)
    },
  })
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        if (stale) rescan()
        else create.mutate()
      }}
    >
      <DialogHeader className="border-b px-5 py-4">
        <DialogTitle className="flex items-center gap-2">
          <button type="button" onClick={onBack} className="-ml-1 rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground" aria-label="Back">
            <ArrowLeft className="size-4" />
          </button>
          {titles[kind]}
        </DialogTitle>
        <DialogDescription>{descriptions[kind]}</DialogDescription>
      </DialogHeader>
      <div className="max-h-[calc(100dvh-12rem)] space-y-4 overflow-y-auto px-5 py-4">
        {kind === 'repo' && (
          <>
            <div className="space-y-2">
              <Label htmlFor="create-repo">Repository</Label>
              <Input
                id="create-repo"
                value={repo}
                onChange={(e) => {
                  setRepo(e.target.value)
                  if (!nameTouched) setName(nameFromRepo(e.target.value))
                }}
                onBlur={() => fromCompose && rescan()}
                placeholder="owner/repo or https://…"
                className="font-mono"
                autoFocus
                required
              />
              <p className="text-xs text-muted-foreground">Private repositories use your git accounts from Settings.</p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="create-branch">Branch</Label>
              <Input
                id="create-branch"
                value={branch}
                onChange={(e) => setBranch(e.target.value)}
                onBlur={() => fromCompose && rescan()}
                placeholder="Default branch"
                className="font-mono"
              />
              <p className="text-xs text-muted-foreground">Leave empty to use the repository's default branch.</p>
            </div>
          </>
        )}
        <div className="space-y-2">
          <Label htmlFor="create-name">Service name</Label>
          <Input
            id="create-name"
            value={name}
            onChange={(e) => {
              setNameTouched(true)
              setName(e.target.value.toLowerCase())
            }}
            onBlur={() => setSettingsName(name)}
            placeholder={kind === 'stack' ? 'my-app' : 'my-service'}
            autoFocus={kind !== 'repo'}
            required
            pattern="[a-z0-9][a-z0-9_\-]*"
          />
          <p className="text-xs text-muted-foreground">Lowercase letters, digits, - and _.</p>
        </div>
        {kind === 'repo' && (
          <label className="flex cursor-pointer items-start justify-between gap-3 rounded-lg border px-3 py-2.5">
            <span>
              <span className="block text-sm font-medium">Prefill from a compose file</span>
              <span className="block text-xs text-muted-foreground">Take ports, variables, volumes, devices and build settings from the repo's docker-compose files.</span>
            </span>
            <Switch
              checked={fromCompose}
              onCheckedChange={(on) => {
                setFromCompose(on)
                if (on) {
                  rescan()
                  setSettingsName(name)
                }
              }}
            />
          </label>
        )}
        {prefill && (
          <ComposePrefill
            repo={scan.repo}
            stale={stale}
            detected={detected}
            selected={selected}
            candidates={candidates}
            onRescan={rescan}
            onMain={(main) => setChoice({ key: scanKey, main, extra: [] })}
            onToggle={(file, on) =>
              selected && setChoice({ ...selected, extra: on ? [...selected.extra, file] : selected.extra.filter((f) => f !== file) })
            }
            settings={settings}
            service={service}
            onService={(s) => setServiceChoice({ key: scanKey, service: s })}
          />
        )}
        {kind === 'image' && (
          <div className="space-y-2">
            <Label htmlFor="create-image">Image</Label>
            <Input id="create-image" value={image} onChange={(e) => setImage(e.target.value)} placeholder="nginx:alpine" className="font-mono" required />
          </div>
        )}
        <ErrorAlert error={create.error} />
      </div>
      <div className="flex justify-end gap-2 border-t bg-muted/30 px-5 py-3">
        <Button type="button" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" disabled={create.isPending || (prefill && !stale && !service)}>
          {stale ? 'Find compose files' : 'Create'}
        </Button>
      </div>
    </form>
  )
}

function Loading({ children }: { children: ReactNode }) {
  return (
    <p className="flex items-center gap-2 text-xs text-muted-foreground">
      <Loader2 className="size-3.5 animate-spin" /> {children}
    </p>
  )
}

function ComposePrefill({
  repo,
  stale,
  detected,
  selected,
  candidates,
  onRescan,
  onMain,
  onToggle,
  settings,
  service,
  onService,
}: {
  repo: string
  stale: boolean
  detected: UseQueryResult<ComposeFiles>
  selected: { main: string; extra: string[] } | null
  candidates: string[]
  onRescan: () => void
  onMain: (main: string) => void
  onToggle: (file: string, on: boolean) => void
  settings: UseQueryResult<ComposeSettings>
  service: ServiceSettings | null
  onService: (service: string) => void
}) {
  if (!repo) return <p className="text-xs text-muted-foreground">Enter a repository to find its compose files.</p>
  if (stale) return <p className="text-xs text-muted-foreground">The repository or branch changed; press Find compose files.</p>
  if (detected.isFetching) return <Loading>Looking for compose files…</Loading>
  if (detected.error)
    return (
      <div className="space-y-2">
        <ErrorAlert error={detected.error} />
        <Button type="button" variant="outline" size="sm" onClick={onRescan}>
          <RefreshCw /> Try again
        </Button>
      </div>
    )
  const found = detected.data
  if (!found) return null
  if (!selected)
    return (
      <p className="text-xs text-muted-foreground">
        No compose files in this branch.{' '}
        <button type="button" onClick={onRescan} className="underline underline-offset-2 hover:text-foreground">
          Look again
        </button>
      </p>
    )
  const services = settings.data?.services ?? []
  const warnings = [...(settings.data?.warnings ?? []), ...(service?.warnings ?? [])]
  return (
    <div className="space-y-3 rounded-lg border bg-muted/30 p-3">
      <div className="space-y-2">
        <Label htmlFor="create-compose">Compose file</Label>
        <Select value={selected.main} onValueChange={onMain}>
          <SelectTrigger id="create-compose" className="w-full font-mono">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {found.files.map((f) => (
              <SelectItem key={f} value={f} className="font-mono">
                {f}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {candidates.length > 0 && (
        <div className="space-y-2">
          <Label>Also apply</Label>
          <div className={cn('space-y-1.5', candidates.length > 5 && '-mx-3 max-h-36 overflow-y-auto px-3 py-1')}>
            {candidates.map((f) => (
              <label key={f} className="flex cursor-pointer items-center gap-2 text-sm">
                <Checkbox checked={selected.extra.includes(f)} onCheckedChange={(v) => onToggle(f, v === true)} />
                <span className="truncate font-mono text-xs">{f}</span>
              </label>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">Override files, like one that adds devices for hardware acceleration. Applied in this order.</p>
        </div>
      )}
      {settings.isFetching ? (
        <Loading>Reading the compose files…</Loading>
      ) : settings.error ? (
        <ErrorAlert error={settings.error} />
      ) : (
        service && (
          <>
            {services.length > 1 && (
              <div className="space-y-2">
                <Label htmlFor="create-service">Service</Label>
                <Select value={service.service} onValueChange={onService}>
                  <SelectTrigger id="create-service" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {services.map((s) => (
                      <SelectItem key={s.service} value={s.service}>
                        {s.service}
                        <span className="text-muted-foreground">{s.build ? ' · builds from the repo' : ` · ${s.image}`}</span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">A deployment runs one container. Deploy the other services separately.</p>
              </div>
            )}
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
              {summarize(service).map(([label, value]) => (
                <div key={label} className="contents">
                  <dt className="text-muted-foreground">{label}</dt>
                  <dd className="truncate font-mono" title={value}>
                    {value}
                  </dd>
                </div>
              ))}
            </dl>
            {warnings.length > 0 && (
              <ul className="space-y-1 text-xs text-warning">
                {warnings.map((w) => (
                  <li key={w} className="flex gap-1.5">
                    <AlertTriangle className="mt-0.5 size-3 shrink-0" />
                    <span>{w}</span>
                  </li>
                ))}
              </ul>
            )}
            <p className="text-xs text-muted-foreground">You can change all of this in Settings after creating.</p>
          </>
        )
      )}
    </div>
  )
}
