import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Box, CheckCircle2, GitBranch, Layers, Loader2, XCircle } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router'
import { api, type DeploymentListItem, type ImportCandidates } from '@/api'
import { Button } from '@astryxdesign/core/Button'
import { CheckboxInput } from '@astryxdesign/core/CheckboxInput'
import { Dialog, DialogHeader } from '@astryxdesign/core/Dialog'
import { Switch } from '@astryxdesign/core/Switch'
import { TextInput } from '@astryxdesign/core/TextInput'
import { cn } from '@/lib/utils'

type Status = { state: 'running' } | { state: 'done' } | { state: 'error'; message: string }

interface Item {
  key: string
  kind: 'stack' | 'container'
  /** Compose project or container name. */
  source: string
  /** Harbor name: the project for stacks, editable for containers. */
  name: string
  detail: string
  defaultOn: boolean
  /** Why it can't be imported in bulk. */
  blocked?: string
  gitUrl?: string | null
  gitBranch?: string | null
  composeReadable?: boolean
}

const NAME = /^[a-z0-9][a-z0-9_-]{0,62}$/

/** Applies the user's renames and the git choice to a planned item. */
function withState(it: Item, names: Record<string, string>, useGit: boolean) {
  // An unreadable compose file is fine when the repo provides it.
  const needsPaste = it.kind === 'stack' && !it.composeReadable && !(useGit && it.gitUrl)
  const blocked = it.blocked ?? (needsPaste ? "Harbor can't read its compose file; import it on its own to paste it" : undefined)
  return { ...it, name: names[it.key] ?? it.name, blocked }
}

/** Plans one import per candidate, giving containers unique Harbor names. */
function plan(c: ImportCandidates, existing: Set<string>): Item[] {
  const items: Item[] = c.stacks.map((s) => ({
    key: `stack:${s.project}`,
    kind: 'stack',
    source: s.project,
    name: s.project,
    detail: s.containers.map((x) => x.service ?? x.name).join(', '),
    defaultOn: !s.is_komodo,
    blocked: s.is_harbor ? 'Harbor itself' : !s.name_ok ? "Not a valid stack name; can't be imported as-is" : undefined,
    gitUrl: s.git_url,
    gitBranch: s.git_branch,
    composeReadable: s.compose_readable,
  }))
  const taken = new Set(existing)
  for (const x of c.containers) {
    let name = x.suggested_name
    for (let n = 2; taken.has(name); n++) name = `${x.suggested_name.slice(0, 60)}-${n}`
    taken.add(name)
    items.push({
      key: `container:${x.name}`,
      kind: 'container',
      source: x.name,
      name,
      detail: x.image,
      defaultOn: !x.is_komodo,
      blocked: x.is_harbor ? 'Harbor itself' : undefined,
    })
  }
  return items
}

export function ImportAllDialog({ candidates, open, onOpenChange }: { candidates: ImportCandidates; open: boolean; onOpenChange: (o: boolean) => void }) {
  return (
    <Dialog isOpen={open} onOpenChange={onOpenChange} width={672} maxHeight="90vh" padding={0} purpose="form">
      <div className="flex max-h-[90vh] flex-col overflow-hidden">
        {open && <ImportAllForm candidates={candidates} onClose={() => onOpenChange(false)} />}
      </div>
    </Dialog>
  )
}

