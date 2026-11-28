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

let previewStatusTick = 0
let previewConnTick = 0
const previewUploadWave = [28, 195, 62, 340, 88, 34, 460, 124, 46, 305, 76, 220, 30, 490, 118, 285, 174]
const previewDownloadWave = [420, 2650, 740, 5120, 1240, 320, 6480, 1640, 580, 3920, 960, 2780, 450, 6720, 1480, 4240, 2360]

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
    if (action === 'status') {
      const saved = JSON.parse(localStorage.getItem('air.android.preview.status') ?? 'null') as {
        phase?: string
        startedAt?: number
        port?: number
        traffic?: { up?: number; down?: number }
        totals?: { up?: number; down?: number }
      } | null
      if (saved?.phase === 'running') {
        const idx = previewStatusTick++ % previewUploadWave.length
        const up = Math.round(previewUploadWave[idx]! * (0.9 + Math.random() * 0.2)) * 1024
        const down = Math.round(previewDownloadWave[idx]! * (0.9 + Math.random() * 0.2)) * 1024
        const next = {
          ...saved,
          traffic: { up, down },
          totals: {
            up: (saved.totals?.up ?? 0) + up,
            down: (saved.totals?.down ?? 0) + down,
          },
        }
        localStorage.setItem('air.android.preview.status', JSON.stringify(next))
        return next as T
      }
      return (saved ?? { phase: 'idle', traffic: {}, startedAt: 0 }) as T
    }
    if (action === 'kernelInfo') {
      return (JSON.parse(localStorage.getItem('air.android.preview.kernel') ?? 'null')
        ?? { version: 'v1.19.34', abi: 'arm64-v8a', sdk: 36, appVersion: '1.1.6' }) as T
    }
    if (action === 'updateStatus') {
      return {
        current: '1.1.6',
        phase: 'idle',
        ignored: false,
        progress: { received: 0, total: 0, speed: 0, reused: 0, apkSize: 0 },
      } as T
    }
    if (action === 'exit') {
      const savedExit = localStorage.getItem('air.android.preview.exit')
      if (savedExit) return JSON.parse(savedExit) as T
    }
    if (action === 'connections') {
      const savedConnections = localStorage.getItem('air.android.preview.connections')
      if (savedConnections) {
        const parsed = JSON.parse(savedConnections) as {
          revision?: number
          connections?: Array<{ upload?: number; download?: number }>
        }
        const tick = previewConnTick++
        const nextConnections = (parsed.connections ?? []).map((row, i) => ({
          ...row,
          download: (row.download ?? 0) + (i === 0 ? 1_450_000 : i === 1 ? 520_000 : 180_000) + (tick % 3) * 45_000,
          upload: (row.upload ?? 0) + (i === 0 ? 120_000 : i === 1 ? 68_000 : 32_000) + (tick % 2) * 14_000,
        }))
        const next = { revision: (parsed.revision ?? 1) + 1, connections: nextConnections }
        localStorage.setItem('air.android.preview.connections', JSON.stringify(next))
        return next as T
      }
    }
    if (action === 'applications') return {} as T
    if (action === 'theme' || action === 'ready' || action === 'cancelProbe') return true as T
    throw new Error(tr('请在 Android 版 Air Proxy 中使用此功能'))
  }
  const activePort = port
  return new Promise<T>((resolve, reject) => {
    const id = String(++sequence)
    const probeCount = action === 'probe' && data && 'aliases' in data && Array.isArray(data.aliases)
      ? Math.min(72, data.aliases.length) : 0
    const timer = window.setTimeout(() => {
      waiters.delete(id)
      reject(new Error(action === 'start' ? tr('Android VPN 授权等待超时') : tr('操作超时，请重试')))
    }, action === 'start' || (action === 'file' || action === 'export') ? 180_000 : 45_000 + probeCount * 5_000)
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
