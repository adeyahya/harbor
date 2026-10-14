import { ArrowDown, RefreshCw, Search, Trash2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { cn } from '@/lib/utils'

interface Line {
  id: number
  time: string
  text: string
  stderr: boolean
}

const MAX_LINES = 5000
const TS = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(\.\d+)?Z\s?/

function splitTimestamp(raw: string): { time: string; text: string } {
  const m = TS.exec(raw)
  if (!m) return { time: '', text: raw }
  const local = new Date(`${m[1]}Z`).toLocaleTimeString(undefined, { hour12: false })
  return { time: local, text: raw.slice(m[0].length) }
}

/** Live container logs streamed over server-sent events. */
export function LogViewer({ containerId, className }: { containerId: string; className?: string }) {
  const [lines, setLines] = useState<Line[]>([])
  const [tail, setTail] = useState('500')
  const [connected, setConnected] = useState(false)
  const [follow, setFollow] = useState(true)
  const [filter, setFilter] = useState('')
  const [session, setSession] = useState(0)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let next = 0
    const es = new EventSource(`/api/docker/containers/${containerId}/logs?tail=${tail}&follow=true&timestamps=true`)
    const push = (stderr: boolean) => (e: MessageEvent<string>) => {
      const incoming = e.data.split('\n').filter((l, i, arr) => l !== '' || i < arr.length - 1)
      setLines((prev) => {
        const out = prev.concat(incoming.map((raw) => ({ id: next++, stderr, ...splitTimestamp(raw) })))
        return out.length > MAX_LINES ? out.slice(out.length - MAX_LINES) : out
      })
    }
    es.addEventListener('stdout', push(false))
    es.addEventListener('stderr', push(true))
    es.onopen = () => {
      setLines([])
      setConnected(true)
    }
    // The stream ends when the container stops. Don't let EventSource
    // auto-reconnect: it would replay the tail and duplicate lines.
    es.onerror = () => {
      setConnected(false)
      es.close()
    }
    return () => es.close()
  }, [containerId, tail, session])

  useEffect(() => {
    if (follow && ref.current) ref.current.scrollTop = ref.current.scrollHeight
  }, [lines, follow])

  const q = filter.toLowerCase()
  const shown = q ? lines.filter((l) => l.text.toLowerCase().includes(q)) : lines

  return (
    <div className={cn('relative flex flex-col overflow-hidden rounded-xl border bg-log', className)}>
      <div className="flex flex-wrap items-center gap-2 border-b bg-card px-2.5 py-2">
        <div className="relative min-w-40 flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter logs"
            className="h-8 w-full rounded-lg border bg-background pr-2 pl-8 text-sm outline-none placeholder:text-muted-foreground focus:border-ring focus:ring-3 focus:ring-ring/30"
          />
        </div>
        <Select value={tail} onValueChange={setTail}>
          <SelectTrigger size="sm" className="w-32">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {['100', '500', '1000', '5000', 'all'].map((t) => (
              <SelectItem key={t} value={t}>
                {t === 'all' ? 'All lines' : `Last ${t}`}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <span className={cn('flex items-center gap-1.5 px-1 text-xs', connected ? 'text-success' : 'text-muted-foreground')}>
          <span className={cn('size-1.5 rounded-full', connected ? 'animate-pulse bg-success' : 'bg-muted-foreground/60')} />
          {connected ? 'Live' : 'Disconnected'}
        </span>
        {!connected && (
          <Button size="sm" variant="ghost" onClick={() => setSession((n) => n + 1)}>
            <RefreshCw /> Reconnect
          </Button>
        )}
        <Button size="icon-sm" variant="ghost" title="Clear" onClick={() => setLines([])}>
          <Trash2 />
        </Button>
      </div>

      <div
        ref={ref}
        onScroll={(e) => {
          const el = e.currentTarget
          setFollow(el.scrollHeight - el.scrollTop - el.clientHeight < 24)
        }}
        className="scrollbar-thin min-h-0 flex-1 overflow-auto py-2 font-mono text-[12px] leading-5"
      >
        {shown.length === 0 ? (
          <div className="px-4 text-muted-foreground">{connected ? (q ? 'No matching lines.' : 'No log output yet.') : 'Not connected.'}</div>
        ) : (
          shown.map((l) => (
            <div key={l.id} className="flex gap-4 px-4 hover:bg-accent/40">
              <span className="w-16 shrink-0 text-muted-foreground/70 select-none">{l.time}</span>
              <span className={cn('min-w-0 flex-1 break-all whitespace-pre-wrap', l.stderr ? 'text-warning' : 'text-foreground/90')}>{l.text}</span>
            </div>
          ))
        )}
      </div>

      {!follow && (
        <Button
          size="sm"
          variant="secondary"
          className="absolute bottom-3 left-1/2 -translate-x-1/2 shadow-lg"
          onClick={() => {
            setFollow(true)
            if (ref.current) ref.current.scrollTop = ref.current.scrollHeight
          }}
        >
          <ArrowDown /> Jump to latest
        </Button>
      )}
    </div>
  )
}
