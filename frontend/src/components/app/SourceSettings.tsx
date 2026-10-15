import { Box, Check, ChevronsUp, Copy, Eye, EyeOff, FileCode2, KeyRound, X } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { Link } from 'react-router'
import { gitHost, repoLabel, type Deployment, type DeploymentSource, type Stack, type StackSource } from '@/api'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useGitAccounts } from '@/pages/Settings'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import { GithubIcon } from './GithubIcon'
import { SettingsSection } from './panel'
import { UpstreamField } from './promote'

export type SourceConfig = Pick<
  Deployment,
  'source' | 'image' | 'git_url' | 'git_branch' | 'build_context' | 'dockerfile' | 'build_args' | 'auto_deploy' | 'git_account_id' | 'upstream_id'
>

function Field({ label, hint, children, htmlFor }: { label: string; hint?: ReactNode; children: ReactNode; htmlFor?: string }) {
  return (
    <div className="space-y-2">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  )
}

function CopyField({ value, secret = false }: { value: string; secret?: boolean }) {
  const [copied, setCopied] = useState(false)
  const [shown, setShown] = useState(!secret)
  const copy = async () => {
    await navigator.clipboard.writeText(value)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }
  return (
    <div className="flex items-center gap-1 rounded-lg border bg-log py-1 pr-1 pl-3">
      <code className="min-w-0 flex-1 truncate font-mono text-[12px]">{shown ? value : '•'.repeat(24)}</code>
      {secret && (
        <Button type="button" variant="ghost" size="icon-sm" onClick={() => setShown((s) => !s)} title={shown ? 'Hide' : 'Show'}>
          {shown ? <EyeOff /> : <Eye />}
        </Button>
      )}
      <Button type="button" variant="ghost" size="icon-sm" onClick={copy} title="Copy">
        {copied ? <Check className="text-success" /> : <Copy />}
      </Button>
    </div>
  )
}

/**
 * Which git account a service uses: automatic (the account for the repo's
 * host), a specific one, or none. Also lets a service drop a token it saved
 * before accounts existed.
 */
function AccountField({
  url,
  value,
  onChange,
  hasToken,
  token,
  onTokenChange,
}: {
  url: string
  value: number | null
  onChange: (v: number | null) => void
  hasToken: boolean
  token: string | null
  onTokenChange: (t: string | null) => void
}) {
  const accounts = useGitAccounts().data ?? []
  const host = gitHost(url)
  const auto = accounts.find((a) => a.host === host)
  const selected = value === null ? 'auto' : value === 0 ? 'none' : String(value)
  return (
    <Field
      label="Git account"
      hint={
        value === null ? (
          auto ? (
            <>
              Uses <span className="font-medium text-foreground">{auto.name}</span>, the account for {host}.
            </>
          ) : (
            <>
              No account for {host ?? 'this host'}, so the repository is accessed without credentials.{' '}
              <Link to="/settings" className="text-brand hover:underline">
                Add one in Settings
              </Link>{' '}
              for private repositories.
            </>
          )
        ) : value === 0 ? (
          'Accessed without credentials. Works for public repositories.'
        ) : (
          <>
            Manage accounts in{' '}
            <Link to="/settings" className="text-brand hover:underline">
              Settings
            </Link>
            .
          </>
        )
      }
    >
      <Select value={selected} onValueChange={(v) => onChange(v === 'auto' ? null : v === 'none' ? 0 : Number(v))}>
        <SelectTrigger className="w-full sm:w-80">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="auto">Automatic{auto ? ` (${auto.name})` : ''}</SelectItem>
          {accounts.map((a) => (
            <SelectItem key={a.id} value={String(a.id)}>
              {a.name} · {a.host}
            </SelectItem>
          ))}
          <SelectItem value="none">None (public repository)</SelectItem>
        </SelectContent>
      </Select>
      {hasToken && (
        <div className="mt-2 flex flex-wrap items-center gap-2 rounded-lg border border-dashed px-3 py-2 text-xs text-muted-foreground">
          <KeyRound className="size-3.5" />
          {token === '' ? (
            <>
              <span className="flex-1">This service's own token will be removed on save.</span>
              <Button type="button" variant="ghost" size="xs" onClick={() => onTokenChange(null)}>
                Undo
              </Button>
            </>
          ) : (
            <>
              <span className="flex-1">This service has its own token from before git accounts; it's used only when no account applies.</span>
              <Button type="button" variant="ghost" size="xs" className="text-destructive" onClick={() => onTokenChange('')}>
                <X /> Remove
              </Button>
            </>
          )}
        </div>
      )}
    </Field>
  )
}

