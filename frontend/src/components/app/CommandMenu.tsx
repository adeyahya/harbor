import { useQuery } from '@tanstack/react-query'
import { Activity, Box, Boxes, Container, HardDrive, LayoutGrid, Layers, Moon, Network, PackageOpen, Plus, Settings, Sun } from 'lucide-react'
import { useTheme } from 'next-themes'
import { CommandPalette } from '@astryxdesign/core/CommandPalette'
import { createStaticSource, type SearchableItem } from '@astryxdesign/core/Typeahead'
import { createContext, useContext, useEffect, useMemo, useState, type ComponentType, type ReactNode } from 'react'
import { useNavigate } from 'react-router'
import { api, type DeploymentListItem, type StackListItem } from '@/api'
import { useCreate } from './CreateDialog'
import { StatusDot } from './status'

const CommandContext = createContext<() => void>(() => {})
export const useCommandMenu = () => useContext(CommandContext)

const pages = [
  { to: '/', label: 'Canvas', icon: LayoutGrid },
  { to: '/containers', label: 'Containers', icon: Container },
  { to: '/images', label: 'Images', icon: Boxes },
  { to: '/volumes', label: 'Volumes', icon: HardDrive },
  { to: '/networks', label: 'Networks', icon: Network },
  { to: '/activity', label: 'Activity', icon: Activity },
  { to: '/import', label: 'Import existing containers', icon: PackageOpen },
  { to: '/settings', label: 'Settings · Git accounts', icon: Settings },
]

export function CommandMenuProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false)
  const navigate = useNavigate()
  const create = useCreate()
  const { resolvedTheme, setTheme } = useTheme()
  const stacks = useQuery({ queryKey: ['stacks'], queryFn: () => api.get<StackListItem[]>('/stacks'), enabled: open })
  const deployments = useQuery({ queryKey: ['deployments'], queryFn: () => api.get<DeploymentListItem[]>('/deployments'), enabled: open })

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'k' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        setOpen((o) => !o)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Items are rebuilt when data or theme changes; selection dispatches by id.
  const items = useMemo(() => {
    const list: CommandItem[] = []
    const add = (id: string, label: string, group: string, icon: ComponentType, run: () => void, extra: Partial<CommandAux> = {}) =>
      list.push({ id, label, auxiliaryData: { group, icon, run, ...extra } })
    for (const s of stacks.data ?? []) add(`s-${s.name}`, s.name, 'Services', Layers, () => navigate(`/stacks/${s.name}`), { status: s.status, keywords: ['stack'] })
    for (const d of deployments.data ?? [])
      add(`d-${d.name}`, d.name, 'Services', Box, () => navigate(`/deployments/${d.name}`), { status: d.status, keywords: ['deployment', d.image] })
    add('create-repo', 'Deploy from GitHub repo', 'Create', Plus, () => create('repo'))
    add('create-image', 'Deploy a Docker image', 'Create', Plus, () => create('image'))
    add('create-stack', 'New compose stack', 'Create', Plus, () => create('stack'))
    for (const p of pages) add(`go-${p.to}`, p.label, 'Go to', p.icon, () => navigate(p.to))
    const dark = resolvedTheme === 'dark'
    add('theme', `Switch to ${dark ? 'light' : 'dark'} theme`, 'Preferences', dark ? Sun : Moon, () => setTheme(dark ? 'light' : 'dark'))
    return list
  }, [stacks.data, deployments.data, resolvedTheme, navigate, create, setTheme])
  const source = useMemo(() => createStaticSource(items, { keywords: (item) => item.auxiliaryData?.keywords ?? [] }), [items])

  return (
    <CommandContext.Provider value={() => setOpen(true)}>
      {children}
      <CommandPalette<CommandItem>
        isOpen={open}
        onOpenChange={setOpen}
        label="Command menu"
        searchSource={source}
        value=""
        onValueChange={(id) => items.find((i) => i.id === id)?.auxiliaryData?.run()}
        emptySearchText="No results."
        renderItem={(item) => {
          const aux = item.auxiliaryData!
          return (
            <span className="flex w-full items-center gap-2 [&>svg]:size-4 [&>svg]:shrink-0 [&>svg]:text-muted-foreground">
              <aux.icon />
              <span className="min-w-0 flex-1 truncate">{item.label}</span>
              {aux.status && <StatusDot status={aux.status} />}
            </span>
          )
        }}
      />
    </CommandContext.Provider>
  )
}

interface CommandAux {
  group: string
  icon: ComponentType
  run: () => void
  status?: string
  keywords?: string[]
}

type CommandItem = SearchableItem<CommandAux>
