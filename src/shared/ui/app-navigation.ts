import { Activity, CloudDownload, LayoutDashboard, Network, Settings } from 'lucide-react'
import type { TargetAndTransition, Transition } from 'motion/react'

export const ICON_SPRING: Transition = { type: 'spring', stiffness: 460, damping: 24 }
export const BUTTON_SPRING: Transition = { type: 'spring', stiffness: 520, damping: 28 }

export const navigation = [
  {
    id: 'home',
    label: '仪表盘',
    icon: LayoutDashboard,
    hoverAnimate: { scale: 1.12 } satisfies TargetAndTransition,
    hoverTransition: ICON_SPRING,
  },
  {
    id: 'nodes',
    label: '节点库',
    icon: Network,
    hoverAnimate: { scale: 1.12, rotate: 8 } satisfies TargetAndTransition,
    hoverTransition: ICON_SPRING,
  },
  {
    id: 'subscriptions',
    label: '订阅',
    icon: CloudDownload,
    hoverAnimate: { y: [0, 2.5, 0], scale: 1.06 } satisfies TargetAndTransition,
    hoverTransition: { duration: 0.36, ease: 'easeOut' } satisfies Transition,
  },
  {
    id: 'connections',
    label: '连接日志',
    icon: Activity,
    hoverAnimate: { scale: [1, 1.2, 1.06] } satisfies TargetAndTransition,
    hoverTransition: { duration: 0.34, ease: 'easeOut' } satisfies Transition,
  },
  {
    id: 'settings',
    label: '设置',
    icon: Settings,
    hoverAnimate: { rotate: 45, scale: 1.08 } satisfies TargetAndTransition,
    hoverTransition: { type: 'spring', stiffness: 420, damping: 24 } satisfies Transition,
  },
] as const

export type NavItem = (typeof navigation)[number]
export type Page = NavItem['id']
