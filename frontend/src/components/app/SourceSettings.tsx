import { Box, Check, ChevronsUp, Copy, Eye, EyeOff, FileCode2, KeyRound, X } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { Link } from 'react-router'
import { gitHost, repoLabel, type Deployment, type DeploymentSource, type Stack, type StackSource } from '@/api'
import { Button } from '@astryxdesign/core/Button'
import { IconButton } from '@astryxdesign/core/IconButton'
import { Selector } from '@astryxdesign/core/Selector'
import { Switch } from '@astryxdesign/core/Switch'
import { TextArea } from '@astryxdesign/core/TextArea'
import { TextInput } from '@astryxdesign/core/TextInput'
import { useGitAccounts } from '@/pages/Settings'
import { cn } from '@/lib/utils'
import { GithubIcon } from './GithubIcon'
import { SettingsSection } from './panel'
import { UpstreamField } from './promote'

export type SourceConfig = Pick<
  Deployment,
  'source' | 'image' | 'git_url' | 'git_branch' | 'build_context' | 'dockerfile' | 'build_args' | 'auto_deploy' | 'git_account_id' | 'upstream_id'
>

/** A labelled read-only value (not a form control), with an optional hint. */
function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="space-y-2">
      <div className="text-sm font-medium">{label}</div>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  )
}

/** A monospace text field, the shape every path/URL setting here takes. */
function MonoInput({
  label,
  hint,
  value,
  onChange,
  placeholder,
}: {
  label: string
  hint?: string
  value: string
  onChange: (v: string) => void
  placeholder?: string
}) {
  return (
    <TextInput
      label={label}
      description={hint}
      value={value}
      onChange={onChange}
      placeholder={placeholder}
      controlClassName="font-mono"
      hasAutoCorrect={false}
      autoCapitalize="off"
      width="100%"
    />
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
        <IconButton
          variant="ghost"
          size="sm"
          label={shown ? 'Hide' : 'Show'}
          tooltip={shown ? 'Hide' : 'Show'}
          icon={shown ? <EyeOff /> : <Eye />}
          onClick={() => setShown((s) => !s)}
        />
      )}
      <IconButton variant="ghost" size="sm" label="Copy" tooltip="Copy" icon={copied ? <Check className="text-success" /> : <Copy />} onClick={copy} />
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
    <div className="space-y-2">
      <Selector
        label="Git account"
        value={selected}
        onChange={(v) => onChange(v === 'auto' ? null : v === 'none' ? 0 : Number(v))}
        options={[
          { value: 'auto', label: `Automatic${auto ? ` (${auto.name})` : ''}` },
          ...accounts.map((a) => ({ value: String(a.id), label: `${a.name} · ${a.host}` })),
          { value: 'none', label: 'None (public repository)' },
        ]}
        containerClassName="w-full sm:w-80"
        width="100%"
      />
      <p className="text-xs text-muted-foreground">
        {
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
        )}
      </p>
      {hasToken && (
        <div className="mt-2 flex flex-wrap items-center gap-2 rounded-lg border border-dashed px-3 py-2 text-xs text-muted-foreground">
          <KeyRound className="size-3.5" />
          {token === '' ? (
            <>
              <span className="flex-1">This service's own token will be removed on save.</span>
              <Button variant="ghost" size="sm" label="Undo" onClick={() => onTokenChange(null)} />
            </>
          ) : (
            <>
              <span className="flex-1">This service has its own token from before git accounts; it's used only when no account applies.</span>
              <Button variant="destructive" size="sm" icon={<X />} label="Remove" onClick={() => onTokenChange('')} />
            </>
          )}
        </div>
      )}
    </div>
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
        <MonoInput label="Image" hint="Untagged images use :latest." value={config.image} onChange={set('image')} placeholder="nginx:alpine" />
      ) : (
        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-[1fr_12rem]">
            <MonoInput label="Repository" hint="owner/repo for GitHub, or any git URL." value={config.git_url} onChange={set('git_url')} placeholder="owner/repo" />
            <MonoInput label="Branch" value={config.git_branch} onChange={set('git_branch')} placeholder="Default branch" />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <MonoInput label="Root directory" hint="Build context inside the repo." value={config.build_context} onChange={set('build_context')} placeholder="." />
            <MonoInput label="Dockerfile path" hint="Relative to the root directory." value={config.dockerfile} onChange={set('dockerfile')} placeholder="Dockerfile" />
          </div>
          <TextArea
            label="Build arguments"
            description="One KEY=value per line, passed as --build-arg."
            value={config.build_args}
            onChange={set('build_args')}
            rows={3}
            placeholder="NODE_ENV=production"
            controlClassName="font-mono text-[12.5px]"
            hasSpellCheck={false}
            width="100%"
          />
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
      <Switch
        label="Auto-deploy"
        description="Harbor checks the branch for new commits about once a minute. Add the webhook below for instant deploys."
        value={enabled}
        onChange={onEnabledChange}
        labelPosition="start"
        labelSpacing="spread"
        width="100%"
      />
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

export type StackSourceConfig = Pick<Stack, 'source' | 'git_url' | 'git_branch' | 'compose_path' | 'compose_overrides' | 'project_dir' | 'git_account_id'>

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
              <MonoInput label="Repository" hint="owner/repo for GitHub, or any git URL." value={config.git_url} onChange={set('git_url')} placeholder="owner/repo" />
              <MonoInput label="Branch" value={config.git_branch} onChange={set('git_branch')} placeholder="Default branch" />
            </div>
            <MonoInput label="Compose file" hint="Path inside the repository. Relative paths in it resolve against its folder." value={config.compose_path} onChange={set('compose_path')} placeholder="compose.yaml" />
            <TextArea
              label="Additional compose files"
              description="One path per line, applied in order on top of the compose file, like docker compose -f compose.yaml -f override.yaml. Use it for override files that add devices or hardware acceleration. Services with a build: section are rebuilt on every deploy."
              value={config.compose_overrides}
              onChange={set('compose_overrides')}
              placeholder="docker-compose.gpu.yml"
              controlClassName="font-mono"
              hasSpellCheck={false}
              rows={2}
              width="100%"
            />
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
        <MonoInput
          label={config.source === 'git' ? 'Checkout directory' : 'Project directory'}
          hint={
            config.source === 'git'
              ? 'Where the repository is checked out on the host. Empty uses Harbor\'s data folder. Deploys update it in place: local edits to tracked files are discarded, other files (like data folders) are kept.'
              : 'Relative paths in the compose file resolve against this directory. Empty uses Harbor\'s data folder. Imported stacks keep their original directory.'
          }
          value={config.project_dir}
          onChange={set('project_dir')}
          placeholder="(Harbor's data folder)"
        />
      </div>
    </SettingsSection>
  )
}

export type SourceSettingsSet = <K extends keyof SourceConfig>(k: K) => (v: SourceConfig[K]) => void
