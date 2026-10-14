import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Box, GitBranch, Info, Layers, PackageOpen, TriangleAlert } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { Link, useNavigate } from 'react-router'
import { toast } from 'sonner'
import {
  api,
  ApiError,
  gitHost,
  repoLabel,
  type ContainerImportPreview,
  type Deployment,
  type ImportCandidates,
  type ImportContainerCandidate,
  type ImportStackCandidate,
  type Stack,
} from '@/api'
import { GithubIcon } from '@/components/app/GithubIcon'
import { ImportAllDialog } from '@/components/app/ImportAll'
import { EmptyState, ErrorAlert, Loading, Page, PageHeader, Surface } from '@/components/app/page'
import { StatusDot } from '@/components/app/status'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { useGitAccounts } from '@/pages/Settings'
import { cn } from '@/lib/utils'

export function useImportCandidates() {
  return useQuery({ queryKey: ['import'], queryFn: () => api.get<ImportCandidates>('/import'), refetchInterval: 15000 })
}

/** Candidates worth suggesting: everything except Komodo's and Harbor's own containers. */
export function importableCount(c?: ImportCandidates) {
  if (!c) return 0
  return c.stacks.filter((s) => !s.is_komodo && !s.is_harbor).length + c.containers.filter((x) => !x.is_komodo && !x.is_harbor).length
}

function Badge({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'warning' | 'brand' }) {
  return (
    <span
      className={cn(
        'inline-flex h-5 items-center rounded-md border px-1.5 text-[10px] font-semibold tracking-wider uppercase',
        tone === 'warning' && 'border-warning/30 bg-warning/10 text-warning',
        tone === 'brand' && 'border-brand/30 bg-brand/10 text-brand',
        tone === 'neutral' && 'bg-muted text-muted-foreground',
      )}
    >
      {children}
    </span>
  )
}

function NoRestartNote() {
  return (
    <div className="flex gap-2 rounded-lg border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
      <Info className="mt-0.5 size-3.5 shrink-0" />
      <span>Nothing restarts now. The containers keep running as they are until you deploy from Harbor, which recreates them with Harbor's settings.</span>
    </div>
  )
}

