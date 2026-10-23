import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArchiveRestore, CalendarClock, ChevronDown, Cloud, DatabaseBackup, ExternalLink, FolderOpen, Pencil, Play, Plug, Plus, Server, Trash2 } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { Link, useSearchParams } from 'react-router'
import { toast } from 'sonner'
import { api, type Backup, type BackupDestination, type BackupDestinationKind, type BackupJob, type SchedulePreview } from '@/api'
import { Confirm } from '@/components/app/confirm'
import { EmptyState, ErrorAlert, Loading, Surface } from '@/components/app/page'
import { UpdateStatus } from '@/components/app/status'
import { useOpenUpdate, useRunAction } from '@/components/app/updates'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { bytes, timeAgo } from '@/lib/format'
import { cn } from '@/lib/utils'

const KINDS: { kind: BackupDestinationKind; label: string; icon: ReactNode; blurb: string }[] = [
  { kind: 'gdrive', label: 'Google Drive', icon: <Cloud />, blurb: 'Upload to a folder in your Google Drive.' },
  { kind: 'local', label: 'Local folder', icon: <FolderOpen />, blurb: "A folder on Harbor's filesystem, e.g. a mounted disk." },
  { kind: 'rclone', label: 'rclone remote', icon: <Server />, blurb: 'S3, Backblaze B2, Dropbox, OneDrive, SFTP and more.' },
]

const kindMeta = (kind: BackupDestinationKind | null) => KINDS.find((k) => k.kind === kind)

const CALLBACK_PATH = '/api/backups/destinations/google/callback'
/** Google only redirects to https URLs, or plain http on localhost. */
const canRedirectBack = () => location.protocol === 'https:' || ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)

export function useBackupDestinations() {
  return useQuery({ queryKey: ['backup-destinations'], queryFn: () => api.get<BackupDestination[]>('/backups/destinations') })
}

function destinationSummary(d: BackupDestination): ReactNode {
  if (d.kind === 'gdrive')
    return d.connected ? (
      <>
        Google Drive · {d.account || 'connected'} · “{d.folder_name}”
      </>
    ) : (
      <span className="text-warning">Google Drive · not connected yet</span>
    )
  if (d.kind === 'local') return <span className="font-mono">{d.path}</span>
  return <span className="font-mono">{d.remote}</span>
}

// ---- Settings: destinations ---------------------------------------------------