/** Image vs. repository vs. promote picker plus the fields for each. */
export function SourceSettings({
  config,
  set,
  hasToken,
  token,
  onTokenChange,
  selfId,
}: {
  config: SourceConfig
  /** The deployment being edited, which can't promote from itself. */
  selfId?: number
  set: SourceSettingsSet
  hasToken: boolean
  /** null = unchanged, '' = clear, otherwise the new token. */
  token: string | null
  onTokenChange: (t: string | null) => void
}) {
  const options: { id: DeploymentSource; icon: ReactNode; label: string; body: string }[] = [
    { id: 'git', icon: <GithubIcon />, label: 'Git repository', body: 'Build from a Dockerfile' },
    { id: 'image', icon: <Box className="size-4" />, label: 'Docker image', body: 'Pull from a registry' },
    { id: 'promote', icon: <ChevronsUp className="size-4" />, label: 'Another deployment', body: 'Promote its tested images' },
  ]

  return (
    <SettingsSection title="Source" description="Where this service's image comes from.">
      <div className="mb-4 grid gap-2 sm:grid-cols-3">
        {options.map((o) => (
          <button
            key={o.id}
            type="button"
            onClick={() => set('source')(o.id)}
            className={cn(
              'flex items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors',
              config.source === o.id ? 'border-brand/60 bg-brand/10 ring-3 ring-brand/15' : 'hover:bg-accent/50',
            )}
          >
            <span className={cn('flex size-8 items-center justify-center rounded-md border bg-card', config.source === o.id && 'text-brand')}>{o.icon}</span>
            <span>
              <span className="block text-sm font-medium">{o.label}</span>
              <span className="block text-xs text-muted-foreground">{o.body}</span>
            </span>
          </button>
        ))}
      </div>

      {config.source === 'promote' ? (
        <UpstreamField selfId={selfId} value={config.upstream_id} onChange={set('upstream_id')} />
      ) : config.source === 'image' ? (
        <Field label="Image" hint="Untagged images use :latest." htmlFor="src-image">
          <Input id="src-image" value={config.image} onChange={(e) => set('image')(e.target.value)} placeholder="nginx:alpine" className="font-mono" />
        </Field>
      ) : (
        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-[1fr_12rem]">
            <Field label="Repository" hint="owner/repo for GitHub, or any git URL." htmlFor="src-repo">
              <Input id="src-repo" value={config.git_url} onChange={(e) => set('git_url')(e.target.value)} placeholder="owner/repo" className="font-mono" />
            </Field>
            <Field label="Branch" htmlFor="src-branch">
              <Input id="src-branch" value={config.git_branch} onChange={(e) => set('git_branch')(e.target.value)} placeholder="Default branch" className="font-mono" />
            </Field>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Root directory" hint="Build context inside the repo." htmlFor="src-context">
              <Input id="src-context" value={config.build_context} onChange={(e) => set('build_context')(e.target.value)} placeholder="." className="font-mono" />
            </Field>
            <Field label="Dockerfile path" hint="Relative to the root directory." htmlFor="src-dockerfile">
              <Input id="src-dockerfile" value={config.dockerfile} onChange={(e) => set('dockerfile')(e.target.value)} placeholder="Dockerfile" className="font-mono" />
            </Field>
          </div>
          <Field label="Build arguments" hint={<>One <code>KEY=value</code> per line, passed as <code>--build-arg</code>.</>} htmlFor="src-args">
            <Textarea id="src-args" value={config.build_args} onChange={(e) => set('build_args')(e.target.value)} rows={3} placeholder="NODE_ENV=production" className="font-mono text-[12.5px]" />
          </Field>
          <AccountField
            url={config.git_url}
            value={config.git_account_id}
            onChange={set('git_account_id')}
            hasToken={hasToken}
            token={token}
            onTokenChange={onTokenChange}
          />
        </div>
      )}
    </SettingsSection>
  )
}

