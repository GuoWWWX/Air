import { Globe, ListFilter, MoveRight } from 'lucide-react'
import type { SegmentedOption } from '@/shared/ui/segmented'
import type { ProxyMode, ProxyPowerState } from './state'

export const proxyModes: readonly SegmentedOption<ProxyMode>[] = [
  { value: 'rule', label: '规则', icon: <ListFilter /> },
  { value: 'global', label: '全局', icon: <Globe /> },
  { value: 'direct', label: '直连', icon: <MoveRight /> },
]

export function proxyPowerTone({ running, tun, systemProxy }: ProxyPowerState) {
  if (!running) return 'stopped'
  if (tun) return 'tun'
  return systemProxy ? 'system-proxy' : 'running'
}

export function captureModeLabel(running: boolean, selected: boolean) {
  if (running) return selected ? '已生效' : '未启用'
  return selected ? '已选择，等待手动启动' : '未选择'
}
