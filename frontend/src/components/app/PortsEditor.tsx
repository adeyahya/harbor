import { useQuery } from '@tanstack/react-query'
import { ArrowRight, Check, FileCode2, Loader2, Plus, Rows3, Sparkles, Trash2, TriangleAlert } from 'lucide-react'
import { useEffect, useState } from 'react'
import { api, type PortsResponse, type PortStatus } from '@/api'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { CodeEditor } from './panel'

interface Mapping {
  ip: string
  host: string
  container: string
  proto: string
}

/**
 * Parses port lines (`[ip:]host:container[/proto]` or a bare `container`);
 * other lines (comments, blanks) are kept verbatim so the table never loses
 * anything written in the raw editor.
 */
function parse(text: string): (Mapping | string)[] {
  if (text === '') return []
  const lines = text.endsWith('\n') ? text.slice(0, -1).split('\n') : text.split('\n')
  return lines.map((line) => {
    const t = line.trim()
    if (!t || t.startsWith('#')) return line
    const [spec, proto = 'tcp'] = t.split('/')
    const parts = spec.split(':')
    // Ports must be numeric and in range (empty while typing); a bind
    // address must look like an IPv4 address. Anything else stays a raw line
    // and is flagged as invalid.
    const isPort = (p: string) => /^\d*$/.test(p) && (p === '' || Number(p) <= 65535)
    if (parts.slice(-2).some((p) => !isPort(p)) || !['tcp', 'udp', 'sctp'].includes(proto)) return line
    if (parts.length === 1) return { ip: '', host: '', container: parts[0], proto }
    if (parts.length === 2) return { ip: '', host: parts[0], container: parts[1], proto }
    if (parts.length === 3 && /^\d{1,3}(\.\d{1,3}){3}$/.test(parts[0])) return { ip: parts[0], host: parts[1], container: parts[2], proto }
    return line
  })
}

function serialize(lines: (Mapping | string)[]): string {
  if (!lines.length) return ''
  const fmt = (m: Mapping) => `${m.ip ? `${m.ip}:` : ''}${m.host ? `${m.host}:` : ''}${m.container}${m.proto && m.proto !== 'tcp' ? `/${m.proto}` : ''}`
  return lines.map((l) => (typeof l === 'string' ? l : fmt(l))).join('\n') + '\n'
}

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms)
    return () => clearTimeout(t)
  }, [value, ms])
  return v
}

function HostStatus({ status, checking }: { status?: PortStatus; checking: boolean }) {
  if (checking && !status) return <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
  if (!status) return <span className="size-3.5" />
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {status.available ? (
          <Check className="size-3.5 text-success" aria-label="Port is free" />
        ) : (
          <TriangleAlert className="size-3.5 text-warning" aria-label={`In use by ${status.used_by}`} />
        )}
      </TooltipTrigger>
      <TooltipContent>{status.available ? 'Free on this host' : `In use by ${status.used_by}`}</TooltipContent>
    </Tooltip>
  )
}

const portInput =
  'h-8 w-full min-w-0 rounded-md border bg-background px-2 font-mono text-[12.5px] outline-none placeholder:text-muted-foreground/60 focus:border-ring focus:ring-3 focus:ring-ring/25'

/**
 * Port mappings as rows, with live checks against ports already taken on
 * the host and suggestions for free ones. Backed by the plain text format
 * the API stores.
 */
