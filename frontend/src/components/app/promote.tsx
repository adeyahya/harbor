import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronsUp, Info } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { Link, useNavigate } from 'react-router'
import { api, shortArtifact, type Deployment, type DeploymentListItem, type Promotable, type Update } from '@/api'
import { Button } from '@astryxdesign/core/Button'
import { Dialog, DialogHeader } from '@astryxdesign/core/Dialog'
import { Selector } from '@astryxdesign/core/Selector'
import { Switch } from '@astryxdesign/core/Switch'
import { TextInput } from '@astryxdesign/core/TextInput'
import { timeAgo } from '@/lib/format'
import { Confirm } from './confirm'
import { ErrorAlert, Loading } from './page'
import { SettingsSection } from './panel'
import { StatusPill } from './status'
import { splitDetail, useRunAction } from './updates'

/**
 * Promote deployments run the exact image a deploy of another deployment
 * ran (its upstream, e.g. staging), with their own settings.
 */

export function useDeploymentList() {
  return useQuery({ queryKey: ['deployments'], queryFn: () => api.get<DeploymentListItem[]>('/deployments'), refetchInterval: 4000 })
}

/** What a deploy ran: its commit when built from git, else the image. */
function describe(u: Pick<Update, 'detail' | 'artifact'>) {
  const { sha, message } = splitDetail(u.detail)
  return sha ? { sha: sha.slice(0, 7), message } : { sha: '', message: u.detail.replace(/^↩ /, '') || shortArtifact(u.artifact) }
}

/** Whether a promote deployment runs something other than its upstream's latest deploy. */
export function isBehind(d: DeploymentListItem, upstream: DeploymentListItem | undefined) {
  return !!upstream?.artifact && upstream.artifact !== d.artifact
}

/** What one side of a promotion runs. */
function Running({ name, u, fallback }: { name: ReactNode; u?: Pick<Update, 'detail' | 'artifact'>; fallback: string }) {
  return (
    <div className="min-w-0 flex-1 rounded-lg border bg-muted/30 px-3 py-2">
      <div className="text-xs text-muted-foreground">{name}</div>
      {u ? (
        <div className="flex min-w-0 items-center gap-2 text-sm">
          {describe(u).sha && <span className="shrink-0 font-mono text-xs text-brand">{describe(u).sha}</span>}
          <span className="truncate">{describe(u).message}</span>
        </div>
      ) : (
        <div className="truncate text-sm text-muted-foreground">{fallback}</div>
      )}
    </div>
  )
}

/** Upstream vs. this deployment, and the upstream's deploys to promote. */
export function PromotePanel({ deployment: d }: { deployment: Deployment }) {
  const list = useDeploymentList()
  const upstream = list.data?.find((x) => x.id === d.upstream_id)
  const live = list.data?.find((x) => x.id === d.id)?.artifact ?? null
  const promotable = useQuery({
    queryKey: ['promotable', d.name, d.upstream_id],
    queryFn: () => api.get<Promotable[]>(`/deployments/${d.name}/promotable`),
    enabled: !!upstream,
    refetchInterval: 4000,
  })
  const [target, setTarget] = useState<Promotable | null>(null)
  const run = useRunAction()

  if (list.isLoading) return <Loading />
  if (!upstream)
    return (
      <div className="mb-4 flex gap-2 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-sm text-warning">
        <Info className="mt-0.5 size-4 shrink-0" />
        The deployment this promotes from no longer exists. Choose another source in Settings.
      </div>
    )

  const items = promotable.data ?? []
  const current = items[0]
  const liveItem = items.find((u) => u.artifact === live)
  const behind = !!current && current.artifact !== live
  return (
    <div className="mb-5 space-y-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <Running
          name={
            <Link to={`/deployments/${upstream.name}`} className="font-medium text-foreground/90 hover:underline">
              {upstream.name}
            </Link>
          }
          u={current}
          fallback="No successful deploy yet"
        />
        <ChevronsUp className="size-4 shrink-0 self-center text-muted-foreground sm:rotate-90" />
        <Running
          name={<span className="font-medium text-foreground/90">{d.name}</span>}
          u={liveItem ?? (live ? { detail: '', artifact: live } : undefined)}
          fallback="Nothing promoted yet"
        />
      </div>
      {behind && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-brand/30 bg-brand/10 px-3 py-2 text-sm">
          <span>
            {upstream.name} is running a deploy that {d.name} doesn't have yet.
          </span>
          <Button
            size="sm"
            variant="primary"
            icon={<ChevronsUp />}
            label="Promote"
            onClick={() => setTarget(current)}
            isDisabled={!current.available || run.isPending}
          />
        </div>
      )}

      {items.length > 0 && (
        <details className="group rounded-xl border bg-card">
          <summary className="cursor-pointer px-4 py-2.5 text-sm font-medium select-none">
            Promote an earlier deploy of {upstream.name} <span className="font-normal text-muted-foreground">({items.length})</span>
          </summary>
          <div className="scrollbar-thin max-h-80 divide-y overflow-auto border-t">
            {items.map((u, i) => {
              const { sha, message } = describe(u)
              const isLive = u.artifact === live
              return (
                <div key={u.id} className="flex items-center gap-3 px-4 py-2.5">
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="truncate text-sm">{message}</span>
                      {sha && <span className="shrink-0 font-mono text-xs text-brand">{sha}</span>}
                      {i === 0 && <StatusPill status="created" label={`On ${upstream.name}`} />}
                      {isLive && <StatusPill status="success" label="Live here" />}
                      {!u.available && <StatusPill status="exited" label="Image pruned" />}
                    </div>
                    <div className="mt-0.5 text-xs text-muted-foreground">
                      <span className="capitalize">{u.operation}</span> #{u.id} · {timeAgo(u.started_at)} by {u.username}
                    </div>
                  </div>
                  <Button
                    variant="secondary"
                    size="sm"
                    icon={<ChevronsUp />}
                    label="Promote"
                    isDisabled={isLive || !u.available || run.isPending}
                    onClick={() => setTarget(u)}
                  />
                </div>
              )
            })}
          </div>
        </details>
      )}

      <Confirm
        open={target !== null}
        onOpenChange={(o) => !o && setTarget(null)}
        title={`Promote to ${d.name}?`}
        description={`Runs ${target ? describe(target).sha || describe(target).message : ''} from ${upstream.name} with ${d.name}'s own ports, variables and volumes. Nothing is rebuilt or pulled.`}
        confirmLabel="Promote"
        destructive={false}
        onConfirm={() => target && run.mutate({ path: `/deployments/${d.name}/promote/${target.id}` })}
      />
    </div>
  )
}

