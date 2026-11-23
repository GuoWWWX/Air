import { useEffect, useState } from 'react'
import { invoke, isTauri } from '@tauri-apps/api/core'
import { getCurrentWindow } from '@tauri-apps/api/window'
import type { ThemeMode } from '../features/settings/SettingsView'

declare global {
  interface Window {
    airBootTheme?: { preference: ThemeMode; systemDark: boolean | null }
    __airSplashRevealed?: boolean
    __airSplashShownAt?: number
    __airFindDisabled?: boolean
  }
}

const darkQuery = '(prefers-color-scheme: dark)'

export function initialSystemDark() {
  return window.airBootTheme?.systemDark ?? window.matchMedia(darkQuery).matches
}

export function useSystemTheme(preference: ThemeMode) {
  const [dark, setDark] = useState(initialSystemDark)

  useEffect(() => {
    const native = isTauri() ? getCurrentWindow() : undefined
    void native?.setTheme(preference === 'system' ? null : preference)
      .catch(error => console.warn('Could not set the desktop window theme', error))
    if (preference !== 'system') return

    const media = window.matchMedia(darkQuery)
    let active = true
    let revision = 0
    async function refresh() {
      const current = ++revision
      const systemDark = native
        ? await invoke<boolean | null>('system_prefers_dark').catch(() => null)
        : null
      if (active && revision === current) setDark(systemDark ?? media.matches)
    }

    let unlisten: (() => void) | undefined
    void native?.onThemeChanged(refresh).then(remove => {
      if (active) unlisten = remove
      else remove()
    }).catch(() => undefined)
    media.addEventListener('change', refresh)
    window.addEventListener('focus', refresh)
    void refresh()
    return () => {
      active = false
      unlisten?.()
      media.removeEventListener('change', refresh)
      window.removeEventListener('focus', refresh)
    }
  }, [preference])

  return dark
}
