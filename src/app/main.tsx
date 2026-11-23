import '@fontsource-variable/inter'
import '@fontsource-variable/jetbrains-mono'
import { createRoot } from 'react-dom/client'
import { invoke, isTauri } from '@tauri-apps/api/core'
import { activateLanguage, previewLanguage, type LanguageState } from '@/shared/i18n/messages'
import './style.css'
import { loadPreferences, preferences } from '@/shared/lib/preferences'
import { initialSystemDark } from './systemTheme'

if (!window.__airFindDisabled) {
  window.__airFindDisabled = true
  window.addEventListener('keydown', event => {
    if (event.defaultPrevented) return
    const key = event.key.toLowerCase()
    if (((event.ctrlKey || event.metaKey) && !event.altKey && (key === 'f' || key === 'g')) || event.key === 'F3') {
      event.preventDefault()
    }
  })
}

async function start() {
  const app = import('./App')
  const language = isTauri()
    ? invoke<LanguageState>('list_languages').catch(error => {
        console.warn('Could not load installed language packs', error)
        return previewLanguage()
      })
    : Promise.resolve(previewLanguage())
  if (isTauri()) {
    await loadPreferences(() => invoke('read_ui_preferences'), values => invoke('write_ui_preferences', { values }))
      .catch(error => console.warn('Could not load interface preferences', error))
  }
  const savedTheme = preferences.getItem('air.theme')
  const theme = savedTheme === 'dark' || savedTheme === 'system' ? savedTheme : 'light'
  const dark = theme === 'dark' || (theme === 'system' && initialSystemDark())
  document.documentElement.dataset.theme = dark ? 'dark' : 'light'
  document.documentElement.classList.toggle('dark', dark)
  if (isTauri() && !window.__airSplashRevealed) {
    window.__airSplashRevealed = true
    window.__airSplashShownAt = performance.now()
    void invoke('reveal_startup_window').catch(() => undefined)
  }
  try { localStorage.setItem('air.bootTheme', theme) } catch {}
  activateLanguage(await language)
  const { App } = await app
  createRoot(document.getElementById('app')!).render(<App />)
}
void start()
