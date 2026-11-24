import { diagnostic, tr } from '@/shared/i18n/messages'
interface NativePort {
  postMessage: (payload: string) => void
  onmessage: ((event: MessageEvent<string>) => void) | null
}

declare global {
  interface Window { airAndroid?: NativePort }
}

const port = window.airAndroid
let sequence = 0
type NativeReply = { value?: unknown; error?: string; progress?: number; alias?: string; delay?: number }
const waiters = new Map<string, (reply: NativeReply) => void>()

if (port) {
  port.onmessage = ({ data }) => {
    const reply = JSON.parse(data) as NativeReply & { id: string }
    waiters.get(reply.id)?.(reply)
  }
}

export const onAndroid = Boolean(port)

export function copySubscriptionText(text: string): Promise<unknown> {
  return onAndroid ? native('copy', { text }) : navigator.clipboard.writeText(text)
}

export async function native<T>(
  action: string,
  data?: object,
  onProgress?: (completed: number, alias?: string, delay?: number) => void,
): Promise<T> {
  if (!port) {
    if (action === 'load') return JSON.parse(localStorage.getItem('air.android.preview') ?? '{}')
    if (action === 'save') { localStorage.setItem('air.android.preview', JSON.stringify(data)); return true as T }
    if (action === 'saveOutbound') {
      const saved = JSON.parse(localStorage.getItem('air.android.preview') ?? '{}')
      localStorage.setItem('air.android.preview', JSON.stringify({ ...saved, ...data }))
      return true as T
    }
    if (action === 'status') return { phase: 'idle', traffic: {}, startedAt: 0 } as T
    if (action === 'applications') return {} as T
    if (action === 'theme' || action === 'ready' || action === 'cancelProbe') return true as T
    throw new Error(tr('请在 Android 版 Air 中使用此功能'))
  }
  const activePort = port
  return new Promise<T>((resolve, reject) => {
    const id = String(++sequence)
    const timer = window.setTimeout(() => {
      waiters.delete(id)
      reject(new Error(action === 'start' ? tr('Android VPN 授权等待超时') : tr('操作超时，请重试')))
    }, action === 'start' || (action === 'file' || action === 'export') ? 180_000 : 45_000)
    waiters.set(id, reply => {
      if (reply.progress !== undefined) {
        onProgress?.(reply.progress, reply.alias, reply.delay)
        return
      }
      window.clearTimeout(timer)
      waiters.delete(id)
      if (reply.error) reject(new Error(diagnostic(reply.error)))
      else resolve(reply.value as T)
    })
    try {
      activePort.postMessage(JSON.stringify({ id, action, data }))
    } catch (error) {
      window.clearTimeout(timer)
      waiters.delete(id)
      reject(error)
    }
  })
}
