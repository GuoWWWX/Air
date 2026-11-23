import { tr } from '@/shared/i18n/messages'
import { Globe, ListFilter, MoveRight } from 'lucide-react'
import type { SegmentedOption } from '@/shared/ui/segmented'
import type { ProxyMode, ProxyPowerState } from './state'

export const proxyModes: readonly SegmentedOption<ProxyMode>[] = [
  { value: 'rule', get label() { return tr('规则') }, icon: <ListFilter /> },
  { value: 'global', get label() { return tr('全局') }, icon: <Globe /> },
  { value: 'direct', get label() { return tr('直连') }, icon: <MoveRight /> },
]

export function proxyPowerTone({ running, tun, systemProxy }: ProxyPowerState) {
  if (!running) return 'stopped'
  if (tun) return 'tun'
  return systemProxy ? 'system-proxy' : 'running'
}

export function captureModeLabel(running: boolean, selected: boolean) {
  if (running) return selected ? tr('已生效') : tr('未启用')
  return selected ? tr('已选择，等待手动启动') : tr('未选择')
}
