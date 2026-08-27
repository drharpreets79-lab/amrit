/* This module intentionally co-locates its provider and consumer hook. */
/* eslint-disable react-refresh/only-export-components */
import type React from 'react'
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react'
import { AlertCircle, CheckCircle2, Info, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { IconButton, cx } from './ui'

type ToastTone = 'success' | 'error' | 'info'
interface ToastItem { id: number; title: string; message?: string; tone: ToastTone }
interface ToastContextValue { notify: (title: string, message?: string, tone?: ToastTone) => void }
const ToastContext = createContext<ToastContextValue>({ notify: () => undefined })

export function ToastProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const { t } = useTranslation('common')
  const [items, setItems] = useState<ToastItem[]>([])
  const dismiss = useCallback((id: number) => setItems((current) => current.filter((item) => item.id !== id)), [])
  const notify = useCallback((title: string, message?: string, tone: ToastTone = 'success') => {
    const id = Date.now() + Math.floor(Math.random() * 1000)
    setItems((current) => [...current, { id, title, message, tone }])
    window.setTimeout(() => dismiss(id), 5000)
  }, [dismiss])
  const value = useMemo(() => ({ notify }), [notify])
  return <ToastContext.Provider value={value}>{children}<div className="toast-stack" aria-live="polite">{items.map((item) => {
    const Icon = item.tone === 'success' ? CheckCircle2 : item.tone === 'error' ? AlertCircle : Info
    return <div key={item.id} className={cx('toast', `toast--${item.tone}`)}><Icon size={21} /><div><strong>{item.title}</strong>{item.message && <span>{item.message}</span>}</div><IconButton label={t('toast.dismiss')} onClick={() => dismiss(item.id)}><X size={17} /></IconButton></div>
  })}</div></ToastContext.Provider>
}

export function useToast(): ToastContextValue { return useContext(ToastContext) }
