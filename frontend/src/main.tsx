import { Theme } from '@astryxdesign/core/theme'
import { LinkProvider } from '@astryxdesign/core/Link'
import { ToastViewport } from '@astryxdesign/core/Toast'
import { neutralTheme } from '@astryxdesign/theme-neutral/built'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ThemeProvider, useTheme } from 'next-themes'
import { StrictMode, type ComponentProps, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Link } from 'react-router'
import { ToastBridge } from '@/lib/toast'
import App from './App.tsx'
import './index.css'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, refetchOnWindowFocus: true, staleTime: 2000 },
  },
})

/**
 * Lets Astryx `href` props (Button, IconButton, menu items) navigate client-side.
 * API URLs (downloads, OAuth redirects) are served by the backend, so they stay plain links.
 */
function RouterLink({ href, ...props }: Omit<ComponentProps<typeof Link>, 'to'> & { href: string }) {
  if (href.startsWith('/api/')) return <a href={href} {...props} />
  return <Link to={href} {...props} />
}

/** Drives Astryx's color mode from the same switch as Tailwind's `dark:` variant. */
function AstryxTheme({ children }: { children: ReactNode }) {
  const { resolvedTheme } = useTheme()
  return (
    <Theme theme={neutralTheme} mode={resolvedTheme === 'light' ? 'light' : 'dark'}>
      {children}
    </Theme>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ThemeProvider attribute="class" defaultTheme="dark" enableSystem={false} disableTransitionOnChange>
        <AstryxTheme>
          <ToastViewport position="bottomStart">
            <ToastBridge />
            <BrowserRouter>
              <LinkProvider component={RouterLink}>
                <App />
              </LinkProvider>
            </BrowserRouter>
          </ToastViewport>
        </AstryxTheme>
      </ThemeProvider>
    </QueryClientProvider>
  </StrictMode>,
)
