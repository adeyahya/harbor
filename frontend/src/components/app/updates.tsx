import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CheckCircle2, ChevronDown, ChevronRight, Loader2, X, XCircle } from 'lucide-react'
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { toast } from 'sonner'
import { api, type Update } from '@/api'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { duration, timeAgo } from '@/lib/format'
import { cn } from '@/lib/utils'
import { EmptyState, Loading } from './page'
import { StatusPill, UpdateStatus } from './status'

/**
 * Mutating operations return an Update record and keep running on the
 * server. Started actions are pinned to a tray in the corner that streams
 * their output until dismissed.
 */
const UpdatesContext = createContext<{ track: (u: Update) => void; open: (id: number) => void } | null>(null)

export function UpdatesProvider({ children }: { children: ReactNode }) {
  const [tracked, setTracked] = useState<number[]>([])
  const [viewing, setViewing] = useState<number | null>(null)
  const track = useCallback((u: Update) => setTracked((t) => [u.id, ...t.filter((id) => id !== u.id)].slice(0, 3)), [])
  const dismiss = (id: number) => setTracked((t) => t.filter((x) => x !== id))

  return (
    <UpdatesContext.Provider value={{ track, open: setViewing }}>
      {children}
      <div className="pointer-events-none fixed right-4 bottom-4 z-[60] flex w-[min(28rem,calc(100vw-2rem))] flex-col gap-2">
        {tracked.map((id) => (
          <TrayItem key={id} id={id} onDismiss={() => dismiss(id)} />
        ))}
      </div>
      <UpdateDialog id={viewing} onClose={() => setViewing(null)} />
    </UpdatesContext.Provider>
  )
}

function useUpdatesContext() {
  const ctx = useContext(UpdatesContext)
  if (!ctx) throw new Error('UpdatesProvider missing')
  return ctx
}

export const useOpenUpdate = () => useUpdatesContext().open

/** POSTs (or DELETEs) an action endpoint and tracks the resulting update. */
export function useRunAction() {
  const { track } = useUpdatesContext()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ path, method = 'post' }: { path: string; method?: 'post' | 'del' }) =>
      method === 'del' ? api.del<Update>(path) : api.post<Update>(path),
    onSuccess: (u) => {
      track(u)
      qc.invalidateQueries({ queryKey: ['updates'] })
    },
    onError: (e) => toast.error(e.message),
  })
}

export function useUpdate(id: number | null) {
  const qc = useQueryClient()
  const query = useQuery({
    queryKey: ['update', id],
    queryFn: () => api.get<Update>(`/updates/${id}`),
    enabled: id !== null,
    refetchInterval: (q) => (q.state.data?.status === 'running' || !q.state.data ? 800 : false),
  })
  const status = query.data?.status
  const prev = useRef(status)
  useEffect(() => {
    // When an operation finishes, everything it touched may have changed.
    if (prev.current === 'running' && status && status !== 'running') {
      qc.invalidateQueries({ predicate: (q) => q.queryKey[0] !== 'update' })
    }
    prev.current = status
  }, [status, qc])
  return query
}

export function LogBlock({ log, className, follow = true }: { log: string; className?: string; follow?: boolean }) {
  const ref = useRef<HTMLPreElement>(null)
  useEffect(() => {
    const el = ref.current
    if (el && follow) el.scrollTop = el.scrollHeight
  }, [log, follow])
  return (
    <pre ref={ref} className={cn('scrollbar-thin overflow-auto bg-log px-4 py-3 font-mono text-[12px] leading-5 whitespace-pre-wrap text-foreground/85', className)}>
      {log ? (
        log.split('\n').map((line, i) => (
          <div key={i} className={cn(line.startsWith('ERROR') && 'text-destructive', line.startsWith('$ ') && 'text-brand')}>
            {line || ' '}
          </div>
        ))
      ) : (
        <span className="text-muted-foreground">Waiting for output…</span>
      )}
    </pre>
  )
}

function UpdateTitle({ u }: { u: Update }) {
  return (
    <span className="min-w-0 truncate">
      <span className="font-medium capitalize">{u.operation}</span> <span className="text-muted-foreground">{u.target_name}</span>
    </span>
  )
}

function StatusIcon({ status }: { status: Update['status'] }) {
  if (status === 'running') return <Loader2 className="size-4 shrink-0 animate-spin text-brand" />
  if (status === 'success') return <CheckCircle2 className="size-4 shrink-0 text-success" />
  return <XCircle className="size-4 shrink-0 text-destructive" />
}

function TrayItem({ id, onDismiss }: { id: number; onDismiss: () => void }) {
  const { data } = useUpdate(id)
  const [expanded, setExpanded] = useState(true)
  if (!data) return null
  return (
    <div className="pointer-events-auto overflow-hidden rounded-xl border bg-popover shadow-2xl shadow-black/30 animate-in fade-in slide-in-from-bottom-2">
      <div className="flex items-center gap-2.5 px-3 py-2.5 text-sm">
        <StatusIcon status={data.status} />
        <UpdateTitle u={data} />
        <span className="ml-auto shrink-0 font-mono text-[11px] text-muted-foreground">{duration(data.started_at, data.finished_at)}</span>
        <button className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground" onClick={() => setExpanded((e) => !e)} aria-label={expanded ? 'Collapse' : 'Expand'}>
          <ChevronDown className={cn('size-4 transition-transform', !expanded && 'rotate-180')} />
        </button>
        <button className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground" onClick={onDismiss} aria-label="Dismiss">
          <X className="size-4" />
        </button>
      </div>
      {expanded && <LogBlock log={data.log} className="max-h-56 border-t" />}
    </div>
  )
}

