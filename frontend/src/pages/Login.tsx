import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { api } from '@/api'
import { Logo } from '@/components/app/Logo'
import { ErrorAlert } from '@/components/app/page'
import { Button } from '@astryxdesign/core/Button'
import { TextInput } from '@astryxdesign/core/TextInput'

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
          <TextInput
            label="Username"
            value={username}
            onChange={setUsername}
            autoComplete="username"
            hasAutoFocus={!setup}
            hasAutoCorrect={false}
            autoCapitalize="off"
            width="100%"
          />
          <TextInput
            label="Password"
            type="password"
            value={password}
            onChange={setPassword}
            autoComplete={setup ? 'new-password' : 'current-password'}
            hasAutoFocus={setup}
            description={setup ? 'At least 8 characters.' : undefined}
            width="100%"
          />
          <ErrorAlert error={submit.error} />
          <Button
            type="submit"
            variant="primary"
            label={setup ? 'Create account' : 'Sign in'}
            width="100%"
            isLoading={submit.isPending}
            isDisabled={!username || password.length < (setup ? 8 : 1)}
          />
        </form>
      </div>
    </div>
  )
}
