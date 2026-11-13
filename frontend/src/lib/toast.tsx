import { useToast, type ShowToastFn } from '@astryxdesign/core/Toast'
import { useEffect } from 'react'

/**
 * Module-level toast API, so mutation callbacks can notify without threading
 * Astryx's `useToast()` through every component. `ToastBridge` (rendered once
 * inside the `ToastViewport`) hands the hook's show function to this module.
 */
let show: ShowToastFn | null = null

export function ToastBridge() {
  const showToast = useToast()
  useEffect(() => {
    show = showToast
    return () => {
      if (show === showToast) show = null
    }
  }, [showToast])
  return null
}

export const toast = {
  success: (body: string) => show?.({ body, type: 'info' }),
  error: (body: string) => show?.({ body, type: 'error' }),
}
