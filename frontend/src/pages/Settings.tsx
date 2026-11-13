import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { KeyRound, Pencil, Plus, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { api, type GitAccount } from '@/api'
import { BackupDestinationsSection } from '@/components/app/backups'
import { Confirm } from '@/components/app/confirm'
import { GithubIcon } from '@/components/app/GithubIcon'
import { EmptyState, ErrorAlert, Loading, Page, PageHeader, Surface } from '@/components/app/page'
import { Button } from '@astryxdesign/core/Button'
import { Dialog, DialogHeader } from '@astryxdesign/core/Dialog'
import { IconButton } from '@astryxdesign/core/IconButton'
import { TextInput } from '@astryxdesign/core/TextInput'
import { timeAgo } from '@/lib/format'
import { toast } from '@/lib/toast'

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
          <Button size="sm" variant="primary" icon={<Plus />} label="Add account" onClick={() => setEditing('new')} />
        </div>
        <ErrorAlert error={error} className="mb-3" />
        <Surface>
          {isLoading ? (
            <Loading />
          ) : !data?.length ? (
            <EmptyState icon={<KeyRound />} title="No git accounts" action={<Button variant="primary" label="Add a GitHub account" onClick={() => setEditing('new')} />}>
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
                  <IconButton variant="ghost" size="sm" icon={<Pencil />} label={`Edit ${a.name}`} onClick={() => setEditing(a)} />
                  <IconButton
                    variant="ghost"
                    size="sm"
                    className="text-muted-foreground hover:text-destructive"
                    icon={<Trash2 />}
                    label={`Remove ${a.name}`}
                    onClick={() => setDeleting(a)}
                  />
                </div>
              ))}
            </div>
          )}
        </Surface>
      </section>
      <BackupDestinationsSection />
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
    <Dialog isOpen={account !== null} onOpenChange={(o) => !o && onClose()} width={448} purpose="form" padding={0}>
      {account !== null && <AccountForm key={account === 'new' ? 'new' : account.id} account={account === 'new' ? null : account} onClose={onClose} />}
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
      <DialogHeader
        className="border-b px-5 py-4"
        title={account ? `Edit ${account.name}` : 'Add git account'}
        onOpenChange={(o) => !o && onClose()}
        subtitle={
          <>
            For GitHub, create a{' '}
            <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noreferrer" className="text-brand hover:underline">
              fine-grained token
            </a>{' '}
            with read-only <em>Contents</em> access to the repositories you deploy.
          </>
        }
      />
      <div className="space-y-4 px-5 py-4">
        <TextInput label="Name" value={name} onChange={setName} isRequired width="100%" />
        <div className="grid gap-4 sm:grid-cols-2">
          <TextInput label="Host" value={host} onChange={setHost} placeholder="github.com" controlClassName="font-mono" width="100%" />
          <TextInput label="Username" value={username} onChange={setUsername} isOptional width="100%" />
        </div>
        <TextInput
          label="Access token"
          type="password"
          autoComplete="off"
          value={token}
          onChange={setToken}
          placeholder={account ? 'Leave empty to keep the saved token' : 'github_pat_…'}
          controlClassName="font-mono"
          isRequired={!account}
          description="Stored on the server and never shown again."
          width="100%"
        />
        <ErrorAlert error={save.error} />
      </div>
      <div className="flex justify-end gap-2 border-t bg-muted/30 px-5 py-3">
        <Button variant="ghost" label="Cancel" onClick={onClose} />
        <Button
          type="submit"
          variant="primary"
          label={account ? 'Save' : 'Add account'}
          isLoading={save.isPending}
          isDisabled={!name.trim() || (!account && !token)}
        />
      </div>
    </form>
  )
}