/** Picks the upstream of a promote deployment. */
export function UpstreamField({ selfId, value, onChange }: { selfId?: number; value: number | null; onChange: (v: number | null) => void }) {
  const list = useDeploymentList().data ?? []
  const options = list.filter((x) => x.id !== selfId)
  return (
    <div className="space-y-2">
      <Selector
        label="Promote from"
        value={value === null ? undefined : String(value)}
        onChange={(v) => onChange(Number(v))}
        options={options.map((x) => ({ value: String(x.id), label: x.name }))}
        placeholder="Choose a deployment…"
        containerClassName="w-full sm:w-80"
        width="100%"
      />
      <p className="text-xs text-muted-foreground">
        Runs the exact image one of its deploys ran (e.g. staging → production), with this deployment's own ports, variables and volumes. Nothing is
        rebuilt, so settings baked in at build time (build arguments, variables compiled into a frontend bundle) are the same as upstream; pass
        environment-specific values as variables.
      </p>
    </div>
  )
}

/** Auto-promote toggle for promote deployments. */
export function AutoPromoteSettings({ upstream, enabled, onEnabledChange }: { upstream: string; enabled: boolean; onEnabledChange: (v: boolean) => void }) {
  return (
    <SettingsSection title="Promote automatically" description={`Promote every successful deploy of ${upstream || 'the upstream'} as soon as it finishes.`}>
      <Switch
        label="Auto-promote"
        description="Leave this off for production to promote by hand once the upstream looks good."
        value={enabled}
        onChange={onEnabledChange}
        labelPosition="start"
        labelSpacing="spread"
        width="100%"
      />
    </SettingsSection>
  )
}

/** Suggests an environment name: `api-staging` → `api-production`. */
function suggestName(name: string) {
  return `${name.replace(/[-_](staging|stage|stg|dev|development|test)$/, '')}-production`.slice(0, 63)
}

/** Creates a promote deployment of `source`, starting from its variables and run settings. */
export function CreateEnvironmentDialog({ source, open, onOpenChange }: { source: Deployment; open: boolean; onOpenChange: (o: boolean) => void }) {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const [name, setName] = useState(() => suggestName(source.name))
  const nameValid = /^[a-z0-9][a-z0-9_-]*$/.test(name)
  const create = useMutation({
    mutationFn: () =>
      api.post<Deployment>('/deployments', {
        name,
        source: 'promote',
        upstream_id: source.id,
        env: source.env,
        network: source.network,
        restart: source.restart,
        command: source.command,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['deployments'] })
      onOpenChange(false)
      navigate(`/deployments/${name}?tab=settings`)
    },
  })
  return (
    <Dialog isOpen={open} onOpenChange={onOpenChange} width={448} padding={0} purpose="form">
        <form
          onSubmit={(e) => {
            e.preventDefault()
            if (nameValid) create.mutate()
          }}
        >
          <DialogHeader
            className="px-5 py-4"
            title="New environment"
            subtitle={`A deployment that runs the images ${source.name} deploys, promoted by hand or automatically, with its own settings.`}
            onOpenChange={onOpenChange}
            hasDivider
          />
          <div className="space-y-4 px-5 py-4">
            <TextInput
              label="Service name"
              value={name}
              onChange={(v) => setName(v.toLowerCase())}
              status={name && !nameValid ? { type: 'error', message: 'Start with a letter or digit; use only a-z, 0-9, - and _.' } : undefined}
              hasAutoFocus
              isRequired
              width="100%"
            />
            <p className="text-xs text-muted-foreground">
              Variables, network, restart policy and command are copied from {source.name}. Ports, volumes and labels aren't, so the two environments don't
              clash or share data: set them next.
            </p>
            <ErrorAlert error={create.error} />
          </div>
          <div className="flex justify-end gap-2 border-t bg-muted/30 px-5 py-3">
            <Button type="button" variant="ghost" label="Cancel" onClick={() => onOpenChange(false)} />
            <Button type="submit" variant="primary" label="Create" isLoading={create.isPending} isDisabled={!nameValid} />
          </div>
        </form>
    </Dialog>
  )
}
