import { tr } from '@/shared/i18n/messages'
import { useSyncExternalStore } from 'react'
import { air, type ImportInput } from '@/platform/desktop/air'
import { showMessage } from '@/shared/ui/message'

export interface PendingSubscriptionImport {
  id: string
  label: string
  sourceHost: string
  kind: 'url' | 'file' | 'qr'
  startedAt: number
}

let tasks: PendingSubscriptionImport[] = []
const listeners = new Set<() => void>()

function publish(next: PendingSubscriptionImport[]) {
  tasks = next
  listeners.forEach(listener => listener())
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

const snapshot = () => tasks

export function usePendingSubscriptionImports() {
  return useSyncExternalStore(subscribe, snapshot)
}

function formatSourceHost(input: ImportInput) {
  if (input.kind === 'file') return input.filename
  try {
    return new URL(input.url).hostname || input.url
  } catch {
    return input.url
  }
}

export function startBackgroundSubscriptionImport(
  input: ImportInput,
  onImported: () => Promise<void>,
) {
  const sourceHost = formatSourceHost(input)
  const label = input.name.trim() || sourceHost || tr('新订阅')
  const id = crypto.randomUUID()
  const task: PendingSubscriptionImport = {
    id,
    label,
    sourceHost,
    kind: input.kind === 'file' ? 'file' : input.qr ? 'qr' : 'url',
    startedAt: Date.now(),
  }

  publish([task, ...tasks])

  void (async () => {
    try {
      const preview = await air.previewSubscription(input)
      const name = await air.importSubscription(input.kind === 'file' ? input : {
        ...input,
        profileTitle: preview.profileTitle,
        yaml: preview.yaml,
        usage: preview.usage,
        intervalHours: preview.intervalHours,
      })
      await onImported()
      showMessage({
        type: 'success',
        title: tr("订阅已导入 · {0}", name),
        description: tr("{0} 个节点 · {1} 个分组", preview.nodes, preview.groups),
      })
    } catch (failure) {
      const reason = failure instanceof Error ? failure.message : String(failure)
      showMessage({
        type: 'error',
        title: tr("导入订阅失败 · {0}", label),
        description: reason,
      })
    } finally {
      publish(tasks.filter(item => item.id !== id))
    }
  })()
}
