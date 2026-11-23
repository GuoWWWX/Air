import { useSyncExternalStore } from 'react'
import english from '../../../resources/languages/en.json'
import chinese from '../../../resources/languages/zh-CN.json'

export interface LanguageOption { code: string; name: string }
export interface LanguagePack extends LanguageOption { messages: Record<string, string> }
export interface LanguageState {
  code: string
  preference: string
  options: LanguageOption[]
  messages: Record<string, string>
  directory: string
}

const builtins = Object.values(import.meta.glob<LanguagePack>('../../../resources/languages/*.json', {
  eager: true, import: 'default',
}))
function matchLanguage(tag: string): LanguagePack {
  let candidate = tag.toLowerCase()
  while (candidate) {
    const exact = builtins.find(pack => pack.code.toLowerCase() === candidate)
    if (exact) return exact
    if (!candidate.includes('-')) break
    candidate = candidate.slice(0, candidate.lastIndexOf('-'))
  }
  if (candidate === 'zh') return chinese
  const variants = builtins.filter(pack => pack.code.split('-')[0].toLowerCase() === candidate)
  return variants.length === 1 ? variants[0] : english
}
export function previewLanguage(): LanguageState {
  const saved = globalThis.localStorage?.getItem('air.language')
  const preference = builtins.some(item => item.code === saved) ? saved! : 'system'
  const tag = preference === 'system' ? (globalThis.navigator?.language || 'en') : preference
  const pack = matchLanguage(tag)
  return { code: pack.code, preference, messages: pack.messages, directory: '', options: builtins.map(({ code, name }) => ({ code, name })) }
}

export async function savePreviewLanguage(code: string) {
  localStorage.setItem('air.language', code)
  return previewLanguage()
}

export let language = previewLanguage()
export let formatLocale = language.code
let dictionary: Record<string, string> = language.messages

const listeners = new Set<() => void>()
const subscribe = (notify: () => void) => {
  listeners.add(notify)
  return () => { listeners.delete(notify) }
}
const currentLanguage = () => language
export function useLanguage() {
  return useSyncExternalStore(subscribe, currentLanguage)
}

export function activateLanguage(state: LanguageState) {
  language = state
  // Installed tags can include extensions unknown to the device's Intl implementation.
  try { formatLocale = Intl.getCanonicalLocales(state.code)[0] || 'en' }
  catch { formatLocale = 'en' }
  dictionary = Object.assign(Object.create(null), state.code === 'zh-CN' ? chinese.messages : english.messages, state.messages)
  document.documentElement.lang = state.code
  listeners.forEach(notify => notify())
}

const patterns = Object.keys(english.messages).filter(key => key.includes('{0}') && /\p{Script=Han}/u.test(key)).sort((a, b) => b.length - a.length).map(key => {
    const slots: number[] = []
    const source = key.split(/(\{\d+\})/).map(part => {
      if (/^\{\d+\}$/.test(part)) { slots.push(Number(part.slice(1,-1))); return '([\\s\\S]*?)' }
      return part.replace(/[.*+?^$\{\}()|[\]\\]/g, '\\$&')
    }).join('')
    return { key, slots, pattern: new RegExp('^' + source + '$') }
  })

export function tr(key: string, ...values: unknown[]): string {
  const result = Object.hasOwn(dictionary, key) ? dictionary[key] : key
  return values.length ? result.replace(/\{(\d+)\}/g, (token, index) =>
    Number(index) < values.length ? String(values[Number(index)]) : token) : result
}

// Native commands can return diagnostics with a path, node name or OS error embedded.
export function diagnostic(text: string): string {
  if (Object.hasOwn(dictionary, text)) return tr(text)
  if (text.length > 2048 || !/\p{Script=Han}/u.test(text)) return text
  // Native errors can append an OS or engine diagnostic to a translated heading.
  const pieces = /^(.+?)(?:：|: | · |\n)([\s\S]+)$/.exec(text)
  if (pieces && Object.hasOwn(dictionary, pieces[1])) {
    return tr(pieces[1]) + ' · ' + tr(pieces[2])
  }
  for (const { key, slots, pattern } of patterns) {
    const match = pattern.exec(text)
    if (match) {
      const values: string[] = []
      slots.forEach((slot, i) => { values[slot] = match[i + 1] })
      return tr(key, ...values)
    }
  }
  return text
}
