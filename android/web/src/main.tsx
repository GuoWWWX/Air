import { createRoot } from 'react-dom/client'
import '@fontsource-variable/inter'
import '@fontsource-variable/jetbrains-mono'
import './mobile.css'
import { loadPreferences } from '@/shared/lib/preferences'
import { native, onAndroid } from './bridge'
import { activateLanguage, previewLanguage, type LanguageState } from '@/shared/i18n/messages'

const SELECTABLE_SELECTOR = 'input, textarea, [contenteditable="true"], .cm-editor, .effective-preview, .air-runtime-yaml, .sheet-detail-row'

function hardenMobileWebView() {
  const blockPinch = (event: TouchEvent) => {
    if (event.touches.length > 1) event.preventDefault()
  }
  document.addEventListener('touchstart', blockPinch, { passive: false })
  document.addEventListener('touchmove', blockPinch, { passive: false })

  const blockGesture = (event: Event) => {
    event.preventDefault()
  }
  for (const type of ['gesturestart', 'gesturechange', 'gestureend']) {
    document.addEventListener(type, blockGesture, { passive: false })
  }

  window.addEventListener('wheel', event => {
    if (event.ctrlKey) event.preventDefault()
  }, { passive: false })

  window.addEventListener('keydown', event => {
    if (!(event.ctrlKey || event.metaKey)) return
    const key = event.key.toLowerCase()
    if (key === '+' || key === '-' || key === '=' || key === '0' || key === 'p' || key === 's' || key === 'u') {
      event.preventDefault()
    }
  })

  document.addEventListener('contextmenu', event => {
    if (event.defaultPrevented) return
    const target = event.target as HTMLElement | null
    if (target?.closest(SELECTABLE_SELECTOR)) return
    event.preventDefault()
  })

  document.addEventListener('dragstart', event => {
    const target = event.target as HTMLElement | null
    if (target?.closest('input, textarea, [contenteditable="true"], .cm-editor') || target?.getAttribute('draggable') === 'true') return
    event.preventDefault()
  })
  window.addEventListener('dragover', event => event.preventDefault())
  window.addEventListener('drop', event => event.preventDefault())
}

async function start() {
  hardenMobileWebView()
  const app = import('./app')
  const language = onAndroid ? native<LanguageState>('languages').catch(error => {
    console.warn('Could not load installed language packs', error)
    return previewLanguage()
  }) : Promise.resolve(previewLanguage())
  if (onAndroid) {
    await loadPreferences(() => native('readUiPreferences'), values => native('writeUiPreferences', { values }))
      .catch(error => console.warn('Could not load interface preferences', error))
  }
  activateLanguage(await language)
  const { App } = await app
  createRoot(document.getElementById('root')!).render(<App />)
}
void start()