function UpdateDialog({ id, onClose }: { id: number | null; onClose: () => void }) {
  const { data } = useUpdate(id)
  return (
    <Dialog open={id !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex max-h-[85vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-3xl">
        {data ? (
          <>
            <DialogHeader className="border-b px-5 py-4">
              <DialogTitle className="flex items-center gap-3">
                <UpdateTitle u={data} />
                <UpdateStatus status={data.status} />
              </DialogTitle>
              <DialogDescription>
                {data.target_type} · by {data.username} · {timeAgo(data.started_at)} · took {duration(data.started_at, data.finished_at)}
              </DialogDescription>
            </DialogHeader>
            <LogBlock log={data.log} className="min-h-48 flex-1" />
          </>
        ) : (
          <>
            <DialogTitle className="sr-only">Loading update</DialogTitle>
            <Loading />
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}

function useUpdatesList(targetType?: string, targetName?: string, limit = 50) {
  const params = new URLSearchParams({ limit: String(limit) })
  if (targetType) params.set('target_type', targetType)
  if (targetName) params.set('target_name', targetName)
  return useQuery({
    queryKey: ['updates', targetType, targetName, limit],
    queryFn: () => api.get<Update[]>(`/updates?${params}`),
    refetchInterval: 4000,
  })
}

function ExpandedLog({ id }: { id: number }) {
  const { data } = useUpdate(id)
  return <LogBlock log={data?.log ?? ''} className="max-h-80 border-t" />
}

/**
 * Railway-style deployment history for one resource. The latest successful
 * deploy is marked ACTIVE; rows expand to show their logs.
 */
export function DeploymentHistory({ targetType, targetName }: { targetType: string; targetName: string }) {
  const { data, isLoading } = useUpdatesList(targetType, targetName)
  const [open, setOpen] = useState<number | null>(null)
  if (isLoading) return <Loading />
  if (!data?.length) return <EmptyState title="No deployments yet">Deploy this service and its history will show up here.</EmptyState>
  // The newest successful lifecycle change decides what's live: a deploy is
  // ACTIVE unless a later down/destroy removed it; older deploys are REMOVED.
  const latest = data.find((u) => ['deploy', 'down', 'destroy'].includes(u.operation) && u.status === 'success')
  const active = latest?.operation === 'deploy' ? latest.id : undefined
  return (
    <div className="space-y-2">
      {data.map((u) => (
        <div key={u.id} className={cn('overflow-hidden rounded-xl border bg-card transition-colors', u.id === active && 'border-success/40')}>
          <button className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-accent/40" onClick={() => setOpen(open === u.id ? null : u.id)}>
            <ChevronRight className={cn('size-4 shrink-0 text-muted-foreground transition-transform', open === u.id && 'rotate-90')} />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium capitalize">{u.operation}</span>
                {u.id === active ? (
                  <StatusPill status="success" label="Active" />
                ) : u.status !== 'success' ? (
                  <StatusPill status={u.status} />
                ) : (
                  u.operation === 'deploy' && <StatusPill status="removed" label="Removed" />
                )}
              </div>
              <div className="mt-0.5 text-xs text-muted-foreground">
                {timeAgo(u.started_at)} by {u.username} · {duration(u.started_at, u.finished_at)}
              </div>
            </div>
            <UpdateStatus status={u.status} className="hidden sm:inline-flex" />
          </button>
          {open === u.id && <ExpandedLog id={u.id} />}
        </div>
      ))}
    </div>
  )
}

/** Flat activity feed across all resources. */
export function ActivityFeed({ limit = 100, compact = false }: { limit?: number; compact?: boolean }) {
  const { data, isLoading } = useUpdatesList(undefined, undefined, limit)
  const open = useOpenUpdate()
  if (isLoading) return <Loading />
  if (!data?.length) return <EmptyState title="No activity yet">Deploys and other actions show up here with their full output.</EmptyState>
  return (
    <div className="divide-y">
      {data.map((u) => (
        <button key={u.id} onClick={() => open(u.id)} className={cn('flex w-full items-center gap-3 text-left transition-colors hover:bg-accent/40', compact ? 'px-4 py-2.5' : 'px-5 py-3')}>
          <StatusIcon status={u.status} />
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm">
              <span className="font-medium capitalize">{u.operation}</span> <span className="text-muted-foreground">{u.target_type}</span> <span className="font-medium">{u.target_name}</span>
            </div>
            {!compact && <div className="text-xs text-muted-foreground">by {u.username}</div>}
          </div>
          <span className="shrink-0 text-xs text-muted-foreground">{timeAgo(u.started_at)}</span>
          {!compact && <span className="hidden w-16 shrink-0 text-right font-mono text-[11px] text-muted-foreground sm:block">{duration(u.started_at, u.finished_at)}</span>}
        </button>
      ))}
    </div>
  )
}
