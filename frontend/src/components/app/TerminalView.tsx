import { FitAddon } from '@xterm/addon-fit'
import { Terminal as XTerm, type ITheme } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { RefreshCw, SquareTerminal } from 'lucide-react'
import { useTheme } from 'next-themes'
import { useEffect, useRef, useState } from 'react'
import { EmptyState } from '@/components/app/page'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { cn } from '@/lib/utils'

const SHELLS = [
  { value: 'auto', label: 'Auto (bash or sh)' },
  { value: '/bin/bash', label: 'bash' },
  { value: '/bin/sh', label: 'sh' },
  { value: '/bin/ash', label: 'ash' },
  { value: '/bin/zsh', label: 'zsh' },
  { value: '/bin/fish', label: 'fish' },
]

const DARK: ITheme = { background: '#0e0c15', foreground: '#eeedf3', cursor: '#a48cf0', selectionBackground: '#a48cf055' }
const LIGHT: ITheme = { background: '#fbfbfc', foreground: '#13111c', cursor: '#6a4fc2', selectionBackground: '#6a4fc233' }

type Status = { kind: 'connecting' } | { kind: 'open' } | { kind: 'closed'; message: string }

/** Interactive shell in a running container, over a WebSocket. */
export default function TerminalView({ containerId, running, className }: { containerId: string; running: boolean; className?: string }) {
  const [shell, setShell] = useState('auto')
  const [user, setUser] = useState('')
  const [userDraft, setUserDraft] = useState('')
  const [session, setSession] = useState(0)
  const [status, setStatus] = useState<Status>({ kind: 'connecting' })
  const host = useRef<HTMLDivElement>(null)
  const term = useRef<XTerm | null>(null)
  const { resolvedTheme } = useTheme()

  useEffect(() => {
    if (term.current) term.current.options.theme = resolvedTheme === 'light' ? LIGHT : DARK
  }, [resolvedTheme])

  useEffect(() => {
    if (!running || !host.current) return
    setStatus({ kind: 'connecting' })
    const t = new XTerm({
      cursorBlink: true,
      fontFamily: '"JetBrains Mono Variable", ui-monospace, monospace',
      fontSize: 13,
      scrollback: 5000,
      theme: document.documentElement.classList.contains('dark') ? DARK : LIGHT,
    })
    const fit = new FitAddon()
    t.loadAddon(fit)
    t.open(host.current)
    fit.fit()
    term.current = t

    const params = new URLSearchParams({ shell, user, cols: String(t.cols), rows: String(t.rows) })
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
    const ws = new WebSocket(`${proto}//${location.host}/api/docker/containers/${encodeURIComponent(containerId)}/terminal?${params}`)
    ws.binaryType = 'arraybuffer'
    const encoder = new TextEncoder()
    let ended = false
    let opened = false
    const end = (message: string) => {
      if (ended) return
      ended = true
      setStatus({ kind: 'closed', message })
      t.write(`\r\n\x1b[2m${message}\x1b[0m\r\n`)
    }

    ws.onopen = () => {
      opened = true
      setStatus({ kind: 'open' })
      t.focus()
    }
    ws.onmessage = (e: MessageEvent<ArrayBuffer | string>) => {
      if (typeof e.data !== 'string') {
        t.write(new Uint8Array(e.data))
        return
      }
      const msg = JSON.parse(e.data) as { type: 'exit'; code: number } | { type: 'error'; message: string }
      if (msg.type === 'exit') end(`Shell exited with code ${msg.code}.`)
      else end(msg.message)
    }
    // Browsers don't expose why an upgrade was refused, so that case is generic.
    ws.onclose = () => end(opened ? 'Disconnected.' : "Couldn't open a terminal. Check that the container is still running.")
    const input = t.onData((d) => ws.readyState === WebSocket.OPEN && ws.send(encoder.encode(d)))
    const resize = t.onResize(({ cols, rows }) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ type: 'resize', cols, rows })))
    const observer = new ResizeObserver(() => {
      try {
        fit.fit()
      } catch {
        // Hidden (zero-size) while switching tabs.
      }
    })
    observer.observe(host.current)

    return () => {
      ended = true
      observer.disconnect()
      input.dispose()
      resize.dispose()
      ws.close()
      t.dispose()
      term.current = null
    }
  }, [containerId, running, shell, user, session])

  if (!running) {
    return (
      <div className={cn('rounded-xl border bg-card', className)}>
        <EmptyState icon={<SquareTerminal />} title="Container isn't running">
          Start the container to open a terminal in it.
        </EmptyState>
      </div>
    )
  }

  return (
    <div className={cn('flex flex-col overflow-hidden rounded-xl border bg-log', className)}>
      <div className="flex flex-wrap items-center gap-2 border-b bg-card px-2.5 py-2">
        <Select value={shell} onValueChange={setShell}>
          <SelectTrigger size="sm" className="w-44" aria-label="Shell">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SHELLS.map((s) => (
              <SelectItem key={s.value} value={s.value}>
                {s.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            setUser(userDraft.trim())
          }}
        >
          <input
            value={userDraft}
            onChange={(e) => setUserDraft(e.target.value)}
            onBlur={() => setUser(userDraft.trim())}
            placeholder="User (default)"
            aria-label="Run as user"
            className="h-8 w-36 rounded-lg border bg-background px-2.5 font-mono text-xs outline-none placeholder:font-sans placeholder:text-muted-foreground focus:border-ring focus:ring-3 focus:ring-ring/30"
          />
        </form>
        <span className={cn('ml-auto flex items-center gap-1.5 px-1 text-xs', status.kind === 'open' ? 'text-success' : 'text-muted-foreground')}>
          <span className={cn('size-1.5 rounded-full', status.kind === 'open' ? 'animate-pulse bg-success' : 'bg-muted-foreground/60')} />
          {status.kind === 'open' ? 'Connected' : status.kind === 'connecting' ? 'Connecting…' : 'Closed'}
        </span>
        {status.kind === 'closed' && (
          <Button size="sm" variant="ghost" onClick={() => setSession((n) => n + 1)}>
            <RefreshCw /> New session
          </Button>
        )}
      </div>
      <div className="min-h-0 flex-1 p-2">
        <div ref={host} className="h-full w-full" />
      </div>
    </div>
  )
}
