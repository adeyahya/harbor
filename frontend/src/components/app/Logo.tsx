import { cn } from '@/lib/utils'

export function Logo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={cn('size-7', className)} aria-hidden>
      <rect width="32" height="32" rx="8" className="fill-foreground" />
      <path d="M16 7.5v16M10.5 11.5h11M8.5 18.5c0 4 3.4 6.5 7.5 6.5s7.5-2.5 7.5-6.5" fill="none" className="stroke-background" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}
