import { AlertDialog } from '@astryxdesign/core/AlertDialog'
import { useState, type ReactNode } from 'react'

/**
 * Confirmation dialog for destructive actions. Wrap a trigger element, or
 * control it with `open`/`onOpenChange` (e.g. from a dropdown menu item,
 * which unmounts its children when the menu closes).
 */
export function Confirm({
  children,
  open: controlledOpen,
  onOpenChange,
  title,
  description = '',
  confirmLabel = 'Confirm',
  destructive = true,
  onConfirm,
}: {
  children?: ReactNode
  open?: boolean
  onOpenChange?: (open: boolean) => void
  title: string
  description?: string
  confirmLabel?: string
  destructive?: boolean
  onConfirm: () => void
}) {
  const [uncontrolled, setUncontrolled] = useState(false)
  const open = controlledOpen ?? uncontrolled
  const setOpen = onOpenChange ?? setUncontrolled
  return (
    <>
      {/* `contents` keeps the trigger's own layout; the capture listener opens the dialog. */}
      {children && (
        <span className="contents" onClickCapture={() => setOpen(true)}>
          {children}
        </span>
      )}
      <AlertDialog
        isOpen={open}
        onOpenChange={setOpen}
        title={title}
        description={description}
        actionLabel={confirmLabel}
        actionVariant={destructive ? 'destructive' : 'primary'}
        onAction={() => {
          setOpen(false)
          onConfirm()
        }}
      />
    </>
  )
}