export function PortsEditor({ value, onChange, owner, image }: { value: string; onChange: (v: string) => void; owner: string; image: string }) {
  const [raw, setRaw] = useState(false)
  const lines = parse(value)
  const rows = lines.map((l, i) => ({ l, i })).filter((x): x is { l: Mapping; i: number } => typeof x.l !== 'string')
  const invalid = lines.filter((l): l is string => typeof l === 'string' && l.trim() !== '' && !l.trim().startsWith('#'))

  const debounced = useDebounced(value, 300)
  const debouncedRows = parse(debounced).filter((l): l is Mapping => typeof l !== 'string')
  const check = [...new Set(debouncedRows.filter((m) => /^\d+$/.test(m.host)).map((m) => `${m.host}/${m.proto || 'tcp'}`))].join(',')
  // Suggest ports close to what's being typed, else the container port.
  const near =
    debouncedRows.find((m) => Number(m.host) >= 1024)?.host ?? debouncedRows.find((m) => Number(m.container) >= 1024)?.container ?? '8000'
  const exclude = debouncedRows.map((m) => m.host).filter(Boolean).join(',')
  const ports = useQuery({
    queryKey: ['ports', owner, check, near, exclude],
    queryFn: () => api.get<PortsResponse>(`/ports?${new URLSearchParams({ check, suggest: '4', near, exclude, owner })}`),
    staleTime: 5000,
    placeholderData: (prev) => prev,
  })
  const exposed = useQuery({
    queryKey: ['image-ports', image],
    queryFn: () => api.get<{ local: boolean; exposed: string[] }>(`/docker/image-ports?${new URLSearchParams({ image })}`),
    enabled: !!image,
    staleTime: 60_000,
  })

  const statusOf = (m: Mapping) => ports.data?.checked.find((c) => String(c.port) === m.host && c.protocol === (m.proto || 'tcp'))
  // Suggestions not already typed into another row.
  const free = (ports.data?.suggestions ?? []).filter((p) => !rows.some(({ l }) => l.host === String(p)))
  const unmapped = (exposed.data?.exposed ?? []).filter((e) => {
    const [port, proto = 'tcp'] = e.split('/')
    return !rows.some(({ l }) => l.container === port && (l.proto || 'tcp') === proto)
  })

  const update = (index: number, patch: Partial<Mapping>) => {
    const next = [...lines]
    next[index] = { ...(next[index] as Mapping), ...patch }
    onChange(serialize(next))
  }
  const remove = (index: number) => onChange(serialize(lines.filter((_, i) => i !== index)))
  const add = (container = '', proto = 'tcp') => {
    const host = free[0] ? String(free[0]) : container && Number(container) >= 1024 ? container : ''
    onChange(serialize([...lines, { ip: '', host, container, proto }]))
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          {rows.length ? `${rows.length} port mapping${rows.length === 1 ? '' : 's'}` : 'No published ports'}
        </p>
        <div className="flex gap-2">
          <Button type="button" variant="outline" size="sm" onClick={() => setRaw((r) => !r)}>
            {raw ? <Rows3 /> : <FileCode2 />} {raw ? 'Table view' : 'Raw editor'}
          </Button>
          {!raw && (
            <Button type="button" size="sm" onClick={() => add(unmapped[0]?.split('/')[0] ?? '', unmapped[0]?.split('/')[1] ?? 'tcp')}>
              <Plus /> Add port
            </Button>
          )}
        </div>
      </div>

      {unmapped.length > 0 && !raw && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-brand/25 bg-brand/5 px-3 py-2 text-sm">
          <Sparkles className="size-4 text-brand" />
          <span className="text-muted-foreground">The image exposes</span>
          {unmapped.map((e) => (
            <button
              key={e}
              type="button"
              onClick={() => add(e.split('/')[0], e.split('/')[1] ?? 'tcp')}
              className="inline-flex items-center gap-1 rounded-md border bg-card px-2 py-0.5 font-mono text-xs hover:border-brand/50 hover:text-brand"
              title={`Publish container port ${e}`}
            >
              <Plus className="size-3" /> {e}
            </button>
          ))}
        </div>
      )}
      {invalid.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <TriangleAlert className="size-4 shrink-0" />
          <span className="min-w-0 flex-1">
            Not a valid port mapping: {invalid.map((l) => <code key={l} className="mx-1 font-mono text-xs">{l.trim()}</code>)}
          </span>
          {!raw && (
            <Button type="button" variant="outline" size="sm" onClick={() => setRaw(true)}>
              Fix in raw editor
            </Button>
          )}
        </div>
      )}
      {image === '' && <p className="text-xs text-muted-foreground">Exposed ports are detected from the image after the first build.</p>}
      {exposed.data && !exposed.data.local && <p className="text-xs text-muted-foreground">Deploy once to detect the image's exposed ports.</p>}

      {raw ? (
        <CodeEditor value={value} onChange={onChange} placeholder={'8080:80\n127.0.0.1:5432:5432\n53:53/udp'} minRows={6} />
      ) : rows.length === 0 ? (
        <div className="rounded-xl border border-dashed px-6 py-8 text-center">
          <p className="text-sm text-muted-foreground">The container isn't reachable from the host until you publish a port.</p>
          <Button type="button" variant="outline" size="sm" className="mt-3" onClick={() => add(unmapped[0]?.split('/')[0] ?? '')}>
            <Plus /> Add port
          </Button>
        </div>
      ) : (
        <div className="divide-y overflow-hidden rounded-xl border bg-card">
          <div className="hidden grid-cols-[1fr_auto_1fr_6.5rem_2rem] items-center gap-2 px-3 py-2 text-xs font-medium text-muted-foreground sm:grid">
            <span>Host port</span>
            <span />
            <span>Container port</span>
            <span>Protocol</span>
            <span />
          </div>
          {rows.map(({ l, i }) => {
            const status = statusOf(l)
            const taken = status && !status.available
            return (
              <div key={i} className="px-3 py-2">
                <div className="grid grid-cols-[1fr_auto_1fr_6.5rem_2rem] items-center gap-2">
                  <div className="relative">
                    <input
                      value={l.host}
                      inputMode="numeric"
                      onChange={(e) => update(i, { host: e.target.value.replace(/\D/g, '').slice(0, 5) })}
                      placeholder="host"
                      className={cn(portInput, 'pr-7', taken && 'border-warning/60')}
                      aria-label="Host port"
                    />
                    <span className="absolute top-1/2 right-2 -translate-y-1/2">
                      {l.host && <HostStatus status={status} checking={ports.isFetching} />}
                    </span>
                  </div>
                  <ArrowRight className="size-3.5 text-muted-foreground" />
                  <input
                    value={l.container}
                    inputMode="numeric"
                    onChange={(e) => update(i, { container: e.target.value.replace(/\D/g, '').slice(0, 5) })}
                    placeholder="container"
                    className={portInput}
                    aria-label="Container port"
                  />
                  <Select value={l.proto || 'tcp'} onValueChange={(v) => update(i, { proto: v })}>
                    <SelectTrigger size="sm" className="w-full font-mono text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="tcp">tcp</SelectItem>
                      <SelectItem value="udp">udp</SelectItem>
                    </SelectContent>
                  </Select>
                  <Button type="button" variant="ghost" size="icon-sm" className="text-muted-foreground hover:text-destructive" onClick={() => remove(i)} aria-label="Remove port">
                    <Trash2 />
                  </Button>
                </div>
                {l.ip && <p className="mt-1 text-xs text-muted-foreground">Bound to {l.ip} only</p>}
                {taken && (
                  <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs">
                    <span className="text-warning">
                      Port {l.host} is in use by <span className="font-medium">{status.used_by}</span>. Try:
                    </span>
                    {free.slice(0, 3).map((p) => (
                      <button key={p} type="button" onClick={() => update(i, { host: String(p) })} className="rounded-md border bg-muted px-1.5 py-0.5 font-mono hover:border-brand/50 hover:text-brand">
                        {p}
                      </button>
                    ))}
                  </div>
                )}
                {!l.host && l.container && (
                  <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                    Not published on the host. Free ports:
                    {free.slice(0, 3).map((p) => (
                      <button key={p} type="button" onClick={() => update(i, { host: String(p) })} className="rounded-md border bg-muted px-1.5 py-0.5 font-mono hover:border-brand/50 hover:text-brand">
                        {p}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