export function ImportPage() {
  const { data, isLoading, error } = useImportCandidates()
  const [stack, setStack] = useState<ImportStackCandidate | null>(null)
  const [container, setContainer] = useState<ImportContainerCandidate | null>(null)
  const [all, setAll] = useState(false)

  const stacks = data?.stacks ?? []
  const containers = data?.containers ?? []

  return (
    <Page className="max-w-4xl">
      <PageHeader
        title="Import"
        description="Containers on this server that Harbor doesn't manage yet, such as ones created by Komodo or by hand. Importing adds them to the canvas without restarting them."
        actions={
          data &&
          stacks.length + containers.length > 1 && (
            <Button onClick={() => setAll(true)}>
              <PackageOpen /> Import all
            </Button>
          )
        }
      />
      <ErrorAlert error={error} className="mb-4" />
      {isLoading ? (
        <Loading />
      ) : !stacks.length && !containers.length ? (
        <Surface>
          <EmptyState icon={<PackageOpen />} title="Everything is managed by Harbor">
            There are no other containers on this Docker engine.
          </EmptyState>
        </Surface>
      ) : (
        <div className="space-y-8">
          {stacks.length > 0 && (
            <section>
              <h2 className="mb-2 text-sm font-semibold">Compose projects</h2>
              <p className="mb-3 text-sm text-muted-foreground">Import as a stack. It keeps running from its current directory, so relative paths keep working.</p>
              <div className="space-y-2">
                {stacks.map((s) => (
                  <Surface key={s.project} className="p-4">
                    <div className="flex flex-wrap items-start gap-3">
                      <div className="flex size-9 items-center justify-center rounded-lg border bg-muted/60 text-brand">
                        <Layers className="size-4.5" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-semibold">{s.project}</span>
                          {s.is_komodo && <Badge tone="warning">Komodo itself</Badge>}
                          {s.is_harbor && <Badge tone="warning">Harbor itself</Badge>}
                          {s.git_url && (
                            <Badge tone="brand">
                              <GitBranch className="mr-1 size-3" /> git
                            </Badge>
                          )}
                        </div>
                        <div className="mt-0.5 truncate font-mono text-xs text-muted-foreground" title={s.working_dir}>
                          {s.working_dir || 'unknown directory'}
                        </div>
                        <div className="mt-2 flex flex-wrap gap-1.5">
                          {s.containers.map((c) => (
                            <span key={c.name} className="inline-flex items-center gap-1.5 rounded-md border bg-muted/50 px-1.5 py-0.5 text-xs">
                              <StatusDot status={c.state} className="size-1.5" />
                              {c.service ?? c.name}
                            </span>
                          ))}
                        </div>
                      </div>
                      <Button size="sm" variant={s.is_komodo ? 'outline' : 'default'} disabled={!s.name_ok || s.is_harbor} onClick={() => setStack(s)}>
                        Import
                      </Button>
                    </div>
                    {s.is_harbor && <p className="mt-2 text-xs text-muted-foreground">This is Harbor itself. Update it with docker compose on the server.</p>}
                    {!s.name_ok && <p className="mt-2 text-xs text-warning">The project name isn't a valid stack name (lowercase letters, digits, - and _), so it can't be imported as-is.</p>}
                  </Surface>
                ))}
              </div>
            </section>
          )}
          {containers.length > 0 && (
            <section>
              <h2 className="mb-2 text-sm font-semibold">Standalone containers</h2>
              <p className="mb-3 text-sm text-muted-foreground">Import as a deployment. You can then switch its source to a GitHub repository.</p>
              <div className="space-y-2">
                {containers.map((c) => (
                  <Surface key={c.name} className="flex flex-wrap items-center gap-3 p-4">
                    <div className="flex size-9 items-center justify-center rounded-lg border bg-muted/60 text-brand">
                      <Box className="size-4.5" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <StatusDot status={c.state} />
                        <span className="font-semibold">{c.name}</span>
                        {c.is_komodo && <Badge tone="warning">Komodo itself</Badge>}
                        {c.is_harbor && <Badge tone="warning">Harbor itself</Badge>}
                      </div>
                      <div className="mt-0.5 truncate font-mono text-xs text-muted-foreground">
                        {c.image}
                        {c.ports.length > 0 && ` · ${c.ports.join(', ')}`}
                      </div>
                    </div>
                    <Button size="sm" variant={c.is_komodo ? 'outline' : 'default'} disabled={c.is_harbor} onClick={() => setContainer(c)}>
                      Import
                    </Button>
                  </Surface>
                ))}
              </div>
            </section>
          )}
        </div>
      )}
      {data && <ImportAllDialog candidates={data} open={all} onOpenChange={setAll} />}
      <ImportStackDialog candidate={stack} onClose={() => setStack(null)} />
      <ImportContainerDialog candidate={container} onClose={() => setContainer(null)} />
    </Page>
  )
}

function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  )
}

function ImportStackDialog({ candidate, onClose }: { candidate: ImportStackCandidate | null; onClose: () => void }) {
  return (
    <Dialog open={candidate !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] gap-0 overflow-y-auto p-0 sm:max-w-lg">
        {candidate && <ImportStackForm key={candidate.project} candidate={candidate} onClose={onClose} />}
      </DialogContent>
    </Dialog>
  )
}