function ImportAllForm({ candidates, onClose }: { candidates: ImportCandidates; onClose: () => void }) {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const deployments = useQuery({ queryKey: ['deployments'], queryFn: () => api.get<DeploymentListItem[]>('/deployments') })
  // Plan once the existing names are known, then keep the user's edits.
  const planned = useMemo(
    () => (deployments.data ? plan(candidates, new Set(deployments.data.map((d) => d.name))) : null),
    [candidates, deployments.data],
  )
  const [names, setNames] = useState<Record<string, string>>({})
  const [checked, setChecked] = useState<Record<string, boolean>>({})
  const [useGit, setUseGit] = useState(true)
  const [status, setStatus] = useState<Record<string, Status>>({})
  const [running, setRunning] = useState(false)
  // The candidate list refreshes as imports land; keep showing the rows (and
  // their results) as they were when the import started.
  const [frozen, setFrozen] = useState<ReturnType<typeof withState>[] | null>(null)
  const finished = Object.keys(status).length > 0 && !running

  if (!planned) {
    return (
      <div className="flex justify-center py-16">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    )
  }

  const items = frozen ?? planned.map((it) => withState(it, names, useGit))
  const isOn = (it: (typeof items)[number]) => !it.blocked && (checked[it.key] ?? it.defaultOn)
  const selected = items.filter(isOn)
  const names_ = selected.filter((i) => i.kind === 'container').map((i) => i.name)
  const invalid = selected.filter((i) => i.kind === 'container' && (!NAME.test(i.name) || names_.indexOf(i.name) !== names_.lastIndexOf(i.name)))
  const gitCount = items.filter((i) => i.gitUrl && !i.blocked).length

  const run = async () => {
    setFrozen(items)
    setRunning(true)
    for (const it of selected) {
      setStatus((s) => ({ ...s, [it.key]: { state: 'running' } }))
      try {
        if (it.kind === 'stack') {
          await api.post('/import/stack', {
            project: it.source,
            git: useGit && it.gitUrl ? { git_url: it.gitUrl, git_branch: it.gitBranch ?? '' } : undefined,
          })
        } else {
          await api.post('/import/container', { container: it.source, name: it.name })
        }
        setStatus((s) => ({ ...s, [it.key]: { state: 'done' } }))
      } catch (e) {
        setStatus((s) => ({ ...s, [it.key]: { state: 'error', message: e instanceof Error ? e.message : String(e) } }))
      }
    }
    setRunning(false)
    qc.invalidateQueries()
  }

  const done = Object.values(status).filter((s) => s.state === 'done').length
  const failed = Object.values(status).filter((s) => s.state === 'error').length

  return (
    <>
      <DialogHeader
        className="px-5 py-4"
        title="Import all"
        subtitle="Nothing restarts now. Each service keeps running until you deploy it from Harbor. Review what will be imported, and rename standalone containers if you like."
        onOpenChange={(o) => !o && !running && onClose()}
        hasDivider
      />

      <div className="scrollbar-thin min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
        {gitCount > 0 && (
          <div className="rounded-lg border p-3">
            <Switch
              label="Use git repositories where detected"
              labelIcon={GitBranch}
              description={`${gitCount} ${gitCount === 1 ? 'stack runs' : 'stacks run'} from a git checkout. Deploys will pull the branch in place. Private repositories need an access token, which you can add in each stack's Settings.`}
              value={useGit}
              onChange={setUseGit}
              isDisabled={running || finished}
              labelPosition="start"
              labelSpacing="spread"
              width="100%"
            />
          </div>
        )}

        <div className="divide-y overflow-hidden rounded-xl border bg-card">
          {items.map((it) => {
            const st = status[it.key]
            const on = isOn(it)
            const bad = invalid.includes(it)
            return (
              <div key={it.key} className={cn('flex items-start gap-3 px-3 py-2.5', it.blocked && 'opacity-60')}>
                <span className="mt-0.5">
                  <CheckboxInput
                    label={`Import ${it.source}`}
                    isLabelHidden
                    value={on}
                    isDisabled={!!it.blocked || running || finished}
                    onChange={(v) => setChecked((c) => ({ ...c, [it.key]: v }))}
                  />
                </span>
                <span className="mt-0.5 text-muted-foreground">{it.kind === 'stack' ? <Layers className="size-4" /> : <Box className="size-4" />}</span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium">{it.source}</span>
                    {it.kind === 'stack' && useGit && it.gitUrl && !it.blocked && <span className="text-xs text-brand">git</span>}
                    {!it.defaultOn && !it.blocked && <span className="text-xs text-warning">Komodo itself</span>}
                  </div>
                  <div className="truncate font-mono text-xs text-muted-foreground">{it.detail}</div>
                  {it.blocked && <div className="text-xs text-muted-foreground">{it.blocked}</div>}
                  {st?.state === 'error' && <div className="text-xs text-destructive">{st.message}</div>}
                </div>
                {it.kind === 'container' && !it.blocked && (
                  <TextInput
                    label={`Harbor name for ${it.source}`}
                    isLabelHidden
                    size="sm"
                    width={160}
                    value={it.name}
                    onChange={(v) => setNames((n) => ({ ...n, [it.key]: v.toLowerCase() }))}
                    isDisabled={!on || running || finished}
                    status={bad && on ? { type: 'error' } : undefined}
                    containerClassName="shrink-0"
                    controlClassName="font-mono"
                  />
                )}
                <span className="mt-1 w-4 shrink-0">
                  {st?.state === 'running' && <Loader2 className="size-4 animate-spin text-brand" />}
                  {st?.state === 'done' && <CheckCircle2 className="size-4 text-success" />}
                  {st?.state === 'error' && <XCircle className="size-4 text-destructive" />}
                </span>
              </div>
            )
          })}
        </div>
        {invalid.length > 0 && <p className="text-xs text-destructive">Names must be unique, lowercase letters, digits, - and _.</p>}
      </div>

      <div className="flex items-center gap-2 border-t bg-muted/30 px-5 py-3">
        <span className="text-sm text-muted-foreground">
          {finished ? (
            <>
              {done} imported{failed > 0 && <span className="text-destructive">, {failed} failed</span>}
            </>
          ) : (
            `${selected.length} selected`
          )}
        </span>
        <div className="ml-auto flex gap-2">
          {finished ? (
            <Button
              variant="primary"
              label="Go to canvas"
              onClick={() => {
                onClose()
                navigate('/')
              }}
            />
          ) : (
            <>
              <Button variant="ghost" label="Cancel" onClick={onClose} isDisabled={running} />
              <Button
                variant="primary"
                label={`Import ${selected.length}`}
                onClick={run}
                isLoading={running}
                isDisabled={selected.length === 0 || invalid.length > 0}
              />
            </>
          )}
        </div>
      </div>
    </>
  )
}
