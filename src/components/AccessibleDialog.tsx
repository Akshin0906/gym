import {
  type CSSProperties,
  type ReactNode,
  type RefObject,
  useEffect,
  useRef,
} from 'react'
import { createPortal } from 'react-dom'

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

interface DialogStackEntry {
  token: symbol
  dialog: HTMLElement
  previousInert: boolean
  previousAriaHidden: string | null
}

const dialogStack: DialogStackEntry[] = []
let appShellBaseline: {
  element: HTMLElement
  inert: boolean
  ariaHidden: string | null
  focus: HTMLElement | null
} | null = null

interface AccessibleDialogProps {
  open: boolean
  onClose: () => void
  labelledBy: string
  describedBy?: string
  initialFocusRef?: RefObject<HTMLElement | null>
  children: ReactNode
  className?: string
  style?: CSSProperties
  overlayClassName?: string
  closeOnBackdrop?: boolean
}

/**
 * A portal-backed modal that traps focus, closes on Escape, restores focus,
 * and makes the application shell inert while it is open.
 */
export function AccessibleDialog({
  open,
  onClose,
  labelledBy,
  describedBy,
  initialFocusRef,
  children,
  className = '',
  style,
  overlayClassName = '',
  closeOnBackdrop = true,
}: AccessibleDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose

  useEffect(() => {
    if (!open) return
    const previousFocus =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null
    const token = Symbol('dialog')
    const dialog = dialogRef.current
    if (!dialog) return
    const previousDialog = dialogStack.at(-1)
    if (previousDialog) {
      previousDialog.dialog.inert = true
      previousDialog.dialog.setAttribute('aria-hidden', 'true')
    }
    const stackEntry: DialogStackEntry = {
      token,
      dialog,
      previousInert: dialog.inert,
      previousAriaHidden: dialog.getAttribute('aria-hidden'),
    }
    dialogStack.push(stackEntry)
    const appShell = document.querySelector<HTMLElement>('[data-app-shell]')
    if (appShell) {
      if (dialogStack.length === 1) {
        appShellBaseline = {
          element: appShell,
          inert: appShell.inert,
          ariaHidden: appShell.getAttribute('aria-hidden'),
          focus: previousFocus,
        }
      }
      appShell.inert = true
      appShell.setAttribute('aria-hidden', 'true')
    }

    const frame = window.requestAnimationFrame(() => {
      const target =
        initialFocusRef?.current ??
        dialogRef.current?.querySelector<HTMLElement>(FOCUSABLE) ??
        dialogRef.current
      target?.focus()
    })

    const onKeyDown = (event: KeyboardEvent) => {
      if (dialogStack.at(-1)?.token !== token) return
      if (event.key === 'Escape') {
        event.preventDefault()
        closeRef.current()
        return
      }
      if (event.key !== 'Tab' || !dialogRef.current) return
      const focusable = Array.from(
        dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE),
      ).filter((element) => !element.hidden && element.offsetParent !== null)
      if (focusable.length === 0) {
        event.preventDefault()
        dialogRef.current.focus()
        return
      }
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKeyDown)

    return () => {
      window.cancelAnimationFrame(frame)
      document.removeEventListener('keydown', onKeyDown)
      const stackIndex = dialogStack.findIndex((entry) => entry.token === token)
      if (stackIndex >= 0) dialogStack.splice(stackIndex, 1)
      const revealedDialog = dialogStack.at(-1)
      if (revealedDialog) {
        revealedDialog.dialog.inert = revealedDialog.previousInert
        if (revealedDialog.previousAriaHidden === null) {
          revealedDialog.dialog.removeAttribute('aria-hidden')
        } else {
          revealedDialog.dialog.setAttribute(
            'aria-hidden',
            revealedDialog.previousAriaHidden,
          )
        }
      }
      if (dialogStack.length === 0 && appShellBaseline) {
        const baseline = appShellBaseline
        baseline.element.inert = baseline.inert
        if (baseline.ariaHidden === null) {
          baseline.element.removeAttribute('aria-hidden')
        } else {
          baseline.element.setAttribute('aria-hidden', baseline.ariaHidden)
        }
        baseline.focus?.focus()
        appShellBaseline = null
      } else {
        if (appShell) {
          appShell.inert = true
          appShell.setAttribute('aria-hidden', 'true')
        }
        previousFocus?.focus()
      }
    }
  }, [initialFocusRef, open])

  if (!open) return null

  return createPortal(
    <div
      className={`fixed inset-0 z-50 flex ${overlayClassName}`}
      style={{ background: 'oklch(0 0 0 / 0.62)' }}
      onPointerDown={(event) => {
        if (closeOnBackdrop && event.target === event.currentTarget) onClose()
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        aria-describedby={describedBy}
        tabIndex={-1}
        className={className}
        style={style}
      >
        {children}
      </div>
    </div>,
    document.body,
  )
}