function ImportStackForm({ candidate, onClose }: { candidate: ImportStackCandidate; onClose: () => void }) {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const [useGit, setUseGit] = useState(!!candidate.git_url)
  const [gitUrl, setGitUrl] = useState(candidate.git_url ?? '')
  const [branch, setBranch] = useState(candidate.git_branch ?? '')
  const [compose, setCompose] = useState('')
  const needsPaste = !candidate.compose_readable && !useGit

  const submit = useMutation({
    mutationFn: () =>
      api.post<Stack>('/import/stack', {
        project: candidate.project,
        compose: needsPaste ? compose : undefined,
        git: useGit ? { git_url: gitUrl, git_branch: branch } : undefined,
      }),
    onSuccess: (s) => {
      qc.invalidateQueries()
      toast.success(`Imported ${s.name}`)
      onClose()
      navigate(`/stacks/${s.name}`)
    },
  })
  const unreadable = submit.error instanceof ApiError && submit.error.message.startsWith('compose_unreadable')

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        submit.mutate()
      }}
    >
      <DialogHeader className="border-b px-5 py-4">
        <DialogTitle>Import {candidate.project} as a stack</DialogTitle>
        <DialogDescription className="font-mono text-xs break-all">{candidate.working_dir}</DialogDescription>
      </DialogHeader>
      <div className="space-y-4 px-5 py-4">
        <NoRestartNote />
        {candidate.is_komodo && (
          <p className="flex gap-2 text-sm text-warning">
            <TriangleAlert className="mt-0.5 size-4 shrink-0" /> This looks like Komodo itself. Only import it if you want Harbor to manage Komodo.
          </p>
        )}
        {candidate.git_url ? (
          <div className="space-y-3 rounded-lg border p-3">
            <label className="flex cursor-pointer items-start justify-between gap-3">
              <span>
                <span className="flex items-center gap-1.5 text-sm font-medium">
                  <GithubIcon /> Use the git repository
                </span>
                <span className="block text-xs text-muted-foreground">
                  This directory is a checkout of {repoLabel(candidate.git_url)}. Deploys pull the branch in place, and auto-deploy can follow pushes.
                </span>
              </span>
              <Switch checked={useGit} onCheckedChange={setUseGit} />
            </label>
            {useGit && (
              <div className="space-y-3 border-t pt-3">
                <Field label="Repository">
                  <Input value={gitUrl} onChange={(e) => setGitUrl(e.target.value)} className="font-mono" required />
                </Field>
                <Field label="Branch" hint="Empty uses the repository's default branch.">
                  <Input value={branch} onChange={(e) => setBranch(e.target.value)} placeholder="Default branch" className="font-mono" />
                </Field>
                <AccountHint url={gitUrl} hadCredentials={candidate.git_had_credentials} />
              </div>
            )}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">The compose file is copied into Harbor, where you can edit it. You can connect a GitHub repository later in Settings.</p>
        )}
        {(needsPaste || unreadable) && (
          <Field label="Compose file" hint={`Harbor can't read ${candidate.config_files[0] ?? 'the compose file'} (if Harbor runs in Docker, mount that directory at the same path). Paste its contents instead.`}>
            <Textarea value={compose} onChange={(e) => setCompose(e.target.value)} rows={8} className="font-mono text-[12.5px]" required />
          </Field>
        )}
        <ErrorAlert error={unreadable ? null : submit.error} />
      </div>
      <div className="flex justify-end gap-2 border-t bg-muted/30 px-5 py-3">
        <Button type="button" variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" disabled={submit.isPending}>
          Import stack
        </Button>
      </div>
    </form>
  )
}

/** Which git account an imported git stack will use. */
function AccountHint({ url, hadCredentials }: { url: string; hadCredentials: boolean }) {
  const accounts = useGitAccounts().data ?? []
  const host = gitHost(url)
  const account = accounts.find((a) => a.host === host)
  return (
    <p className="text-xs text-muted-foreground">
      {account ? (
        <>
          Uses the git account <span className="font-medium text-foreground">{account.name}</span> for {host}.
        </>
      ) : (
        <>
          No git account for {host ?? 'this host'}
          {hadCredentials ? " (the checkout's embedded credentials weren't copied)" : ''}. Public repositories work as-is; for private ones,{' '}
          <Link to="/settings" className="text-brand hover:underline">
            add an account in Settings
          </Link>
          .
        </>
      )}
    </p>
  )
}

