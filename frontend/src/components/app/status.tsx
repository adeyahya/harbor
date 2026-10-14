import { cn } from '@/lib/utils'

type Tone = 'success' | 'warning' | 'danger' | 'info' | 'neutral'

const META: Record<string, { label: string; tone: Tone; pulse?: boolean }> = {
  running: { label: 'Online', tone: 'success' },
  success: { label: 'Success', tone: 'success' },
  healthy: { label: 'Healthy', tone: 'success' },
  unhealthy: { label: 'Degraded', tone: 'warning' },
  restarting: { label: 'Restarting', tone: 'warning', pulse: true },
  paused: { label: 'Paused', tone: 'warning' },
  created: { label: 'Created', tone: 'info' },
  in_progress: { label: 'Deploying', tone: 'info', pulse: true },
  failed: { label: 'Failed', tone: 'danger' },
  dead: { label: 'Crashed', tone: 'danger' },
  exited: { label: 'Stopped', tone: 'neutral' },
  stopped: { label: 'Stopped', tone: 'neutral' },
  down: { label: 'Not deployed', tone: 'neutral' },
  not_deployed: { label: 'Not deployed', tone: 'neutral' },
  in_use: { label: 'In use', tone: 'info' },
  unused: { label: 'Unused', tone: 'neutral' },
}

const dot: Record<Tone, string> = {
  success: 'bg-success shadow-[0_0_0_3px_color-mix(in_oklab,var(--success)_22%,transparent)]',
  warning: 'bg-warning shadow-[0_0_0_3px_color-mix(in_oklab,var(--warning)_22%,transparent)]',
  danger: 'bg-destructive shadow-[0_0_0_3px_color-mix(in_oklab,var(--destructive)_22%,transparent)]',
  info: 'bg-brand shadow-[0_0_0_3px_color-mix(in_oklab,var(--brand)_22%,transparent)]',
  neutral: 'bg-muted-foreground/50',
}

const text: Record<Tone, string> = {
  success: 'text-success',
  warning: 'text-warning',
  danger: 'text-destructive',
  info: 'text-brand',
  neutral: 'text-muted-foreground',
}

function meta(status: string) {
  // "running" updates are in progress, not "online".
  return META[status] ?? { label: status.replace(/_/g, ' '), tone: 'neutral' as Tone }
}

export function StatusDot({ status, className }: { status: string; className?: string }) {
  const m = meta(status)
  return <span className={cn('inline-block size-2 shrink-0 rounded-full', dot[m.tone], m.pulse && 'animate-pulse', className)} />
}

/** Railway-style status: a glowing dot followed by a short label. */
export function Status({ status, className }: { status: string; className?: string }) {
  const m = meta(status)
  return (
    <span className={cn('inline-flex items-center gap-2 text-xs font-medium capitalize', text[m.tone], className)}>
      <StatusDot status={status} />
      {m.label}
    </span>
  )
}

/** Status for an update/deployment record, where "running" means in progress. */
export function UpdateStatus({ status, className }: { status: string; className?: string }) {
  return <Status status={status === 'running' ? 'in_progress' : status} className={className} />
}

const pill: Record<Tone, string> = {
  success: 'border-success/30 bg-success/10 text-success',
  warning: 'border-warning/30 bg-warning/10 text-warning',
  danger: 'border-destructive/30 bg-destructive/10 text-destructive',
  info: 'border-brand/30 bg-brand/10 text-brand',
  neutral: 'border-border bg-muted text-muted-foreground',
}

/** Uppercase pill, like Railway's ACTIVE / REMOVED deployment labels. */
export function StatusPill({ status, label, className }: { status: string; label?: string; className?: string }) {
  const m = meta(status === 'running' ? 'in_progress' : status)
  return (
    <span className={cn('inline-flex h-5 items-center rounded-md border px-1.5 text-[10px] font-semibold tracking-wider uppercase', pill[m.tone], className)}>
      {label ?? m.label}
    </span>
  )
}