/** Auto-deploy toggle with the GitHub webhook details. */
export function AutoDeploySettings({
  webhookPath,
  repo,
  branch,
  enabled,
  onEnabledChange,
  secret,
}: {
  webhookPath: string
  repo: string
  branch: string
  enabled: boolean
  onEnabledChange: (v: boolean) => void
  secret: string
}) {
  const url = `${window.location.origin}${webhookPath}`
  const local = /^(localhost|127\.|\[::1\])/.test(window.location.hostname)
  return (
    <SettingsSection title="Deploy on push" description={`Redeploy when ${repoLabel(repo) || 'the repo'} gets new commits on ${branch || 'its default branch'}.`}>
      <label className="flex cursor-pointer items-start justify-between gap-4">
        <span>
          <span className="block text-sm font-medium">Auto-deploy</span>
          <span className="block text-xs text-muted-foreground">Harbor checks the branch for new commits about once a minute. Add the webhook below for instant deploys.</span>
        </span>
        <Switch checked={enabled} onCheckedChange={onEnabledChange} />
      </label>
      {enabled && (
        <div className="mt-4 space-y-3 border-t pt-4">
          <p className="text-sm">
            <span className="font-medium">GitHub webhook</span>{' '}
            <span className="text-muted-foreground">(optional) · Repo Settings → Webhooks → Add webhook, content type application/json, "Just the push event".</span>
          </p>
          <Field label="Payload URL">
            <CopyField value={url} />
          </Field>
          {local && <p className="text-xs text-warning">This URL uses a local address, so GitHub can't reach it. Use Harbor's public address, or rely on polling.</p>}
          <Field label="Secret">
            <CopyField value={secret} secret />
          </Field>
        </div>
      )}
    </SettingsSection>
  )
}

export type StackSourceConfig = Pick<Stack, 'source' | 'git_url' | 'git_branch' | 'compose_path' | 'project_dir' | 'git_account_id'>

/** Inline compose vs. git repository for a stack, plus its project directory. */
export function StackSourceSettings({
  config,
  set,
  hasToken,
  token,
  onTokenChange,
}: {
  config: StackSourceConfig
  set: <K extends keyof StackSourceConfig>(k: K) => (v: StackSourceConfig[K]) => void
  hasToken: boolean
  token: string | null
  onTokenChange: (t: string | null) => void
}) {
  const options: { id: StackSource; icon: ReactNode; label: string; body: string }[] = [
    { id: 'git', icon: <GithubIcon />, label: 'Git repository', body: 'Compose file from a repo' },
    { id: 'inline', icon: <FileCode2 className="size-4" />, label: 'Edited in Harbor', body: 'Compose file stored here' },
  ]
  return (
    <SettingsSection title="Source" description="Where this stack's compose file comes from.">
      <div className="mb-4 grid gap-2 sm:grid-cols-2">
        {options.map((o) => (
          <button
            key={o.id}
            type="button"
            onClick={() => set('source')(o.id)}
            className={cn(
              'flex items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors',
              config.source === o.id ? 'border-brand/60 bg-brand/10 ring-3 ring-brand/15' : 'hover:bg-accent/50',
            )}
          >
            <span className={cn('flex size-8 items-center justify-center rounded-md border bg-card', config.source === o.id && 'text-brand')}>{o.icon}</span>
            <span>
              <span className="block text-sm font-medium">{o.label}</span>
              <span className="block text-xs text-muted-foreground">{o.body}</span>
            </span>
          </button>
        ))}
      </div>
      <div className="space-y-4">
        {config.source === 'git' && (
          <>
            <div className="grid gap-4 sm:grid-cols-[1fr_12rem]">
              <Field label="Repository" hint="owner/repo for GitHub, or any git URL." htmlFor="st-repo">
                <Input id="st-repo" value={config.git_url} onChange={(e) => set('git_url')(e.target.value)} placeholder="owner/repo" className="font-mono" />
              </Field>
              <Field label="Branch" htmlFor="st-branch">
                <Input id="st-branch" value={config.git_branch} onChange={(e) => set('git_branch')(e.target.value)} placeholder="Default branch" className="font-mono" />
              </Field>
            </div>
            <Field label="Compose file" hint="Path inside the repository. Relative paths in it resolve against its folder." htmlFor="st-path">
              <Input id="st-path" value={config.compose_path} onChange={(e) => set('compose_path')(e.target.value)} placeholder="compose.yaml" className="font-mono" />
            </Field>
            <AccountField
              url={config.git_url}
              value={config.git_account_id}
              onChange={set('git_account_id')}
              hasToken={hasToken}
              token={token}
              onTokenChange={onTokenChange}
            />
          </>
        )}
        <Field
          label={config.source === 'git' ? 'Checkout directory' : 'Project directory'}
          hint={
            config.source === 'git'
              ? 'Where the repository is checked out on the host. Empty uses Harbor\'s data folder. Deploys update it in place: local edits to tracked files are discarded, other files (like data folders) are kept.'
              : 'Relative paths in the compose file resolve against this directory. Empty uses Harbor\'s data folder. Imported stacks keep their original directory.'
          }
          htmlFor="st-dir"
        >
          <Input id="st-dir" value={config.project_dir} onChange={(e) => set('project_dir')(e.target.value)} placeholder="(Harbor's data folder)" className="font-mono" />
        </Field>
      </div>
    </SettingsSection>
  )
}

export type SourceSettingsSet = <K extends keyof SourceConfig>(k: K) => (v: SourceConfig[K]) => void
