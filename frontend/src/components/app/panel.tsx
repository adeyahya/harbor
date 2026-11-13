import { Eye, EyeOff, FileCode2, Plus, Rows3, Trash2 } from 'lucide-react'
import { Button } from '@astryxdesign/core/Button'
import { Drawer, DrawerHeader } from '@astryxdesign/core/Drawer'
import { IconButton } from '@astryxdesign/core/IconButton'
import { Tab, TabList } from '@astryxdesign/core/TabList'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useNavigate, useSearchParams } from 'react-router'
import { cn } from '@/lib/utils'

/**
 * Right-hand panel that slides over the canvas, like Railway's service view.
 * It's non-modal so the canvas stays interactive; clicking another service
 * card swaps the panel's content.
 */
export function ServicePanel({
  icon,
  title,
  subtitle,
  actions,
  tabs,
  tab,
  onTabChange,
  footer,
  children,
  closeTo = '/',
}: {
  icon: ReactNode
  title: string
  subtitle: ReactNode
  actions?: ReactNode
  tabs: { id: string; label: string }[]
  tab: string
  onTabChange: (t: string) => void
  footer?: ReactNode
  children: ReactNode
  closeTo?: string
}) {
  const navigate = useNavigate()
  const close = () => navigate(closeTo)
  const closeRef = useRef(close)
  useEffect(() => {
    closeRef.current = close
  })

  // The drawer is non-modal, so dismissal on outside clicks is ours. Only a
  // click on the page behind closes the panel. Clicks on other service cards
  // switch it instead, and top-layer UI (this drawer, other dialogs, menus,
  // the command menu, toasts, the action tray) must not dismiss it. Astryx
  // overlays stay in the DOM where they're rendered, so exclude them by element.
  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Element | null
      if (!target?.closest?.('main') || target.closest('[data-service-card], dialog, [popover]')) return
      closeRef.current()
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [])

  return (
    <Drawer
      isOpen
      onOpenChange={(o) => !o && close()}
      label={title}
      hasScrim={false}
      padding={0}
      width="min(54rem, calc(100vw - 3rem))"
      experimental={{ isFullWidthOnMobile: true }}
      className="bg-background shadow-2xl shadow-black/40 lg:top-14 lg:h-[calc(100%-3.5rem)]"
    >
      <div className="flex h-full flex-col">
        <DrawerHeader
          className="px-5 pt-5 pb-3"
          startContent={<div className="flex size-10 shrink-0 items-center justify-center rounded-xl border bg-card text-brand [&_svg]:size-5">{icon}</div>}
          title={<span className="block truncate text-lg font-semibold">{title}</span>}
          subtitle={<div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">{subtitle}</div>}
          endContent={actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
          onOpenChange={(o) => !o && close()}
        />
        <div className="scrollbar-thin overflow-x-auto border-b px-3">
          <TabList value={tab} onChange={onTabChange} aria-label={`${title} sections`}>
            {tabs.map((t) => (
              <Tab key={t.id} value={t.id} label={t.label} />
            ))}
          </TabList>
        </div>
        <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto px-5 py-5">{children}</div>
        {footer}
      </div>
    </Drawer>
  )
}

/** Tab state kept in the URL (?tab=) so panels deep-link. */
export function usePanelTab<T extends string>(tabs: readonly T[], fallback: T): [T, (t: string) => void] {
  const [params, setParams] = useSearchParams()
  const raw = params.get('tab') as T | null
  const tab = raw && tabs.includes(raw) ? raw : fallback
  const setTab = (t: string) =>
    setParams(
      (p) => {
        p.set('tab', t)
        return p
      },
      { replace: true },
    )
  return [tab, setTab]
}

/** Sticky bar shown while a panel has staged changes, like Railway's "Apply changes". */
export function ChangesBar({ count, onDiscard, onSave, onDeploy, saving }: { count: number; onDiscard: () => void; onSave: () => void; onDeploy: () => void; saving: boolean }) {
  if (count === 0) return null
  return (
    <div className="flex items-center gap-2 border-t bg-card px-5 py-3 animate-rise-in">
      <span className="size-2 rounded-full bg-brand" />
      <span className="text-sm">
        {count} unsaved change{count === 1 ? '' : 's'}
      </span>
      <div className="ml-auto flex gap-2">
        <Button variant="ghost" size="sm" label="Discard" onClick={onDiscard} />
        <Button variant="secondary" size="sm" label="Save" onClick={onSave} isDisabled={saving} />
        <Button variant="primary" size="sm" label="Save & deploy" onClick={onDeploy} isLoading={saving} />
      </div>
    </div>
  )
}

export function SettingsSection({ title, description, children, danger }: { title: string; description?: ReactNode; children: ReactNode; danger?: boolean }) {
  return (
    <section className={cn('rounded-xl border bg-card', danger && 'border-destructive/30')}>
      <div className="border-b px-4 py-3">
        <h3 className={cn('text-sm font-semibold', danger && 'text-destructive')}>{title}</h3>
        {description && <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>}
      </div>
      <div className="p-4">{children}</div>
    </section>
  )
}

/** Monospace editor with a line-number gutter. */
export function CodeEditor({ value, onChange, placeholder, minRows = 18, onSave }: { value: string; onChange: (v: string) => void; placeholder?: string; minRows?: number; onSave?: () => void }) {
  const gutter = useRef<HTMLDivElement>(null)
  const lineCount = Math.max(value.split('\n').length, minRows)
  return (
    <div className="flex overflow-hidden rounded-lg border bg-log font-mono text-[12.5px] leading-5 focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/25">
      <div ref={gutter} className="shrink-0 overflow-hidden border-r py-3 pr-3 pl-3 text-right text-muted-foreground/50 select-none" aria-hidden>
        {Array.from({ length: lineCount }, (_, i) => (
          <div key={i}>{i + 1}</div>
        ))}
      </div>
      <textarea
        value={value}
        spellCheck={false}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        onScroll={(e) => {
          if (gutter.current) gutter.current.scrollTop = e.currentTarget.scrollTop
        }}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === 's') {
            e.preventDefault()
            onSave?.()
          } else if (e.key === 'Tab' && !e.shiftKey) {
            // Indent with two spaces instead of moving focus (YAML-friendly).
            e.preventDefault()
            const el = e.currentTarget
            const { selectionStart: s, selectionEnd: end } = el
            onChange(value.slice(0, s) + '  ' + value.slice(end))
            requestAnimationFrame(() => el.setSelectionRange(s + 2, s + 2))
          }
        }}
        rows={lineCount}
        className="min-w-0 flex-1 resize-none bg-transparent px-3 py-3 whitespace-pre outline-none placeholder:text-muted-foreground"
      />
    </div>
  )
}

