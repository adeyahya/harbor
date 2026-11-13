import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronsUpDown, LogOut, Moon, Plus, Search, Server, Settings, Sun } from 'lucide-react'
import { useTheme } from 'next-themes'
import { NavLink, Outlet, useNavigate } from 'react-router'
import { api, type AuthStatus, type SystemOverview, type User } from '@/api'
import { Avatar } from '@astryxdesign/core/Avatar'
import { Button } from '@astryxdesign/core/Button'
import { DropdownMenu, DropdownMenuItem } from '@astryxdesign/core/DropdownMenu'
import { IconButton } from '@astryxdesign/core/IconButton'
import { Kbd } from '@astryxdesign/core/Kbd'
import { cn } from '@/lib/utils'
import { useCommandMenu } from './CommandMenu'
import { useCreate } from './CreateDialog'
import { Logo } from './Logo'
import { StatusDot } from './status'

const nav = [
  { to: '/', label: 'Canvas', end: true },
  { to: '/containers', label: 'Containers' },
  { to: '/images', label: 'Images' },
  { to: '/volumes', label: 'Volumes' },
  { to: '/networks', label: 'Networks' },
  { to: '/activity', label: 'Activity' },
]

function NavTabs({ className }: { className?: string }) {
  return (
    <nav className={cn('scrollbar-thin flex items-center gap-1 overflow-x-auto', className)}>
      {nav.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          end={item.end}
          className={({ isActive }) =>
            cn(
              'relative shrink-0 rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
              isActive ? 'bg-accent text-foreground' : 'text-muted-foreground hover:text-foreground',
            )
          }
        >
          {item.label}
        </NavLink>
      ))}
    </nav>
  )
}

export function Layout({ user }: { user: User }) {
  const qc = useQueryClient()
  const openCommand = useCommandMenu()
  const create = useCreate()
  const { resolvedTheme, setTheme } = useTheme()
  const navigate = useNavigate()
  const system = useQuery({ queryKey: ['system'], queryFn: () => api.get<SystemOverview>('/system'), refetchInterval: 5000 })
  const hostname = system.data?.host.hostname?.replace(/\.local$/, '') || 'local'
  const dockerOk = system.data ? !!system.data.docker : true

  const logout = async () => {
    await api.post('/auth/logout')
    // Drop cached data from the session, then flip auth so the login page renders.
    qc.removeQueries({ predicate: (q) => q.queryKey[0] !== 'auth' })
    qc.setQueryData<AuthStatus>(['auth'], (prev) => prev && { ...prev, user: null })
  }

  return (
    <div className="flex h-full flex-col">
      <header className="z-30 shrink-0 border-b bg-background/80 backdrop-blur-md">
        <div className="flex h-14 items-center gap-3 px-3 sm:px-4">
          <NavLink to="/" className="shrink-0" aria-label="Harbor home">
            <Logo />
          </NavLink>
          <span className="text-muted-foreground/50">/</span>
          <div className="flex min-w-0 items-center gap-2 rounded-md px-1.5 py-1 text-sm font-medium">
            <Server className="size-4 shrink-0 text-muted-foreground" />
            <span className="truncate">{hostname}</span>
            <StatusDot status={dockerOk ? 'running' : 'failed'} className="size-1.5" />
          </div>

          <NavTabs className="ml-4 hidden lg:flex" />

          <div className="ml-auto flex items-center gap-2">
            <Button variant="secondary" size="sm" label="Search" icon={<Search />} onClick={openCommand} width={192} className="hidden text-muted-foreground sm:inline-flex">
              <span className="flex flex-1 items-center gap-2">
                Search…
                <Kbd keys="mod+k" className="ml-auto" />
              </span>
            </Button>
            <IconButton variant="secondary" size="sm" label="Search" icon={<Search />} onClick={openCommand} className="sm:hidden" />
            <Button variant="primary" size="sm" label="Create" icon={<Plus />} onClick={() => create()}>
              <span className="hidden sm:inline">Create</span>
            </Button>
            <DropdownMenu
              alignment="end"
              menuWidth={208}
              renderTrigger={(props) => (
                <button {...props} className="flex items-center gap-1 rounded-full outline-none focus-visible:ring-3 focus-visible:ring-ring/50" aria-label="Account menu">
                  <Avatar name={user.username} size={32} />
                  <ChevronsUpDown className="hidden size-3.5 text-muted-foreground sm:block" />
                </button>
              )}
              header={
                <div className="px-3 py-2">
                  <div className="text-sm font-medium text-foreground">{user.username}</div>
                  <div className="text-xs font-normal text-muted-foreground">Administrator</div>
                </div>
              }
            >
              <DropdownMenuItem icon={<Settings />} label="Settings" onClick={() => navigate('/settings')} />
              <DropdownMenuItem
                icon={resolvedTheme === 'dark' ? <Sun /> : <Moon />}
                label={`${resolvedTheme === 'dark' ? 'Light' : 'Dark'} theme`}
                onClick={() => setTheme(resolvedTheme === 'dark' ? 'light' : 'dark')}
              />
              <DropdownMenuItem icon={<LogOut />} label="Sign out" onClick={logout} />
            </DropdownMenu>
          </div>
        </div>
        <NavTabs className="px-2 pb-2 lg:hidden" />
      </header>
      <main className="relative min-h-0 flex-1 overflow-y-auto">
        <Outlet />
      </main>
    </div>
  )
}
