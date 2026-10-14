import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, Box, Layers } from 'lucide-react'
import { createContext, useContext, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router'
import { api } from '@/api'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ErrorAlert } from './page'

type Kind = 'stack' | 'deployment'

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
          {kind ? <CreateForm kind={kind} onBack={() => setKind(null)} onDone={() => setOpen(false)} /> : <KindPicker onPick={setKind} />}
        </DialogContent>
      </Dialog>
    </CreateContext.Provider>
  )
}

function KindPicker({ onPick }: { onPick: (k: Kind) => void }) {
  const options = [
    { kind: 'stack' as const, icon: Layers, title: 'Stack', body: 'A Docker Compose project with one or more services.' },
    { kind: 'deployment' as const, icon: Box, title: 'Deployment', body: 'A single container running a Docker image.' },
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
              <o.icon className="size-4.5" />
            </div>
            <div>
              <div className="text-sm font-medium">{o.title}</div>
              <div className="text-xs text-muted-foreground">{o.body}</div>
            </div>
          </button>
        ))}
      </div>
    </>
  )
}

function CreateForm({ kind, onBack, onDone }: { kind: Kind; onBack: () => void; onDone: () => void }) {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const [name, setName] = useState('')
  const [image, setImage] = useState('')
  const create = useMutation({
    mutationFn: () =>
      kind === 'stack'
        ? api.post('/stacks', { name, compose: STACK_TEMPLATE, env: 'PORT=8080\n' })
        : api.post('/deployments', { name, image, restart: 'unless-stopped' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [`${kind}s`] })
      onDone()
      navigate(`/${kind}s/${name}?tab=settings`)
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
          New {kind}
        </DialogTitle>
        <DialogDescription>{kind === 'stack' ? 'Starts from a sample compose file you can edit next.' : 'You can add ports, volumes and variables next.'}</DialogDescription>
      </DialogHeader>
      <div className="space-y-4 px-5 py-4">
        <div className="space-y-2">
          <Label htmlFor="create-name">Name</Label>
          <Input id="create-name" value={name} onChange={(e) => setName(e.target.value.toLowerCase())} placeholder={kind === 'stack' ? 'my-app' : 'my-service'} autoFocus required pattern="[a-z0-9][a-z0-9_\-]*" />
          <p className="text-xs text-muted-foreground">Lowercase letters, digits, - and _.</p>
        </div>
        {kind === 'deployment' && (
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
          Create {kind}
        </Button>
      </div>
    </form>
  )
}
