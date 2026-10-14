import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { api } from '@/api'
import { Logo } from '@/components/app/Logo'
import { ErrorAlert } from '@/components/app/page'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

export function LoginPage({ setup }: { setup: boolean }) {
  const qc = useQueryClient()
  const [username, setUsername] = useState(setup ? 'admin' : '')
  const [password, setPassword] = useState('')
  const submit = useMutation({
    mutationFn: () => api.post(setup ? '/auth/setup' : '/auth/login', { username, password }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['auth'] }),
  })

  return (
    <div className="bg-dots relative flex min-h-full items-center justify-center overflow-hidden p-4">
      <div className="pointer-events-none absolute top-1/2 left-1/2 size-[36rem] -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary/25 blur-[120px]" />
      <div className="relative w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center text-center">
          <Logo className="mb-5 size-10" />
          <h1 className="text-2xl font-semibold tracking-tight">{setup ? 'Welcome to Harbor' : 'Sign in to Harbor'}</h1>
          <p className="mt-1.5 text-sm text-muted-foreground">{setup ? 'Create the admin account to get started.' : 'Deploy and manage your server.'}</p>
        </div>
        <form
          className="space-y-4 rounded-2xl border bg-card/90 p-6 shadow-2xl shadow-black/20 backdrop-blur"
          onSubmit={(e) => {
            e.preventDefault()
            submit.mutate()
          }}
        >
          <div className="space-y-2">
            <Label htmlFor="username">Username</Label>
            <Input id="username" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" autoFocus={!setup} required />
          </div>
          <div className="space-y-2">
            <Label htmlFor="password">Password</Label>
            <Input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete={setup ? 'new-password' : 'current-password'}
              autoFocus={setup}
              required
              minLength={setup ? 8 : undefined}
            />
            {setup && <p className="text-xs text-muted-foreground">At least 8 characters.</p>}
          </div>
          <ErrorAlert error={submit.error} />
          <Button type="submit" className="h-9 w-full" disabled={submit.isPending}>
            {setup ? 'Create account' : 'Sign in'}
          </Button>
        </form>
      </div>
    </div>
  )
}