export function BackupDestinationsSection() {
  const qc = useQueryClient()
  const { data, isLoading, error } = useBackupDestinations()
  const [editing, setEditing] = useState<BackupDestination | 'new' | null>(null)
  const [connecting, setConnecting] = useState<BackupDestination | null>(null)
  const [deleting, setDeleting] = useState<BackupDestination | null>(null)
  const [params, setParams] = useSearchParams()

  // Back from Google's consent screen.
  useEffect(() => {
    const connected = params.get('backup_connected')
    const failed = params.get('backup_error')
    if (!connected && !failed) return
    if (connected) toast.success('Google Drive connected')
    if (failed) toast.error(failed)
    qc.invalidateQueries({ queryKey: ['backup-destinations'] })
    setParams(
      (p) => {
        p.delete('backup_connected')
        p.delete('backup_error')
        return p
      },
      { replace: true },
    )
    document.getElementById('backups')?.scrollIntoView()
  }, [params, setParams, qc])

  const test = useMutation({
    mutationFn: (id: number) => api.post<{ message: string }>(`/backups/destinations/${id}/test`),
    onSuccess: (r) => toast.success(r.message),
    onError: (e) => toast.error(e.message),
  })
  const remove = useMutation({
    mutationFn: (id: number) => api.del(`/backups/destinations/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['backup-destinations'] })
      qc.invalidateQueries({ queryKey: ['backup-jobs'] })
      toast.success('Destination removed')
    },
    onError: (e) => toast.error(e.message),
  })

  return (
    <section id="backups" className="mt-10 scroll-mt-20">
      <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="font-semibold">Backup destinations</h2>
          <p className="mt-0.5 text-sm text-muted-foreground">Where volume backups are uploaded. Schedule backups from a volume's Backups tab.</p>
        </div>
        <Button size="sm" onClick={() => setEditing('new')}>
          <Plus /> Add destination
        </Button>
      </div>
      <ErrorAlert error={error} className="mb-3" />
      <Surface>
        {isLoading ? (
          <Loading />
        ) : !data?.length ? (
          <EmptyState icon={<DatabaseBackup />} title="No backup destinations" action={<Button onClick={() => setEditing('new')}>Add a destination</Button>}>
            Add Google Drive, a local folder or an rclone remote, then schedule backups of your volumes.
          </EmptyState>
        ) : (
          <div className="divide-y">
            {data.map((d) => (
              <div key={d.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <div className="flex size-9 items-center justify-center rounded-lg border bg-muted/60 [&_svg]:size-4">{kindMeta(d.kind)?.icon}</div>
                <div className="min-w-0 flex-1">
                  <div className="font-medium">{d.name}</div>
                  <div className="truncate text-xs text-muted-foreground">{destinationSummary(d)}</div>
                </div>
                {d.kind === 'gdrive' && (
                  <Button variant={d.connected ? 'ghost' : 'default'} size="sm" onClick={() => setConnecting(d)}>
                    <Plug /> {d.connected ? 'Reconnect' : 'Connect'}
                  </Button>
                )}
                <Button variant="outline" size="sm" disabled={!d.connected || (test.isPending && test.variables === d.id)} onClick={() => test.mutate(d.id)}>
                  {test.isPending && test.variables === d.id ? 'Testing…' : 'Test'}
                </Button>
                <Button variant="ghost" size="icon-sm" onClick={() => setEditing(d)} aria-label={`Edit ${d.name}`}>
                  <Pencil />
                </Button>
                <Button variant="ghost" size="icon-sm" className="text-muted-foreground hover:text-destructive" onClick={() => setDeleting(d)} aria-label={`Remove ${d.name}`}>
                  <Trash2 />
                </Button>
              </div>
            ))}
          </div>
        )}
      </Surface>
      <Dialog open={editing !== null} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent className="gap-0 p-0 sm:max-w-lg">
          {editing !== null && (
            <DestinationForm
              key={editing === 'new' ? 'new' : editing.id}
              destination={editing === 'new' ? null : editing}
              onClose={() => setEditing(null)}
              onCreated={(d) => d.kind === 'gdrive' && setConnecting(d)}
            />
          )}
        </DialogContent>
      </Dialog>
      <Dialog open={connecting !== null} onOpenChange={(o) => !o && setConnecting(null)}>
        <DialogContent className="gap-0 p-0 sm:max-w-lg">{connecting && <GoogleConnect key={connecting.id} destination={connecting} onClose={() => setConnecting(null)} />}</DialogContent>
      </Dialog>
      <Confirm
        open={deleting !== null}
        onOpenChange={(o) => !o && setDeleting(null)}
        title={`Remove ${deleting?.name}?`}
        description="Backup schedules that use it are deleted too. Backups already uploaded stay where they are, but Harbor can't restore them anymore."
        confirmLabel="Remove destination"
        onConfirm={() => deleting && remove.mutate(deleting.id)}
      />
    </section>
  )
}

function Field({ id, label, hint, children }: { id: string; label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  )
}

function DestinationForm({ destination, onClose, onCreated }: { destination: BackupDestination | null; onClose: () => void; onCreated: (d: BackupDestination) => void }) {
  const qc = useQueryClient()
  const [kind, setKind] = useState<BackupDestinationKind>(destination?.kind ?? 'gdrive')
  const [name, setName] = useState(destination?.name ?? '')
  const [path, setPath] = useState(destination?.path ?? '/var/lib/harbor/backups')
  const [clientId, setClientId] = useState(destination?.client_id ?? '')
  const [clientSecret, setClientSecret] = useState('')
  const [folder, setFolder] = useState(destination?.folder_name ?? 'Harbor backups')
  const [remote, setRemote] = useState(destination?.remote ?? '')
  const [rcloneConfig, setRcloneConfig] = useState('')
  const save = useMutation({
    mutationFn: () => {
      const body = {
        kind,
        name: name || kindMeta(kind)?.label,
        path,
        client_id: clientId,
        client_secret: clientSecret || undefined,
        folder_name: folder,
        remote,
        rclone_config: rcloneConfig || undefined,
      }
      return destination ? api.put<BackupDestination>(`/backups/destinations/${destination.id}`, body) : api.post<BackupDestination>('/backups/destinations', body)
    },
    onSuccess: (d) => {
      qc.invalidateQueries({ queryKey: ['backup-destinations'] })
      toast.success(destination ? 'Destination updated' : 'Destination added')
      onClose()
      if (!destination || !d.connected) onCreated(d)
    },
  })

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        save.mutate()
      }}
    >
      <DialogHeader className="border-b px-5 py-4">
        <DialogTitle>{destination ? `Edit ${destination.name}` : 'Add backup destination'}</DialogTitle>
        <DialogDescription>{kindMeta(kind)?.blurb}</DialogDescription>
      </DialogHeader>
      <div className="scrollbar-thin max-h-[70vh] space-y-4 overflow-y-auto px-5 py-4">
        {!destination && (
          <div className="grid grid-cols-3 gap-2">
            {KINDS.map((k) => (
              <button
                key={k.kind}
                type="button"
                onClick={() => setKind(k.kind)}
                className={cn(
                  'flex flex-col items-center gap-1.5 rounded-lg border px-2 py-3 text-xs font-medium transition-colors [&_svg]:size-5',
                  kind === k.kind ? 'border-brand bg-brand/10 text-foreground' : 'text-muted-foreground hover:bg-accent/50',
                )}
              >
                {k.icon}
                {k.label}
              </button>
            ))}
          </div>
        )}
        <Field id="dest-name" label="Name">
          <Input id="dest-name" value={name} onChange={(e) => setName(e.target.value)} placeholder={kindMeta(kind)?.label} />
        </Field>

        {kind === 'local' && (
          <Field
            id="dest-path"
            label="Folder"
            hint="An absolute path as Harbor sees it. When Harbor runs in Docker, use a folder under its data directory or one you mount into its container."
          >
            <Input id="dest-path" value={path} onChange={(e) => setPath(e.target.value)} className="font-mono" required />
          </Field>
        )}

        {kind === 'gdrive' && (
          <>
            <GoogleSetupSteps />
            <Field id="dest-client" label="OAuth client ID">
              <Input id="dest-client" value={clientId} onChange={(e) => setClientId(e.target.value)} placeholder="1234-abc.apps.googleusercontent.com" className="font-mono" required />
            </Field>
            <Field id="dest-secret" label="OAuth client secret" hint="Stored on the server and never shown again.">
              <Input
                id="dest-secret"
                type="password"
                autoComplete="off"
                value={clientSecret}
                onChange={(e) => setClientSecret(e.target.value)}
                placeholder={destination?.has_client_secret ? 'Leave empty to keep the saved secret' : 'GOCSPX-…'}
                className="font-mono"
                required={!destination?.has_client_secret}
              />
            </Field>
            <Field id="dest-folder" label="Drive folder" hint="Created in the root of your Drive if it doesn't exist.">
              <Input id="dest-folder" value={folder} onChange={(e) => setFolder(e.target.value)} />
            </Field>
          </>
        )}

        {kind === 'rclone' && (
          <>
            <Field
              id="dest-rclone"
              label="rclone config"
              hint={
                <>
                  One or more remotes in rclone.conf format, e.g. the output of <code className="font-mono">rclone config show myremote</code>.{' '}
                  {destination?.has_rclone_config && 'Leave empty to keep the saved config.'}
                </>
              }
            >
              <Textarea
                id="dest-rclone"
                value={rcloneConfig}
                onChange={(e) => setRcloneConfig(e.target.value)}
                rows={7}
                className="font-mono text-xs"
                placeholder={'[b2]\ntype = b2\naccount = …\nkey = …'}
                required={!destination?.has_rclone_config}
              />
            </Field>
            <Field id="dest-remote" label="Remote path" hint="Backups go here: the remote's name from the config, a colon, then a bucket or folder.">
              <Input id="dest-remote" value={remote} onChange={(e) => setRemote(e.target.value)} placeholder="b2:my-bucket/harbor" className="font-mono" required />
            </Field>
          </>
        )}
        <ErrorAlert error={save.error} />
      </div>
      <div className="flex justify-end gap-2 border-t bg-muted/30 px-5 py-3">
        <Button type="button" variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" disabled={save.isPending}>
          {destination ? 'Save' : kind === 'gdrive' ? 'Add and connect' : 'Add destination'}
        </Button>
      </div>
    </form>
  )
}

function GoogleSetupSteps() {
  const redirect = `${location.origin}${CALLBACK_PATH}`
  return (
    <details className="rounded-lg border bg-muted/30 px-3 py-2 text-xs text-muted-foreground [&_a]:text-brand [&_a]:hover:underline">
      <summary className="cursor-pointer font-medium text-foreground">How to get a client ID (one-time, about 5 minutes)</summary>
      <ol className="mt-2 list-decimal space-y-1.5 pl-4">
        <li>
          In the{' '}
          <a href="https://console.cloud.google.com/projectcreate" target="_blank" rel="noreferrer">
            Google Cloud console
          </a>
          , create a project and{' '}
          <a href="https://console.cloud.google.com/apis/library/drive.googleapis.com" target="_blank" rel="noreferrer">
            enable the Google Drive API
          </a>
          .
        </li>
        <li>
          Set up the{' '}
          <a href="https://console.cloud.google.com/auth/branding" target="_blank" rel="noreferrer">
            OAuth consent screen
          </a>{' '}
          (External), then under <em>Audience</em> click <em>Publish app</em>. While it's in testing, Google expires the connection after 7 days. Harbor only asks for
          access to files it creates, so publishing needs no review.
        </li>
        <li>
          Under{' '}
          <a href="https://console.cloud.google.com/auth/clients" target="_blank" rel="noreferrer">
            Clients
          </a>
          , create a client.{' '}
          {canRedirectBack() ? (
            <>
              Choose <em>Web application</em> and add this authorized redirect URI:
              <code className="mt-1 block rounded bg-background px-2 py-1 font-mono break-all text-foreground select-all">{redirect}</code>
            </>
          ) : (
            <>
              Choose <em>Desktop app</em>. (Google only redirects to https addresses, so you'll paste the address you land on after signing in. With Harbor behind https,
              a <em>Web application</em> client can redirect back automatically.)
            </>
          )}
        </li>
        <li>Copy the client ID and secret here.</li>
      </ol>
    </details>
  )
}

function GoogleConnect({ destination, onClose }: { destination: BackupDestination; onClose: () => void }) {
  const qc = useQueryClient()
  const [mode, setMode] = useState<'redirect' | 'paste'>(canRedirectBack() ? 'redirect' : 'paste')
  const [started, setStarted] = useState(false)
  const [pasted, setPasted] = useState('')
  const authorize = useMutation({
    mutationFn: () =>
      api.post<{ url: string }>(`/backups/destinations/${destination.id}/google/authorize`, {
        redirect_uri: mode === 'redirect' ? `${location.origin}${CALLBACK_PATH}` : 'http://localhost',
      }),
    onSuccess: ({ url }) => {
      if (mode === 'redirect') {
        location.href = url
      } else {
        window.open(url, '_blank', 'noopener')
        setStarted(true)
      }
    },
  })
  const finish = useMutation({
    mutationFn: () => api.post<BackupDestination>(`/backups/destinations/${destination.id}/google/code`, { code: pasted }),
    onSuccess: (d) => {
      qc.invalidateQueries({ queryKey: ['backup-destinations'] })
      toast.success(`Connected to Google Drive${d.account ? ` as ${d.account}` : ''}`)
      onClose()
    },
  })

  return (
    <div>
      <DialogHeader className="border-b px-5 py-4">
        <DialogTitle>Connect {destination.name} to Google Drive</DialogTitle>
        <DialogDescription>Sign in with the Google account whose Drive should hold the backups. Harbor can only see the files it uploads.</DialogDescription>
      </DialogHeader>
      <div className="space-y-4 px-5 py-4 text-sm">
        <div className="grid grid-cols-2 gap-2">
          {(
            [
              ['redirect', 'Web application client', 'Google sends you back to Harbor. Needs https (or localhost).'],
              ['paste', 'Desktop app client', 'You paste the address Google sends you to.'],
            ] as const
          ).map(([m, title, text]) => (
            <button
              key={m}
              type="button"
              onClick={() => (setMode(m), setStarted(false))}
              className={cn('rounded-lg border px-3 py-2 text-left transition-colors', mode === m ? 'border-brand bg-brand/10' : 'hover:bg-accent/50')}
            >
              <div className="text-xs font-medium">{title}</div>
              <div className="mt-0.5 text-xs text-muted-foreground">{text}</div>
            </button>
          ))}
        </div>
        {mode === 'paste' && started && (
          <Field
            id="google-code"
            label="Address you landed on"
            hint="After you allow access, Google opens http://localhost/?…&code=… which won't load. Copy that whole address from the address bar and paste it here."
          >
            <Input id="google-code" value={pasted} onChange={(e) => setPasted(e.target.value)} placeholder="http://localhost/?state=…&code=…" className="font-mono" autoFocus />
          </Field>
        )}
        <ErrorAlert error={authorize.error ?? finish.error} />
      </div>
      <div className="flex justify-end gap-2 border-t bg-muted/30 px-5 py-3">
        <Button type="button" variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        {mode === 'paste' && started ? (
          <Button onClick={() => finish.mutate()} disabled={!pasted.trim() || finish.isPending}>
            Connect
          </Button>
        ) : (
          <Button onClick={() => authorize.mutate()} disabled={authorize.isPending}>
            <ExternalLink /> Sign in with Google
          </Button>
        )}
      </div>
    </div>
  )
}

// ---- Volume panel: schedules and backups -----------------------------------

const PRESETS = [
  { label: 'Every hour', cron: '0 * * * *' },
  { label: 'Every 6 hours', cron: '0 */6 * * *' },
  { label: 'Daily at 03:00', cron: '0 3 * * *' },
  { label: 'Weekly, Sunday at 03:00', cron: '0 3 * * 0' },
  { label: 'Monthly, on the 1st at 03:00', cron: '0 3 1 * *' },
]

const scheduleLabel = (cron: string) => PRESETS.find((p) => p.cron === cron)?.label ?? cron

export function VolumeBackups({ volume }: { volume: string }) {
  const qc = useQueryClient()
  const run = useRunAction()
  const openUpdate = useOpenUpdate()
  const destinations = useBackupDestinations()
  const jobs = useQuery({
    queryKey: ['backup-jobs', volume],
    queryFn: () => api.get<BackupJob[]>(`/backups/jobs?${new URLSearchParams({ volume })}`),
    refetchInterval: 5000,
  })
  const backups = useQuery({
    queryKey: ['backups', volume],
    queryFn: () => api.get<Backup[]>(`/backups?${new URLSearchParams({ volume })}`),
    refetchInterval: 5000,
  })
  const [editing, setEditing] = useState<BackupJob | 'new' | null>(null)
  const [deletingJob, setDeletingJob] = useState<BackupJob | null>(null)
  const [restoring, setRestoring] = useState<Backup | null>(null)
  const [deleting, setDeleting] = useState<Backup | null>(null)
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['backup-jobs'] })
    qc.invalidateQueries({ queryKey: ['backups', volume] })
  }
  const toggle = useMutation({
    mutationFn: (j: BackupJob) => api.put(`/backups/jobs/${j.id}`, { ...j, enabled: !j.enabled }),
    onSuccess: invalidate,
    onError: (e) => toast.error(e.message),
  })
  const removeJob = useMutation({
    mutationFn: (id: number) => api.del(`/backups/jobs/${id}`),
    onSuccess: () => (invalidate(), toast.success('Schedule deleted')),
    onError: (e) => toast.error(e.message),
  })
  const removeBackup = useMutation({
    mutationFn: (id: number) => api.del(`/backups/${id}`),
    onSuccess: () => (invalidate(), toast.success('Backup deleted')),
    onError: (e) => toast.error(e.message),
  })
  // Runs show in the action tray; refresh the lists once they're recorded.
  const backUp = (path: string, body?: unknown) => run.mutate({ path, body }, { onSuccess: invalidate })

  if (destinations.isLoading) return <Loading />
  const usable = (destinations.data ?? []).filter((d) => d.connected)
  if (!destinations.data?.length) {
    return (
      <Surface>
        <EmptyState
          icon={<DatabaseBackup />}
          title="No backup destinations yet"
          action={
            <Button asChild>
              <Link to="/settings#backups">Add one in Settings</Link>
            </Button>
          }
        >
          Back up this volume to Google Drive, a local folder or any rclone remote on a schedule.
        </EmptyState>
      </Surface>
    )
  }

  return (
    <div className="space-y-6">
      <section>
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="text-sm font-semibold">Schedules</h3>
            <p className="text-xs text-muted-foreground">Backups run automatically and older ones are deleted beyond the number kept.</p>
          </div>
          <div className="flex gap-2">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" disabled={!usable.length}>
                  Back up now <ChevronDown />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuLabel className="text-xs text-muted-foreground">One-off backup to…</DropdownMenuLabel>
                <DropdownMenuSeparator />
                {usable.map((d) => (
                  <DropdownMenuItem key={d.id} onSelect={() => backUp(`/backups/volumes/${encodeURIComponent(volume)}/run`, { destination_id: d.id })}>
                    {kindMeta(d.kind)?.icon} {d.name}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
            <Button size="sm" onClick={() => setEditing('new')} disabled={!usable.length}>
              <Plus /> Add schedule
            </Button>
          </div>
        </div>
        {!usable.length && <ErrorAlert error="None of your backup destinations is connected yet. Finish connecting one in Settings." className="mb-2" />}
        <ErrorAlert error={jobs.error} className="mb-2" />
        <Surface>
          {jobs.isLoading ? (
            <Loading />
          ) : !jobs.data?.length ? (
            <EmptyState icon={<CalendarClock />} title="No backup schedule">
              This volume isn't backed up automatically.
            </EmptyState>
          ) : (
            <div className="divide-y">
              {jobs.data.map((j) => (
                <div key={j.id} className={cn('flex flex-wrap items-center gap-3 px-4 py-3', !j.enabled && 'opacity-60')}>
                  <div className="flex size-9 items-center justify-center rounded-lg border bg-muted/60 [&_svg]:size-4">{kindMeta(j.destination_kind)?.icon}</div>
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium">
                      {scheduleLabel(j.schedule)} → {j.destination_name}
                    </div>
                    <div className="flex flex-wrap items-center gap-x-1 text-xs text-muted-foreground">
                      <span>{j.keep ? `keeps ${j.keep}` : 'keeps all'}</span>
                      {j.stop_containers && <span>· stops containers</span>}
                      {j.enabled && j.next_run_at && <span>· next {timeAgo(j.next_run_at)}</span>}
                      {j.last_status && j.last_update_id && (
                        <button className="flex items-center gap-1 hover:text-foreground" onClick={() => openUpdate(j.last_update_id!)}>
                          · last <UpdateStatus status={j.last_status} /> {j.last_run_at && timeAgo(j.last_run_at)}
                        </button>
                      )}
                    </div>
                  </div>
                  <Switch checked={j.enabled} onCheckedChange={() => toggle.mutate(j)} aria-label={j.enabled ? 'Pause schedule' : 'Resume schedule'} />
                  <Button variant="ghost" size="icon-sm" title="Run now" aria-label="Run now" onClick={() => backUp(`/backups/jobs/${j.id}/run`)}>
                    <Play />
                  </Button>
                  <Button variant="ghost" size="icon-sm" onClick={() => setEditing(j)} aria-label="Edit schedule">
                    <Pencil />
                  </Button>
                  <Button variant="ghost" size="icon-sm" className="text-muted-foreground hover:text-destructive" onClick={() => setDeletingJob(j)} aria-label="Delete schedule">
                    <Trash2 />
                  </Button>
                </div>
              ))}
            </div>
          )}
        </Surface>
      </section>

      <section>
        <h3 className="mb-2 text-sm font-semibold">Backups</h3>
        <ErrorAlert error={backups.error} className="mb-2" />
        <Surface>
          {backups.isLoading ? (
            <Loading />
          ) : !backups.data?.length ? (
            <EmptyState icon={<ArchiveRestore />} title="No backups yet">
              Backups of this volume appear here, ready to restore.
            </EmptyState>
          ) : (
            <div className="divide-y">
              {backups.data.map((b) => (
                <div key={b.id} className="flex flex-wrap items-center gap-3 px-4 py-2.5">
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-mono text-[13px]">{b.file_name}</div>
                    <div className="text-xs text-muted-foreground">
                      {timeAgo(b.created_at)} · {bytes(b.size)} · {b.destination_name ?? <span className="text-warning">destination removed</span>}
                      {!b.job_id && ' · one-off'}
                    </div>
                  </div>
                  <Button variant="outline" size="sm" disabled={!b.destination_id} onClick={() => setRestoring(b)}>
                    <ArchiveRestore /> Restore
                  </Button>
                  <Button variant="ghost" size="icon-sm" className="text-muted-foreground hover:text-destructive" onClick={() => setDeleting(b)} aria-label={`Delete ${b.file_name}`}>
                    <Trash2 />
                  </Button>
                </div>
              ))}
            </div>
          )}
        </Surface>
      </section>

      <Dialog open={editing !== null} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent className="gap-0 p-0 sm:max-w-md">
          {editing !== null && (
            <JobForm key={editing === 'new' ? 'new' : editing.id} volume={volume} job={editing === 'new' ? null : editing} destinations={usable} onClose={() => setEditing(null)} />
          )}
        </DialogContent>
      </Dialog>
      <Dialog open={restoring !== null} onOpenChange={(o) => !o && setRestoring(null)}>
        <DialogContent className="gap-0 p-0 sm:max-w-md">
          {restoring && (
            <RestoreForm
              backup={restoring}
              onClose={() => setRestoring(null)}
              onStart={(body) => {
                setRestoring(null)
                backUp(`/backups/${restoring.id}/restore`, body)
              }}
            />
          )}
        </DialogContent>
      </Dialog>
      <Confirm
        open={deletingJob !== null}
        onOpenChange={(o) => !o && setDeletingJob(null)}
        title="Delete this schedule?"
        description="No more backups run on it. Backups it already made are kept."
        confirmLabel="Delete schedule"
        onConfirm={() => deletingJob && removeJob.mutate(deletingJob.id)}
      />
      <Confirm
        open={deleting !== null}
        onOpenChange={(o) => !o && setDeleting(null)}
        title={`Delete ${deleting?.file_name}?`}
        description={deleting?.destination_name ? `The file is deleted from ${deleting.destination_name}. This can't be undone.` : 'Harbor forgets this backup.'}
        confirmLabel="Delete backup"
        onConfirm={() => deleting && removeBackup.mutate(deleting.id)}
      />
    </div>
  )
}

function JobForm({ volume, job, destinations, onClose }: { volume: string; job: BackupJob | null; destinations: BackupDestination[]; onClose: () => void }) {
  const qc = useQueryClient()
  const [destination, setDestination] = useState(String(job?.destination_id ?? destinations[0]?.id ?? ''))
  const [schedule, setSchedule] = useState(job?.schedule ?? '0 3 * * *')
  const [keep, setKeep] = useState(String(job?.keep ?? 7))
  const [stop, setStop] = useState(job?.stop_containers ?? false)
  const preview = useQuery({
    queryKey: ['backup-schedule', schedule.trim()],
    queryFn: () => api.get<SchedulePreview>(`/backups/schedule?${new URLSearchParams({ cron: schedule.trim() })}`),
    enabled: schedule.trim().length > 0,
    retry: false,
  })
  const save = useMutation({
    mutationFn: () => {
      const body = { volume, destination_id: Number(destination), schedule, keep: Number(keep), stop_containers: stop, enabled: job?.enabled ?? true }
      return job ? api.put<BackupJob>(`/backups/jobs/${job.id}`, body) : api.post<BackupJob>('/backups/jobs', body)
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['backup-jobs'] })
      toast.success(job ? 'Schedule updated' : 'Backups scheduled')
      onClose()
    },
  })
  const preset = PRESETS.find((p) => p.cron === schedule.trim())?.cron ?? 'custom'

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        save.mutate()
      }}
    >
      <DialogHeader className="border-b px-5 py-4">
        <DialogTitle>{job ? 'Edit backup schedule' : 'Schedule backups'}</DialogTitle>
        <DialogDescription>
          Back up <span className="font-mono">{volume}</span> as a .tar.gz archive.
        </DialogDescription>
      </DialogHeader>
      <div className="space-y-4 px-5 py-4">
        <Field id="job-dest" label="Destination">
          <Select value={destination} onValueChange={setDestination}>
            <SelectTrigger id="job-dest" className="w-full">
              <SelectValue placeholder="Choose a destination" />
            </SelectTrigger>
            <SelectContent>
              {destinations.map((d) => (
                <SelectItem key={d.id} value={String(d.id)}>
                  {d.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field
          id="job-cron"
          label="When"
          hint={
            preview.error ? (
              <span className="text-destructive">{preview.error.message}</span>
            ) : preview.data ? (
              <>
                {preview.data.description} Next: {preview.data.next[0] ? new Date(preview.data.next[0]).toLocaleString() : 'never'}. Server time zone: {preview.data.timezone}.
              </>
            ) : (
              'Cron format: minute hour day month weekday.'
            )
          }
        >
          <div className="flex gap-2">
            <Select value={preset} onValueChange={(v) => v !== 'custom' && setSchedule(v)}>
              <SelectTrigger className="w-52 shrink-0">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PRESETS.map((p) => (
                  <SelectItem key={p.cron} value={p.cron}>
                    {p.label}
                  </SelectItem>
                ))}
                <SelectItem value="custom">Custom</SelectItem>
              </SelectContent>
            </Select>
            <Input id="job-cron" value={schedule} onChange={(e) => setSchedule(e.target.value)} className="font-mono" required />
          </div>
        </Field>
        <Field id="job-keep" label="Backups to keep" hint="Older backups from this schedule are deleted after each run. 0 keeps all of them.">
          <Input id="job-keep" type="number" min={0} max={1000} value={keep} onChange={(e) => setKeep(e.target.value)} className="w-28" required />
        </Field>
        <label className="flex items-start gap-3 rounded-lg border px-3 py-2.5">
          <Switch checked={stop} onCheckedChange={setStop} className="mt-0.5" />
          <span>
            <span className="block text-sm font-medium">Stop containers while archiving</span>
            <span className="block text-xs text-muted-foreground">
              Recommended for databases: copying files while they're written can give an inconsistent backup. Containers using the volume are started again right after.
            </span>
          </span>
        </label>
        <ErrorAlert error={save.error} />
      </div>
      <div className="flex justify-end gap-2 border-t bg-muted/30 px-5 py-3">
        <Button type="button" variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" disabled={save.isPending || !destination}>
          {job ? 'Save' : 'Schedule'}
        </Button>
      </div>
    </form>
  )
}

function RestoreForm({ backup, onClose, onStart }: { backup: Backup; onClose: () => void; onStart: (body: { volume: string; stop_containers: boolean }) => void }) {
  const [volume, setVolume] = useState(backup.volume)
  const [stop, setStop] = useState(true)
  const inPlace = volume.trim() === backup.volume
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        onStart({ volume: volume.trim(), stop_containers: stop })
      }}
    >
      <DialogHeader className="border-b px-5 py-4">
        <DialogTitle>Restore backup</DialogTitle>
        <DialogDescription>
          <span className="font-mono">{backup.file_name}</span> from {backup.destination_name}, {timeAgo(backup.created_at)}.
        </DialogDescription>
      </DialogHeader>
      <div className="space-y-4 px-5 py-4">
        <Field id="restore-volume" label="Into volume" hint="Restore into a new volume to inspect a backup without touching the original. It's created if it doesn't exist.">
          <Input id="restore-volume" value={volume} onChange={(e) => setVolume(e.target.value)} className="font-mono" required />
        </Field>
        <label className="flex items-start gap-3 rounded-lg border px-3 py-2.5">
          <Switch checked={stop} onCheckedChange={setStop} className="mt-0.5" />
          <span>
            <span className="block text-sm font-medium">Stop containers while restoring</span>
            <span className="block text-xs text-muted-foreground">Containers using the volume are stopped, then started again once the files are in place.</span>
          </span>
        </label>
        {inPlace && (
          <ErrorAlert error={`Everything currently in ${backup.volume} is replaced with the backup's contents. The archive is checked first, so a damaged backup leaves the volume as it is.`} />
        )}
      </div>
      <div className="flex justify-end gap-2 border-t bg-muted/30 px-5 py-3">
        <Button type="button" variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" variant={inPlace ? 'destructive' : 'default'}>
          <ArchiveRestore /> {inPlace ? 'Replace and restore' : 'Restore'}
        </Button>
      </div>
    </form>
  )
}