function ImportContainerDialog({ candidate, onClose }: { candidate: ImportContainerCandidate | null; onClose: () => void }) {
  return (
    <Dialog open={candidate !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] gap-0 overflow-y-auto p-0 sm:max-w-lg">
        {candidate && <ImportContainerForm key={candidate.name} candidate={candidate} onClose={onClose} />}
      </DialogContent>
    </Dialog>
  )
}

function PreviewRow({ label, value }: { label: string; value: string }) {
  const lines = value.split('\n').filter(Boolean)
  return (
    <div className="grid grid-cols-[6.5rem_1fr] gap-3 px-3 py-2 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="min-w-0 font-mono text-[12px] break-all">{lines.length ? lines.map((l) => <div key={l}>{label === 'Variables' ? l.replace(/=.*/, '=•••') : l}</div>) : '—'}</span>
    </div>
  )
}

function ImportContainerForm({ candidate, onClose }: { candidate: ImportContainerCandidate; onClose: () => void }) {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const [name, setName] = useState(candidate.suggested_name)
  const preview = useQuery({
    queryKey: ['import-preview', candidate.name],
    queryFn: () => api.get<ContainerImportPreview>(`/import/container/${encodeURIComponent(candidate.name)}`),
  })
  const submit = useMutation({
    mutationFn: () => api.post<Deployment>('/import/container', { container: candidate.name, name }),
    onSuccess: (d) => {
      qc.invalidateQueries()
      toast.success(`Imported ${d.name}`)
      onClose()
      navigate(`/deployments/${d.name}?tab=settings`)
    },
  })
  const p = preview.data

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        submit.mutate()
      }}
    >
      <DialogHeader className="border-b px-5 py-4">
        <DialogTitle>Import {candidate.name} as a deployment</DialogTitle>
        <DialogDescription className="font-mono text-xs">{candidate.image}</DialogDescription>
      </DialogHeader>
      <div className="space-y-4 px-5 py-4">
        <NoRestartNote />
        <Field label="Service name" hint={name !== candidate.name ? `The container is renamed from ${candidate.name} on its first deploy.` : undefined}>
          <Input value={name} onChange={(e) => setName(e.target.value.toLowerCase())} required pattern="[a-z0-9][a-z0-9_\-]*" />
        </Field>
        {preview.isLoading ? (
          <Loading className="py-6" />
        ) : p ? (
          <>
            <div>
              <p className="mb-1.5 text-sm font-medium">Settings Harbor will take over</p>
              <div className="divide-y rounded-lg border bg-card">
                <PreviewRow label="Image" value={p.image} />
                <PreviewRow label="Ports" value={p.ports} />
                <PreviewRow label="Volumes" value={p.volumes} />
                <PreviewRow label="Variables" value={p.env} />
                <PreviewRow label="Labels" value={p.labels} />
                {p.network && <PreviewRow label="Network" value={p.network} />}
                <PreviewRow label="Restart" value={p.restart} />
                {p.command && <PreviewRow label="Command" value={p.command} />}
              </div>
            </div>
            {p.warnings.length > 0 && (
              <div className="space-y-1.5 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2.5 text-sm text-warning">
                <p className="flex items-center gap-1.5 font-medium">
                  <TriangleAlert className="size-4" /> Not carried over
                </p>
                <ul className="list-disc space-y-1 pl-5 text-xs">
                  {p.warnings.map((w) => (
                    <li key={w}>{w}</li>
                  ))}
                </ul>
              </div>
            )}
          </>
        ) : (
          <ErrorAlert error={preview.error} />
        )}
        <ErrorAlert error={submit.error} />
      </div>
      <div className="flex justify-end gap-2 border-t bg-muted/30 px-5 py-3">
        <Button type="button" variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" disabled={submit.isPending || !p}>
          Import deployment
        </Button>
      </div>
    </form>
  )
}
