import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { KeyRound, Pencil, Plus, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { api, type GitAccount } from '@/api'
import { Confirm } from '@/components/app/confirm'
import { GithubIcon } from '@/components/app/GithubIcon'
import { EmptyState, ErrorAlert, Loading, Page, PageHeader, Surface } from '@/components/app/page'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { timeAgo } from '@/lib/format'

export function useGitAccounts() {
  return useQuery({ queryKey: ['git-accounts'], queryFn: () => api.get<GitAccount[]>('/settings/git-accounts') })
}

export function SettingsPage() {
  const qc = useQueryClient()
  const { data, isLoading, error } = useGitAccounts()
  const [editing, setEditing] = useState<GitAccount | 'new' | null>(null)
  const [deleting, setDeleting] = useState<GitAccount | null>(null)
  const remove = useMutation({
    mutationFn: (id: number) => api.del(`/settings/git-accounts/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['git-accounts'] })
      toast.success('Account removed')
    },
    onError: (e) => toast.error(e.message),
  })

  return (
    <Page className="max-w-3xl">
      <PageHeader title="Settings" />
      <section>
        <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="font-semibold">Git accounts</h2>
            <p className="mt-0.5 text-sm text-muted-foreground">
              Credentials for private repositories. Services use the account for their repository's host automatically, or one you pick in their Settings.
            </p>
          </div>
          <Button size="sm" onClick={() => setEditing('new')}>
            <Plus /> Add account
          </Button>
        </div>
        <ErrorAlert error={error} className="mb-3" />
        <Surface>
          {isLoading ? (
            <Loading />
          ) : !data?.length ? (
            <EmptyState icon={<KeyRound />} title="No git accounts" action={<Button onClick={() => setEditing('new')}>Add a GitHub account</Button>}>
              Public repositories work without one. Add an account to deploy from private repositories.
            </EmptyState>
          ) : (
            <div className="divide-y">
              {data.map((a) => (
                <div key={a.id} className="flex items-center gap-3 px-4 py-3">
                  <div className="flex size-9 items-center justify-center rounded-lg border bg-muted/60">
                    {a.host === 'github.com' ? <GithubIcon /> : <KeyRound className="size-4" />}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="font-medium">{a.name}</div>
                    <div className="text-xs text-muted-foreground">
                      {a.host}
                      {a.username && ` · ${a.username}`} · added {timeAgo(a.created_at)}
                    </div>
                  </div>
                  <Button variant="ghost" size="icon-sm" onClick={() => setEditing(a)} aria-label={`Edit ${a.name}`}>
                    <Pencil />
                  </Button>
                  <Button variant="ghost" size="icon-sm" className="text-muted-foreground hover:text-destructive" onClick={() => setDeleting(a)} aria-label={`Remove ${a.name}`}>
                    <Trash2 />
                  </Button>
                </div>
              ))}
            </div>
          )}
        </Surface>
      </section>
      <AccountDialog account={editing} onClose={() => setEditing(null)} />
      <Confirm
        open={deleting !== null}
        onOpenChange={(o) => !o && setDeleting(null)}
        title={`Remove ${deleting?.name}?`}
        description="Services that use this account switch to automatic, and lose access to private repositories unless another account matches."
        confirmLabel="Remove account"
        onConfirm={() => deleting && remove.mutate(deleting.id)}
      />
    </Page>
  )
}

function AccountDialog({ account, onClose }: { account: GitAccount | 'new' | null; onClose: () => void }) {
  return (
    <Dialog open={account !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="gap-0 p-0 sm:max-w-md">
        {account !== null && <AccountForm key={account === 'new' ? 'new' : account.id} account={account === 'new' ? null : account} onClose={onClose} />}
      </DialogContent>
    </Dialog>
  )
}

function AccountForm({ account, onClose }: { account: GitAccount | null; onClose: () => void }) {
  const qc = useQueryClient()
  const [name, setName] = useState(account?.name ?? 'GitHub')
  const [host, setHost] = useState(account?.host ?? 'github.com')
  const [username, setUsername] = useState(account?.username ?? '')
  const [token, setToken] = useState('')
  const save = useMutation({
    mutationFn: () => {
      const body = { name, host, username, token: token || undefined }
      return account ? api.put<GitAccount>(`/settings/git-accounts/${account.id}`, body) : api.post<GitAccount>('/settings/git-accounts', body)
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['git-accounts'] })
      toast.success(account ? 'Account updated' : 'Account added')
      onClose()
    },
  })
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        save.mutate()
      }}
    >
      <DialogHeader className="border-b px-5 py-4">
        <DialogTitle>{account ? `Edit ${account.name}` : 'Add git account'}</DialogTitle>
        <DialogDescription>
          For GitHub, create a{' '}
          <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noreferrer" className="text-brand hover:underline">
            fine-grained token
          </a>{' '}
          with read-only <em>Contents</em> access to the repositories you deploy.
        </DialogDescription>
      </DialogHeader>
      <div className="space-y-4 px-5 py-4">
        <div className="space-y-1.5">
          <Label htmlFor="acc-name">Name</Label>
          <Input id="acc-name" value={name} onChange={(e) => setName(e.target.value)} required />
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="acc-host">Host</Label>
            <Input id="acc-host" value={host} onChange={(e) => setHost(e.target.value)} placeholder="github.com" className="font-mono" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="acc-user">Username</Label>
            <Input id="acc-user" value={username} onChange={(e) => setUsername(e.target.value)} placeholder="Optional" />
          </div>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="acc-token">Access token</Label>
          <Input
            id="acc-token"
            type="password"
            autoComplete="off"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder={account ? 'Leave empty to keep the saved token' : 'github_pat_…'}
            className="font-mono"
            required={!account}
          />
          <p className="text-xs text-muted-foreground">Stored on the server and never shown again.</p>
        </div>
        <ErrorAlert error={save.error} />
      </div>
      <div className="flex justify-end gap-2 border-t bg-muted/30 px-5 py-3">
        <Button type="button" variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" disabled={save.isPending}>
          {account ? 'Save' : 'Add account'}
        </Button>
      </div>
    </form>
  )
}
