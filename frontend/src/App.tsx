import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'
import { Navigate, Route, Routes } from 'react-router'
import { api, type AuthStatus } from '@/api'
import { CommandMenuProvider } from '@/components/app/CommandMenu'
import { CreateProvider } from '@/components/app/CreateDialog'
import { Layout } from '@/components/app/Layout'
import { Loading } from '@/components/app/page'
import { UpdatesProvider } from '@/components/app/updates'
import { ActivityPage } from '@/pages/Activity'
import { CanvasPage } from '@/pages/Canvas'
import { ContainerPanel, ContainersPage } from '@/pages/Containers'
import { DeploymentPanel } from '@/pages/DeploymentPanel'
import { LoginPage } from '@/pages/Login'
import { ImportPage } from '@/pages/Import'
import { ImagesPage, NetworksPage, VolumesPage } from '@/pages/Resources'
import { SettingsPage } from '@/pages/Settings'
import { StackPanel } from '@/pages/StackPanel'
import { VolumePanel } from '@/pages/VolumePanel'

export default function App() {
  const qc = useQueryClient()
  const { data: auth, isLoading } = useQuery({
    queryKey: ['auth'],
    queryFn: () => api.get<AuthStatus>('/auth/status'),
    staleTime: Infinity,
  })

  // Any 401 from the API (e.g. an expired session) sends us back to login.
  useEffect(() => {
    const onUnauthorized = () => qc.invalidateQueries({ queryKey: ['auth'] })
    window.addEventListener('harbor:unauthorized', onUnauthorized)
    return () => window.removeEventListener('harbor:unauthorized', onUnauthorized)
  }, [qc])

  if (isLoading || !auth) return <Loading className="h-full items-center" />
  if (!auth.user) return <LoginPage setup={auth.setup_required} />

  return (
    <UpdatesProvider>
      <CreateProvider>
        <CommandMenuProvider>
          <Routes>
            <Route element={<Layout user={auth.user} />}>
              <Route path="/" element={<CanvasPage />}>
                <Route path="stacks/:name" element={<StackPanel />} />
                <Route path="deployments/:name" element={<DeploymentPanel />} />
              </Route>
              <Route path="containers" element={<ContainersPage />}>
                <Route path=":id" element={<ContainerPanel />} />
              </Route>
              <Route path="images" element={<ImagesPage />} />
              <Route path="volumes" element={<VolumesPage />}>
                <Route path=":name" element={<VolumePanel />} />
              </Route>
              <Route path="networks" element={<NetworksPage />} />
              <Route path="activity" element={<ActivityPage />} />
              <Route path="import" element={<ImportPage />} />
              <Route path="settings" element={<SettingsPage />} />
              <Route path="updates" element={<Navigate to="/activity" replace />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Route>
          </Routes>
        </CommandMenuProvider>
      </CreateProvider>
    </UpdatesProvider>
  )
}
