import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, Box, Layers, PackageOpen } from 'lucide-react'
import { createContext, useContext, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router'
import { api } from '@/api'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { GithubIcon } from './GithubIcon'
import { ErrorAlert } from './page'

/** `repo` and `image` both create deployments, from different sources. */
type Kind = 'repo' | 'image' | 'stack'

const STACK_TEMPLATE = `services:
  app:
    image: nginx:alpine
    restart: unless-stopped
    ports:
      - "\${PORT:-8080}:80"
`

const CreateContext = createContext<(kind?: Kind) => void>(() => {})
export const useCreate = () => useContext(CreateContext)

export function CreateProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false)
  const [kind, setKind] = useState<Kind | null>(null)
  const openWith = (k?: Kind) => {
    setKind(k ?? null)
    setOpen(true)
  }
  return (
    <CreateContext.Provider value={openWith}>
      {children}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-md">
          {kind ? <CreateForm kind={kind} onBack={() => setKind(null)} onDone={() => setOpen(false)} /> : <KindPicker onPick={setKind} onImport={() => setOpen(false)} />}
        </DialogContent>
      </Dialog>
    </CreateContext.Provider>
  )
}

function KindPicker({ onPick, onImport }: { onPick: (k: Kind) => void; onImport: () => void }) {
  const navigate = useNavigate()
  const options = [
    { kind: 'repo' as const, icon: <GithubIcon className="size-4.5" />, title: 'GitHub repo', body: 'Build a Dockerfile from a repository and redeploy on push.' },
    { kind: 'image' as const, icon: <Box className="size-4.5" />, title: 'Docker image', body: 'Run a single container from a registry image.' },
    { kind: 'stack' as const, icon: <Layers className="size-4.5" />, title: 'Compose stack', body: 'A Docker Compose project with one or more services.' },
  ]
  return (
    <>
      <DialogHeader className="border-b px-5 py-4">
        <DialogTitle>What would you like to create?</DialogTitle>
        <DialogDescription>Services run on this server's Docker engine.</DialogDescription>
      </DialogHeader>
      <div className="space-y-1 p-2">
        {options.map((o) => (
          <button key={o.kind} onClick={() => onPick(o.kind)} className="flex w-full items-center gap-3 rounded-lg px-3 py-3 text-left transition-colors hover:bg-accent">
            <div className="flex size-9 items-center justify-center rounded-lg border bg-muted text-brand">
              {o.icon}
            </div>
            <div>
              <div className="text-sm font-medium">{o.title}</div>
              <div className="text-xs text-muted-foreground">{o.body}</div>
            </div>
          </button>
        ))}
        <button
          onClick={() => {
            onImport()
            navigate('/import')
          }}
          className="flex w-full items-center gap-3 rounded-lg border-t px-3 py-3 text-left transition-colors hover:bg-accent"
        >
          <div className="flex size-9 items-center justify-center rounded-lg border bg-muted text-brand">
            <PackageOpen className="size-4.5" />
          </div>
          <div>
            <div className="text-sm font-medium">Import existing containers</div>
            <div className="text-xs text-muted-foreground">Take over containers already running here, e.g. from Komodo.</div>
          </div>
        </button>
      </div>
    </>
  )
}

const titles: Record<Kind, string> = { repo: 'Deploy from GitHub', image: 'Deploy an image', stack: 'New stack' }
const descriptions: Record<Kind, string> = {
  repo: 'Harbor clones the branch, builds its Dockerfile and runs the image.',
  image: 'You can add ports, volumes and variables next.',
  stack: 'Starts from a sample compose file you can edit next.',
}

/** Suggests a service name from a repo like `acme/web-api` or a URL. */
function nameFromRepo(repo: string) {
  const last = repo.trim().replace(/\/$/, '').replace(/\.git$/, '').split(/[/:]/).pop() ?? ''
  return last.toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/^[-_]+/, '').slice(0, 63)
}

function CreateForm({ kind, onBack, onDone }: { kind: Kind; onBack: () => void; onDone: () => void }) {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const [name, setName] = useState('')
  const [nameTouched, setNameTouched] = useState(false)
  const [image, setImage] = useState('')
  const [repo, setRepo] = useState('')
  const [branch, setBranch] = useState('')
  const path = kind === 'stack' ? 'stacks' : 'deployments'
  const create = useMutation({
    mutationFn: () =>
      kind === 'stack'
        ? api.post('/stacks', { name, compose: STACK_TEMPLATE, env: 'PORT=8080\n' })
        : kind === 'image'
          ? api.post('/deployments', { name, source: 'image', image, restart: 'unless-stopped' })
          : api.post('/deployments', { name, source: 'git', git_url: repo, git_branch: branch, restart: 'unless-stopped' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [path] })
      onDone()
      navigate(`/${path}/${name}?tab=settings`)
    },
  })
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        create.mutate()
      }}
    >
      <DialogHeader className="border-b px-5 py-4">
        <DialogTitle className="flex items-center gap-2">
          <button type="button" onClick={onBack} className="-ml-1 rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground" aria-label="Back">
            <ArrowLeft className="size-4" />
          </button>
          {titles[kind]}
        </DialogTitle>
        <DialogDescription>{descriptions[kind]}</DialogDescription>
      </DialogHeader>
      <div className="space-y-4 px-5 py-4">
        {kind === 'repo' && (
          <>
            <div className="space-y-2">
              <Label htmlFor="create-repo">Repository</Label>
              <Input
                id="create-repo"
                value={repo}
                onChange={(e) => {
                  setRepo(e.target.value)
                  if (!nameTouched) setName(nameFromRepo(e.target.value))
                }}
                placeholder="owner/repo or https://…"
                className="font-mono"
                autoFocus
                required
              />
              <p className="text-xs text-muted-foreground">Private repositories use your git accounts from Settings.</p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="create-branch">Branch</Label>
              <Input id="create-branch" value={branch} onChange={(e) => setBranch(e.target.value)} placeholder="Default branch" className="font-mono" />
              <p className="text-xs text-muted-foreground">Leave empty to use the repository's default branch.</p>
            </div>
          </>
        )}
        <div className="space-y-2">
          <Label htmlFor="create-name">Service name</Label>
          <Input
            id="create-name"
            value={name}
            onChange={(e) => {
              setNameTouched(true)
              setName(e.target.value.toLowerCase())
            }}
            placeholder={kind === 'stack' ? 'my-app' : 'my-service'}
            autoFocus={kind !== 'repo'}
            required
            pattern="[a-z0-9][a-z0-9_\-]*"
          />
          <p className="text-xs text-muted-foreground">Lowercase letters, digits, - and _.</p>
        </div>
        {kind === 'image' && (
          <div className="space-y-2">
            <Label htmlFor="create-image">Image</Label>
            <Input id="create-image" value={image} onChange={(e) => setImage(e.target.value)} placeholder="nginx:alpine" className="font-mono" required />
          </div>
        )}
        <ErrorAlert error={create.error} />
      </div>
      <div className="flex justify-end gap-2 border-t bg-muted/30 px-5 py-3">
        <Button type="button" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" disabled={create.isPending}>
          Create
        </Button>
      </div>
    </form>
  )
}