const VAR_LINE = /^\s*([A-Za-z_][A-Za-z0-9_.-]*)\s*=(.*)$/

interface VarLine {
  key: string
  value: string
}

/** Parses KEY=value lines; non-variable lines (comments, blanks) are kept verbatim. */
function parseVars(text: string): (VarLine | string)[] {
  if (text === '') return []
  const lines = text.endsWith('\n') ? text.slice(0, -1).split('\n') : text.split('\n')
  return lines.map((line) => {
    const m = VAR_LINE.exec(line)
    return m ? { key: m[1], value: m[2] } : line
  })
}

function serializeVars(lines: (VarLine | string)[]): string {
  if (!lines.length) return ''
  return lines.map((l) => (typeof l === 'string' ? l : `${l.key}=${l.value}`)).join('\n') + '\n'
}

/**
 * Railway-style variables table backed by a plain `KEY=value` text blob,
 * with a raw editor toggle. Comments survive edits made in the table.
 */
export function VariablesEditor({
  value,
  onChange,
  description,
  secret = true,
  keyPlaceholder = 'VARIABLE_NAME',
  noun = 'variable',
}: {
  value: string
  onChange: (v: string) => void
  description?: ReactNode
  /** Mask values until revealed (off for non-secret pairs like labels). */
  secret?: boolean
  keyPlaceholder?: string
  noun?: string
}) {
  const [raw, setRaw] = useState(false)
  const [revealed, setRevealed] = useState<Set<number>>(new Set())
  const lines = parseVars(value)
  const vars = lines.map((l, i) => ({ l, i })).filter((x): x is { l: VarLine; i: number } => typeof x.l !== 'string')

  const update = (index: number, patch: Partial<VarLine>) => {
    const next = [...lines]
    next[index] = { ...(next[index] as VarLine), ...patch }
    onChange(serializeVars(next))
  }
  const remove = (index: number) => onChange(serializeVars(lines.filter((_, i) => i !== index)))
  const add = () => onChange(serializeVars([...lines, { key: '', value: '' }]))
  const toggle = (i: number) =>
    setRevealed((s) => {
      const n = new Set(s)
      if (n.has(i)) n.delete(i)
      else n.add(i)
      return n
    })

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          {description ?? (
            <>
              {vars.length} {noun}
              {vars.length === 1 ? '' : 's'}
            </>
          )}
        </p>
        <div className="flex gap-2">
          <Button variant="secondary" size="sm" icon={raw ? <Rows3 /> : <FileCode2 />} label={raw ? 'Table view' : 'Raw editor'} onClick={() => setRaw((r) => !r)} />
          {!raw && <Button variant="primary" size="sm" icon={<Plus />} label={`New ${noun}`} onClick={add} />}
        </div>
      </div>
      {raw ? (
        <CodeEditor value={value} onChange={onChange} placeholder={'KEY=value\n# comments are allowed'} minRows={12} />
      ) : vars.length === 0 ? (
        <div className="rounded-xl border border-dashed px-6 py-10 text-center">
          <p className="text-sm font-medium">No {noun}s</p>
          {secret && <p className="mt-1 text-sm text-muted-foreground">Add environment variables to configure this service.</p>}
          <Button variant="secondary" size="sm" className="mt-4" icon={<Plus />} label={`Add ${noun}`} onClick={add} />
        </div>
      ) : (
        <div className="divide-y overflow-hidden rounded-xl border bg-card">
          {vars.map(({ l, i }) => (
            <div key={i} className="group flex items-center gap-2 px-2 py-1.5">
              <input
                value={l.key}
                onChange={(e) => update(i, { key: e.target.value.replace(/[^A-Za-z0-9_.-]/g, '') })}
                placeholder={keyPlaceholder}
                autoFocus={l.key === '' && l.value === ''}
                className="h-8 w-[38%] min-w-0 rounded-md bg-transparent px-2 font-mono text-[12.5px] font-medium outline-none placeholder:text-muted-foreground/60 hover:bg-accent/50 focus:bg-accent/60"
              />
              <input
                value={l.value}
                type={!secret || revealed.has(i) || l.value === '' ? 'text' : 'password'}
                onChange={(e) => update(i, { value: e.target.value })}
                placeholder="value"
                className="h-8 min-w-0 flex-1 rounded-md bg-transparent px-2 font-mono text-[12.5px] text-muted-foreground outline-none placeholder:text-muted-foreground/60 hover:bg-accent/50 focus:bg-accent/60 focus:text-foreground"
              />
              {secret && (
                <IconButton variant="ghost" size="sm" label={revealed.has(i) ? 'Hide value' : 'Show value'} tooltip={revealed.has(i) ? 'Hide value' : 'Show value'} icon={revealed.has(i) ? <EyeOff /> : <Eye />} onClick={() => toggle(i)} />
              )}
              <IconButton variant="ghost" size="sm" className="text-muted-foreground hover:text-destructive" label={`Remove ${noun}`} tooltip={`Remove ${noun}`} icon={<Trash2 />} onClick={() => remove(i)} />
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
