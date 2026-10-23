import { lazy, Suspense, type ComponentProps } from 'react'
import { Loading } from '@/components/app/page'

// xterm.js is large; load it when a terminal is first opened.
const TerminalView = lazy(() => import('./TerminalView'))

export function Terminal(props: ComponentProps<typeof TerminalView>) {
  return (
    <Suspense fallback={<Loading className={props.className} />}>
      <TerminalView {...props} />
    </Suspense>
  )
}
