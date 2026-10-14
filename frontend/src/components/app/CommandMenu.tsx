import { useQuery } from '@tanstack/react-query'
import { Activity, Box, Boxes, Container, HardDrive, LayoutGrid, Layers, Moon, Network, PackageOpen, Plus, Settings, Sun } from 'lucide-react'
import { useTheme } from 'next-themes'
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router'
import { api, type DeploymentListItem, type StackListItem } from '@/api'
import { Command, CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator, CommandShortcut } from '@/components/ui/command'
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

  const run = (fn: () => void) => {
    setOpen(false)
    fn()
  }

  return (
    <CommandContext.Provider value={() => setOpen(true)}>
      {children}
      <CommandDialog open={open} onOpenChange={setOpen} title="Command menu" description="Search services and pages">
        <Command>
        <CommandInput placeholder="Search services, pages and actions…" />
        <CommandList>
          <CommandEmpty>No results.</CommandEmpty>
          {(stacks.data?.length || deployments.data?.length) ? (
            <CommandGroup heading="Services">
              {stacks.data?.map((s) => (
                <CommandItem key={`s-${s.name}`} value={`stack ${s.name}`} onSelect={() => run(() => navigate(`/stacks/${s.name}`))}>
                  <Layers />
                  {s.name}
                  <CommandShortcut>
                    <StatusDot status={s.status} />
                  </CommandShortcut>
                </CommandItem>
              ))}
              {deployments.data?.map((d) => (
                <CommandItem key={`d-${d.name}`} value={`deployment ${d.name} ${d.image}`} onSelect={() => run(() => navigate(`/deployments/${d.name}`))}>
                  <Box />
                  {d.name}
                  <CommandShortcut>
                    <StatusDot status={d.status} />
                  </CommandShortcut>
                </CommandItem>
              ))}
            </CommandGroup>
          ) : null}
          <CommandGroup heading="Create">
            <CommandItem onSelect={() => run(() => create('repo'))}>
              <Plus /> Deploy from GitHub repo
            </CommandItem>
            <CommandItem onSelect={() => run(() => create('image'))}>
              <Plus /> Deploy a Docker image
            </CommandItem>
            <CommandItem onSelect={() => run(() => create('stack'))}>
              <Plus /> New compose stack
            </CommandItem>
          </CommandGroup>
          <CommandSeparator />
          <CommandGroup heading="Go to">
            {pages.map((p) => (
              <CommandItem key={p.to} onSelect={() => run(() => navigate(p.to))}>
                <p.icon /> {p.label}
              </CommandItem>
            ))}
          </CommandGroup>
          <CommandGroup heading="Preferences">
            <CommandItem onSelect={() => run(() => setTheme(resolvedTheme === 'dark' ? 'light' : 'dark'))}>
              {resolvedTheme === 'dark' ? <Sun /> : <Moon />} Switch to {resolvedTheme === 'dark' ? 'light' : 'dark'} theme
            </CommandItem>
          </CommandGroup>
        </CommandList>
        </Command>
      </CommandDialog>
    </CommandContext.Provider>
  )
}
