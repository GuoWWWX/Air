import { diagnostic, tr } from '@/shared/i18n/messages'
import { invoke, isTauri } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { useEffect, useState } from 'react'
import { showMessage } from '@/shared/ui/message'
import { version } from '../../../package.json'

type Phase = 'idle' | 'checking' | 'current' | 'available' | 'preparing' | 'downloading'
  | 'paused' | 'installing' | 'interrupted' | 'unconfigured'

export interface UpdateStatus {
  current: string
  phase: Phase
  version: string | null
  notes: string | null
  message: string | null
  progress: { received: number; total: number; speed: number }
  ignored: boolean
}

const initial: UpdateStatus = {
  current: version,
  phase: 'idle',
  version: null,
  notes: null,
  message: null,
  progress: { received: 0, total: 0, speed: 0 },
  ignored: false,
}

export function openUpdateLink(url: string) {
  if (isTauri()) return invoke<void>('open_update_link', { url })
  window.open(url, '_blank', 'noopener,noreferrer')
  return Promise.resolve()
}

export function useUpdates(onError: (error: unknown) => void) {
  const [status, setStatus] = useState(initial)
  const [open, setOpen] = useState(false)
  const [prompted, setPrompted] = useState<string | null>(null)

  useEffect(() => {
    if (!isTauri()) return
    let active = true
    let received = false
    const listener = listen<UpdateStatus>('air://update', event => {
      received = true
      if (active) setStatus(event.payload)
    })
    void listener.then(() => invoke<UpdateStatus>('update_status')).then(next => {
      if (active && !received) setStatus(next)
    }).catch(onError)
    return () => {
      active = false
      void listener.then(unsubscribe => unsubscribe(), () => {})
    }
  }, [onError])

  useEffect(() => {
    if (!status.version || status.ignored || prompted === status.version
      || !['available', 'preparing', 'downloading', 'installing', 'interrupted'].includes(status.phase)) return
    function prompt() {
      if (document.hidden) return
      setPrompted(status.version)
      setOpen(true)
    }
    prompt()
    document.addEventListener('visibilitychange', prompt)
    return () => document.removeEventListener('visibilitychange', prompt)
  }, [prompted, status.ignored, status.phase, status.version])

  async function check() {
    try {
      const next = await invoke<UpdateStatus>('check_update')
      if (next.version) {
        setOpen(true)
        showMessage({ type: 'info', title: tr("发现新版本 Air Proxy {0}", next.version) })
      } else if (next.phase === 'current') {
        showMessage({ type: 'success', title: tr('当前已是最新版本') })
      } else if (next.message) {
        showMessage({ type: 'info', title: diagnostic(next.message) })
      }
    } catch (error) {
      onError(error)
    }
  }

  function start() {
    void invoke('start_update').catch(onError)
  }

  function pause() {
    void invoke('pause_update').catch(onError)
  }

  function cancel() {
    void invoke('cancel_update').catch(onError)
  }

  async function ignore() {
    try {
      await invoke('ignore_update')
      setOpen(false)
    } catch (error) {
      onError(error)
    }
  }

  const busy = ['preparing', 'downloading', 'installing'].includes(status.phase)
  return { status, open, setOpen, busy, check, start, pause, cancel, ignore, onError }
}

export type Updates = ReturnType<typeof useUpdates>
