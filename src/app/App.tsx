import { preferences } from '@/shared/lib/preferences'
import airLogo from '@/assets/air-m1.svg?no-inline'
import { diagnostic, tr, useLanguage } from '@/shared/i18n/messages'
import { invoke, isTauri } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import {
  AlertCircle,
  ArrowDownToLine,
  Cpu,
  PanelLeftClose,
  PanelLeftOpen,
  X,
} from 'lucide-react'
import { MotionConfig } from 'motion/react'
import { Activity, memo, startTransition, useCallback, useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from 'react'
import { cn } from '@/shared/lib/utils'
import { Button } from '@/shared/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/shared/ui/dialog'
import { MessageViewport, showMessage } from '@/shared/ui/message'
import { DashboardBlocksIcon, HeartbeatIcon } from '@/shared/ui/PageHeaderIcon'
import { navigation, type NavItem, type Page } from '@/shared/ui/app-navigation'
import { AppTitlebar } from './AppTitlebar'
import { useSystemTheme } from './systemTheme'
import { ChainInspector } from '../features/chains/ChainInspector'
import { ConnectionPolicyDialog } from '../features/connections/ConnectionPolicyDialog'
import { ConnectionsPage } from '../features/connections/ConnectionsPage'
import { Dashboard } from '../features/home/Dashboard'
import { CustomNodeInspector } from '../features/nodes/CustomNodeInspector'
import { NodeInspector } from '../features/nodes/NodeInspector'
import { NodeLatencyButton } from '@/shared/ui/NodeLatencyButton'
import { NodeLibrary } from '../features/nodes/NodeLibrary'
import { useNodes } from '../features/nodes/useNodes'
import { useProxy } from '../features/proxy/useProxy'
import { RoutingSettings } from '../features/settings/RoutingSettings'
import { SettingsView, type SettingsPage, type ThemeMode } from '../features/settings/SettingsView'
import { Subscriptions } from '../features/subscriptions/Subscriptions'
import { useSelectedSubscriptions } from '../features/subscriptions/useSelectedSubscriptions'
import { YamlEditor } from '../features/subscriptions/YamlEditor'
import { UpdateDialog } from '../features/updates/UpdateDialog'
import { useUpdates } from '../features/updates/useUpdates'
import {
  air,
  type ChainProbeResult,
  type ChainRecord,
  type NodeRecord,
  type ProxyAction,
  type ProxyConnection,
  type ProxyTarget,
} from '@/platform/desktop/air'

type TrayAction =
  | Exclude<ProxyAction, { action: 'start' | 'selectNode' }>
  | { action: 'start' }
  | { action: 'reportError'; message: string }

const NAV_ICON_HOVER: Partial<Record<Page, string>> = {
  nodes: 'group-hover:scale-110 group-hover:rotate-6',
  subscriptions: 'group-hover:translate-y-0.5 group-hover:scale-105',
  settings: 'group-hover:rotate-45 group-hover:scale-105',
}

function SidebarNavButton({
  item,
  active,
  collapsed,
  onClick,
}: {
  item: NavItem
  active: boolean
  collapsed: boolean
  onClick: () => void
}) {
  const [playCount, setPlayCount] = useState(0)
  const Icon = item.icon
  const iconClassName = cn(
    'size-5 shrink-0 stroke-[1.9] transition-[transform,color] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)]',
    active
      ? 'text-primary'
      : 'text-secondary-foreground/75 group-hover:text-primary',
    NAV_ICON_HOVER[item.id],
  )

  return (
    <button
      type="button"
      title={collapsed ? item.label : undefined}
      aria-label={item.label}
      aria-current={active ? 'page' : undefined}
      onMouseEnter={
        item.id === 'home' || item.id === 'connections'
          ? () => setPlayCount(count => count + 1)
          : undefined
      }
      onClick={onClick}
      className={cn(
        'group relative z-10 flex h-10 w-full items-center justify-start overflow-hidden rounded-[8px] px-0 text-sm outline-none transition-[transform,color,background-color] duration-150 active:scale-[0.97] focus-visible:ring-2 focus-visible:ring-ring/60 motion-reduce:transition-none',
        active
          ? 'font-semibold text-primary'
          : 'font-medium text-secondary-foreground/80 hover:bg-accent-soft/85 hover:text-primary',
      )}
    >
      {item.id === 'home' ? (
        <span className="relative z-10 grid size-10 shrink-0 place-items-center">
          <DashboardBlocksIcon key={playCount} animate={playCount > 0} strokeWidth={1.9} className={iconClassName} />
        </span>
      ) : item.id === 'connections' ? (
        <span className="relative z-10 grid size-10 shrink-0 place-items-center">
          <HeartbeatIcon key={playCount} animate={playCount > 0} strokeWidth={1.9} className={iconClassName} />
        </span>
      ) : (
        <span className="relative z-10 grid size-10 shrink-0 place-items-center">
          <Icon className={iconClassName} />
        </span>
      )}
      <span
        aria-hidden={collapsed}
        className={cn(
          'relative z-10 whitespace-nowrap pr-3 transition-[opacity,transform] duration-150 motion-reduce:transition-none',
          collapsed ? 'pointer-events-none -translate-x-1 opacity-0' : 'translate-x-0 opacity-100',
        )}
      >
        {item.label}
      </span>
    </button>
  )
}

function SidebarKernelButton({
  collapsed,
  kernelPath,
  background,
  onClick,
}: {
  collapsed: boolean
  kernelPath: string
  background: boolean
  onClick: () => void
}) {
  const kernelLabel = kernelPath
    ? background
      ? tr('诊断内核：窗口收起后自动测速')
      : tr('诊断内核：内核就绪 · 点击管理')
    : tr('诊断内核：未配置 Mihomo 路径')

  return (
    <button
      type="button"
      title={collapsed ? kernelLabel : undefined}
      aria-label={kernelLabel}
      onClick={onClick}
      className="group relative flex h-11 w-full items-center overflow-hidden rounded-[9px] border border-border-subtle bg-muted/45 px-0 text-left text-secondary-foreground/80 outline-none transition-[transform,color,background-color,border-color] duration-150 active:scale-[0.97] hover:border-accent-border hover:bg-accent-soft/85 hover:text-primary focus-visible:ring-2 focus-visible:ring-ring/60 motion-reduce:transition-none"
    >
      <span className="grid h-11 w-10 shrink-0 place-items-center">
        <Cpu className="size-5 stroke-[1.9] text-secondary-foreground/75 transition-[transform,color] duration-150 group-hover:scale-110 group-hover:text-primary" />
      </span>
      <div
        aria-hidden={collapsed}
        className={cn(
          'min-w-0 flex-1 pr-4 transition-[opacity,transform] duration-150 motion-reduce:transition-none',
          collapsed ? 'pointer-events-none -translate-x-1 opacity-0' : 'translate-x-0 opacity-100',
        )}
      >
        <div className="truncate text-[13px] leading-tight font-semibold text-foreground transition-colors group-hover:text-primary">
          {tr('诊断内核')}
        </div>
        <div className="mt-0.5 truncate text-[11.5px] leading-tight text-muted-foreground">
          {kernelPath
            ? background
              ? tr('收起后自动测速')
              : tr('内核就绪 · 点击管理')
            : tr('未配置 Mihomo 路径')}
        </div>
      </div>
      <span className={cn('absolute top-2 right-2 size-1.5 rounded-full', kernelPath ? 'bg-success' : 'bg-warning')} />
    </button>
  )
}

function SidebarCollapseButton({
  collapsed,
  onClick,
}: {
  collapsed: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      aria-label={collapsed ? tr('展开侧栏') : tr('收起侧栏')}
      title={collapsed ? tr('展开侧栏') : tr('收起侧栏')}
      onClick={onClick}
      className="group flex h-10 w-full items-center overflow-hidden rounded-[8px] px-0 text-secondary-foreground/80 outline-none transition-[transform,color,background-color] duration-150 active:scale-[0.97] hover:bg-accent-soft/85 hover:text-primary focus-visible:ring-2 focus-visible:ring-ring/60 motion-reduce:transition-none"
    >
      <span className="grid size-10 shrink-0 place-items-center">
        <span
          className={cn(
            'grid place-items-center transition-transform duration-150',
            collapsed ? 'group-hover:translate-x-0.5 group-hover:scale-105' : 'group-hover:-translate-x-0.5 group-hover:scale-105',
          )}
        >
          {collapsed ? (
            <PanelLeftOpen className="size-5 shrink-0 stroke-[1.9]" />
          ) : (
            <PanelLeftClose className="size-5 shrink-0 stroke-[1.9]" />
          )}
        </span>
      </span>
      <span
        aria-hidden={collapsed}
        className={cn(
          'whitespace-nowrap pr-3 text-sm font-medium transition-[opacity,transform] duration-150 motion-reduce:transition-none',
          collapsed ? 'pointer-events-none -translate-x-1 opacity-0' : 'translate-x-0 opacity-100',
        )}
      >
        {tr('收起侧栏')}
      </span>
    </button>
  )
}

interface AppSidebarProps {
  page: Page
  kernelPath: string
  background: boolean
  updateVersion?: string
  updateBusy: boolean
  onNavigate: (target: Page) => void
  onOpenUpdate: () => void
  onOpenKernel: () => void
}

const AppSidebar = memo(function AppSidebar({
  page,
  kernelPath,
  background,
  updateVersion,
  updateBusy,
  onNavigate,
  onOpenUpdate,
  onOpenKernel,
}: AppSidebarProps) {
  useLanguage()
  const [collapsed, setCollapsed] = useState(() => preferences.getItem('air.sidebarCollapsed') === '1')
  const didMount = useRef(false)
  useEffect(() => {
    if (!didMount.current) {
      didMount.current = true
      return
    }
    const timer = window.setTimeout(() => {
      preferences.setItem('air.sidebarCollapsed', collapsed ? '1' : '0')
    }, 240)
    return () => window.clearTimeout(timer)
  }, [collapsed])

  const [visualPage, setVisualPage] = useState<Page>(page)
  const [prevPropPage, setPrevPropPage] = useState<Page>(page)
  if (page !== prevPropPage) {
    setPrevPropPage(page)
    setVisualPage(page)
  }
  const activeIndex = Math.max(0, navigation.findIndex(item => item.id === visualPage))

  function handleSelect(target: Page) {
    if (target === visualPage && target === page) return
    setVisualPage(target)
    startTransition(() => {
      onNavigate(target)
    })
  }

  return (
    <nav
      aria-label={tr('主导航')}
      data-tauri-drag-region="deep"
      className={cn(
        'flex shrink-0 flex-col justify-between overflow-hidden border-r border-border bg-shell px-2 pb-3 select-none [contain:layout_style] transition-[width] duration-[180ms] ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none',
        collapsed ? 'w-14' : 'w-[176px]',
      )}
    >
      <div className="flex flex-col">
        <div
          data-tauri-drag-region
          className="flex h-10.5 shrink-0 items-center overflow-hidden"
        >
          <div
            className={cn(
              'pointer-events-none flex items-center gap-2 transition-transform duration-[180ms] ease-[cubic-bezier(0.22,1,0.36,1)] will-change-transform motion-reduce:transition-none',
              collapsed ? 'translate-x-[6px]' : 'translate-x-[28px]',
            )}
          >
            <img
              src={airLogo}
              alt="Air Proxy"
              draggable={false}
              className="size-7 shrink-0"
            />
            <strong
              aria-hidden={collapsed}
              className={cn(
                'whitespace-nowrap text-[15px] leading-none font-bold tracking-tight text-foreground transition-[opacity,transform] duration-150 motion-reduce:transition-none',
                collapsed ? '-translate-x-1 opacity-0' : 'translate-x-0 opacity-100',
              )}
            >
              Air Proxy
            </strong>
          </div>
        </div>

        <div className="relative mt-2 flex flex-col gap-1">
          <span
            aria-hidden="true"
            style={{ transform: `translate3d(0, ${activeIndex * 44}px, 0)` }}
            className="pointer-events-none absolute inset-x-0 top-0 z-0 h-10 rounded-[8px] border border-accent-border/45 bg-accent-soft transition-transform duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] will-change-transform motion-reduce:transition-none"
          />
          {navigation.map(item => (
            <SidebarNavButton
              key={item.id}
              item={item}
              active={visualPage === item.id}
              collapsed={collapsed}
              onClick={() => handleSelect(item.id)}
            />
          ))}
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        {updateVersion && (
          <Button
            variant="secondary"
            size="sm"
            aria-label={tr('软件更新')}
            title={`Air ${updateVersion}`}
            onClick={onOpenUpdate}
            className="h-10 w-full justify-start gap-0 overflow-hidden px-0 text-sm"
          >
            <span className="grid size-10 shrink-0 place-items-center">
              <ArrowDownToLine className="size-5 shrink-0" />
            </span>
            <span
              aria-hidden={collapsed}
              className={cn(
                'whitespace-nowrap pr-3 transition-[opacity,transform] duration-150 motion-reduce:transition-none',
                collapsed ? 'pointer-events-none -translate-x-1 opacity-0' : 'translate-x-0 opacity-100',
              )}
            >
              {updateBusy ? tr('正在更新') : tr('软件更新')}
            </span>
          </Button>
        )}
        <SidebarKernelButton
          collapsed={collapsed}
          kernelPath={kernelPath}
          background={background}
          onClick={onOpenKernel}
        />

        <SidebarCollapseButton
          collapsed={collapsed}
          onClick={() => setCollapsed(prev => !prev)}
        />
      </div>
    </nav>
  )
})

type InspectorState =
  | { kind: 'none' }
  | { kind: 'node'; id: string }
  | { kind: 'custom'; id?: string; groupId?: string }
  | { kind: 'chain' }

const DEMO_CHAIN: ChainRecord = {
  id: 'demo-chain-3hop',
  get name() { return tr('港日美三跳') },
  hops: ['demo-hk-01', 'demo-jp-03', 'demo-custom-us'],
}

function loadSavedChains(): ChainRecord[] {
  try {
    const raw = preferences.getItem('air.chains')
    const parsed: unknown = raw ? JSON.parse(raw) : []
    const valid = Array.isArray(parsed)
      ? parsed.filter(
          (item): item is ChainRecord =>
            Boolean(item) &&
            typeof item === 'object' &&
            typeof (item as ChainRecord).id === 'string' &&
            typeof (item as ChainRecord).name === 'string' &&
            Array.isArray((item as ChainRecord).hops) &&
            (item as ChainRecord).hops.length >= 2 &&
            (item as ChainRecord).hops.every(hop => typeof hop === 'string'),
        )
      : []
    if (!valid.length && !isTauri() && preferences.getItem('air.demoChainsSeeded') !== '1') {
      preferences.setItem('air.demoChainsSeeded', '1')
      preferences.setItem('air.chains', JSON.stringify([DEMO_CHAIN]))
      preferences.setItem('air.activeChainId', DEMO_CHAIN.id)
      return [DEMO_CHAIN]
    }
    return valid
  } catch {
    return []
  }
}

export function App() {
  useLanguage()
  const store = useNodes()
  const { refresh, poll, batchPending } = store
  const {
    selectedSubscriptionIds,
    setSelectedSubscriptionIds,
    selectAllSubscriptions,
    totalSubscriptionCount,
  } = useSelectedSubscriptions(store.library.sources, store.loaded)
  const [nav, setNav] = useState<{
    page: Page
    visited: Record<Page, boolean>
    visits: Record<Page, number>
  }>({
    page: 'home',
    visited: { home: true, nodes: false, subscriptions: false, connections: false, settings: false },
    visits: { home: 1, nodes: 0, subscriptions: 0, connections: 0, settings: 0 },
  })
  const { page, visited, visits } = nav
  const [settingsPage, setSettingsPage] = useState<SettingsPage>('overview')
  const [ready, setReady] = useState(false)

  const activatePage = useCallback((target: Page) => {
    setNav(current => {
      if (current.page === target && current.visited[target]) return current
      return {
        page: target,
        visited: current.visited[target] ? current.visited : { ...current.visited, [target]: true },
        visits: current.page === target
          ? current.visits
          : { ...current.visits, [target]: current.visits[target] + 1 },
      }
    })
  }, [])
  const [routingReturn, setRoutingReturn] = useState<'settings' | 'nodes'>('settings')
  const [inspector, setInspector] = useState<InspectorState>({ kind: 'none' })
  const [subscriptionNode, setSubscriptionNode] = useState('')
  const [yaml, setYaml] = useState('')
  const [theme, setTheme] = useState<ThemeMode>(() => {
    const stored = preferences.getItem('air.theme')
    return stored === 'dark' || stored === 'system' ? stored : 'light'
  })
  const systemDark = useSystemTheme(theme)
  const [chains, setChains] = useState<ChainRecord[]>(loadSavedChains)
  const [preferredGroupId, setPreferredGroupId] = useState(() => preferences.getItem('air.preferredGroupId') ?? undefined)
  const [preferredNodeId, setPreferredNodeId] = useState(() => preferences.getItem('air.preferredNodeId') ?? '')
  const preferenceVersion = useRef(0)
  const [activeChainId, setActiveChainId] = useState<string>(() => {
    const storedId = preferences.getItem('air.activeChainId') ?? ''
    return chains.some(item => item.id === storedId) ? storedId : ''
  })
  const [initialChain] = useState(() => {
    const saved = chains.find(item => item.id === activeChainId)
    try {
      const draft = JSON.parse(preferences.getItem('air.chainDraft') ?? 'null') as ChainRecord | null
      if (draft?.id === activeChainId && typeof draft.name === 'string' && Array.isArray(draft.hops)
        && draft.hops.length >= 2 && draft.hops.every(hop => typeof hop === 'string')) return draft
    } catch { /* Use the saved chain when an older draft cannot be read. */ }
    return saved
  })
  const [chainName, setChainName] = useState(() => initialChain?.name ?? '')
  const [hops, setHops] = useState<string[]>(() => initialChain?.hops ?? ['', ''])
  const [activeHopIndex, setActiveHopIndex] = useState<number | null>(0)
  const [chainProbe, setChainProbe] = useState<{ key: string; result: ChainProbeResult }>()
  const [tunSetup, setTunSetup] = useState<'install' | 'enable' | null>(null)
  const [installingTun, setInstallingTun] = useState(false)
  const [policyConnection, setPolicyConnection] = useState<ProxyConnection | null>(null)
  const [kernelDraft, setKernelDraft] = useState(store.kernelOverride)

  const selectedNode =
    inspector.kind === 'node'
      ? store.library.nodes.find(node => node.id === inspector.id)
      : undefined
  const subscriptionItem = store.library.nodes.find(node => node.id === subscriptionNode)
  const preferredNode = store.library.nodes.find(node => node.id === preferredNodeId)
  const activeTheme = theme === 'system' ? (systemDark ? 'dark' : 'light') : theme
  const running = store.progress?.running
  const probeKey = JSON.stringify(hops.map(id => [id, store.library.nodes.find(node => node.id === id)?.probeRevision]))
  const probe = chainProbe?.key === probeKey ? chainProbe.result : undefined
  const verified = probe && 'ip' in probe ? probe : undefined

  const onError = useCallback((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    showMessage({ title: diagnostic(message), id: message, type: 'error' })
  }, [])
  const closePolicyDialog = useCallback(() => setPolicyConnection(null), [])
  const proxy = useProxy(onError, { liveTelemetry: page === 'home' || page === 'connections' })
  const { refreshNow: refreshProxyNow } = proxy
  const updates = useUpdates(onError)
  const activeOutbound = proxy.status.running && proxy.status.mode !== 'direct'
    ? proxy.status.outbound?.hops.at(-1)
    : undefined
  const titlebarNode = proxy.status.running
    ? activeOutbound && store.library.nodes.find(node => node.id === activeOutbound.id)
    : preferredNode

  useLayoutEffect(() => {
    document.documentElement.dataset.theme = activeTheme
    document.documentElement.classList.toggle('dark', activeTheme === 'dark')
    if (isTauri()) {
      void invoke('set_window_background', { dark: activeTheme === 'dark' }).catch(() => undefined)
    }
  }, [activeTheme])

  useEffect(() => {
    if (!ready) return
    const boot = document.getElementById('air-boot')
    if (!boot) return
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const minDisplayMs = reducedMotion ? 0 : 520
    const shownAt = window.__airSplashShownAt ?? 0
    const elapsed = shownAt > 0 ? performance.now() - shownAt : 0
    const waitMs = Math.max(0, minDisplayMs - elapsed)
    let removed = false
    let frame = 0
    let leaveTimer = 0
    const remove = () => {
      if (removed) return
      removed = true
      window.clearTimeout(leaveTimer)
      boot.remove()
    }
    const startTimer = window.setTimeout(() => {
      frame = window.requestAnimationFrame(() => {
        if (reducedMotion) {
          remove()
          return
        }
        boot.addEventListener('transitionend', remove, { once: true })
        leaveTimer = window.setTimeout(remove, 340)
        boot.classList.add('air-boot-leaving')
      })
    }, waitMs)
    return () => {
      window.clearTimeout(startTimer)
      window.cancelAnimationFrame(frame)
      window.clearTimeout(leaveTimer)
      boot.removeEventListener('transitionend', remove)
    }
  }, [ready])

  useEffect(() => {
    preferences.setItem('air.theme', theme)
    try { localStorage.setItem('air.bootTheme', theme) } catch {}
  }, [theme])

  useEffect(() => {
    preferences.setItem('air.chains', JSON.stringify(chains))
  }, [chains])

  useEffect(() => {
    preferences.setItem('air.activeChainId', activeChainId)
    preferences.setItem('air.chainDraft', JSON.stringify({ id: activeChainId, name: chainName, hops }))
  }, [activeChainId, chainName, hops])

  useEffect(() => {
    let active = true
    void refresh()
      .catch(onError)
      .finally(() => {
        if (active) setReady(true)
      })
    return () => { active = false }
  }, [refresh, onError])

  useEffect(() => {
    const blockBrowserContextMenu = (event: MouseEvent) => {
      if (event.defaultPrevented) return
      const target = event.target instanceof Element ? event.target : null
      if (target?.closest('input, textarea, [contenteditable="true"]')) return
      event.preventDefault()
    }
    document.addEventListener('contextmenu', blockBrowserContextMenu)
    return () => document.removeEventListener('contextmenu', blockBrowserContextMenu)
  }, [])

  useEffect(() => {
    if (!batchPending && !running) return
    let polling = false
    const timer = window.setInterval(async () => {
      if (document.hidden || polling) return
      polling = true
      try {
        await poll()
      } catch (error) {
        onError(error)
      } finally {
        polling = false
      }
    }, 650)
    return () => window.clearInterval(timer)
  }, [batchPending, running, poll, onError])

  const lastActivatedPage = useRef<Page>(page)
  useEffect(() => {
    if (lastActivatedPage.current === page) return
    lastActivatedPage.current = page
    const timer = window.setTimeout(() => {
      if (page === 'home') {
        void refresh().catch(onError)
        refreshProxyNow()
      } else if (page === 'nodes') {
        void Promise.all([refresh(), poll()]).catch(onError)
      } else if (page === 'subscriptions') {
        void refresh().catch(onError)
      } else if (page === 'connections') {
        refreshProxyNow()
      }
    }, 220)
    return () => window.clearTimeout(timer)
  }, [page, refresh, poll, onError, refreshProxyNow])

  useEffect(() => {
    const syncResults = () => {
      if (!document.hidden) void refresh().catch(onError)
    }
    window.addEventListener('focus', syncResults)
    document.addEventListener('visibilitychange', syncResults)
    return () => {
      window.removeEventListener('focus', syncResults)
      document.removeEventListener('visibilitychange', syncResults)
    }
  }, [refresh, onError])

  const navigate = useCallback((target: Page) => {
    activatePage(target)
    setSettingsPage('overview')
  }, [activatePage])

  const openSettings = useCallback((target: SettingsPage) => {
    setSettingsPage(target)
    activatePage('settings')
  }, [activatePage])

  const setUpdateOpen = updates.setOpen
  const handleSidebarUpdate = useCallback(() => setUpdateOpen(true), [setUpdateOpen])
  const kernelPath = store.kernelPath
  const handleSidebarKernel = useCallback(() => {
    openSettings(kernelPath ? 'monitoring' : 'kernel')
  }, [kernelPath, openSettings])

  function openRouting(from: 'settings' | 'nodes') {
    setRoutingReturn(from)
    openSettings('routing')
  }

  function openNode(node: NodeRecord) {
    activatePage('nodes')
    if (node.sourceId === 'custom') {
      setInspector({ kind: 'custom', id: node.id })
    } else {
      setInspector({ kind: 'node', id: node.id })
    }
  }

  function openAddCustom(groupId?: string) {
    activatePage('nodes')
    setInspector({ kind: 'custom', groupId })
  }

  function openChain() {
    activatePage('nodes')
    setInspector({ kind: 'chain' })
    let nextHops = hops
    if (hops.every(id => !id) && store.selected.length > 0) {
      nextHops =
        store.selected.length >= 2
          ? [...store.selected]
          : [store.selected[0]!, '']
      setHops(nextHops)
    }
    const firstEmpty = nextHops.findIndex(id => !id)
    setActiveHopIndex(firstEmpty !== -1 ? firstEmpty : 0)
  }

  function toggleChain() {
    if (inspector.kind === 'chain') {
      setInspector({ kind: 'none' })
      return
    }
    openChain()
  }

  function assignNodeToHop(nodeId: string, explicitTarget?: number) {
    const next = [...hops]
    const target =
      explicitTarget !== undefined && explicitTarget >= 0 && explicitTarget < next.length
        ? explicitTarget
        : activeHopIndex !== null && activeHopIndex < next.length
          ? activeHopIndex
          : Math.max(0, next.findIndex(id => !id))
    const existingIndex = next.indexOf(nodeId)
    if (existingIndex !== -1 && existingIndex !== target) {
      next[existingIndex] = next[target] ?? ''
    }
    next[target] = nodeId
    setHops(next)

    const afterEmpty = next.findIndex((id, index) => index > target && !id)
    const anyEmpty = afterEmpty !== -1 ? afterEmpty : next.findIndex(id => !id)
    setActiveHopIndex(anyEmpty !== -1 ? anyEmpty : target)
  }

  function assignChainRole(nodeId: string, role: 'front' | 'transit' | 'exit') {
    activatePage('nodes')
    setInspector({ kind: 'chain' })
    if (role === 'front') {
      assignNodeToHop(nodeId, 0)
      return
    }
    if (role === 'exit') {
      assignNodeToHop(nodeId, Math.max(1, hops.length - 1))
      return
    }
    const next = [...hops]
    const emptyMiddle = next.findIndex((id, index) => index > 0 && index < next.length - 1 && !id)
    if (emptyMiddle !== -1) {
      assignNodeToHop(nodeId, emptyMiddle)
      return
    }
    const existing = next.indexOf(nodeId)
    if (existing > 0 && existing < next.length - 1) {
      setActiveHopIndex(existing)
      return
    }
    if (existing !== -1) next[existing] = ''
    const insertAt = Math.max(1, next.length - 1)
    next.splice(insertAt, 0, nodeId)
    setHops(next)
    setActiveHopIndex(insertAt)
  }

  async function deleteCustomNodeById(nodeId: string) {
    try {
      await air.deleteCustomNode(nodeId)
      await handleCustomDeleted(nodeId)
      showMessage({ type: 'success', title: tr('自定义节点已删除') })
    } catch (error) {
      onError(error)
    }
  }

  async function refreshSubscriptionSource(sourceId: string) {
    try {
      await air.refreshSubscription(sourceId)
      await reload()
      showMessage({ type: 'success', title: tr('订阅已刷新') })
    } catch (error) {
      onError(error)
    }
  }

  function selectSavedChain(id: string) {
    const found = chains.find(item => item.id === id)
    if (!found) return
    clearPreferredNode()
    setActiveChainId(found.id)
    setChainName(found.name)
    setHops([...found.hops])
    const firstEmpty = found.hops.findIndex(hop => !hop)
    setActiveHopIndex(firstEmpty !== -1 ? firstEmpty : 0)
  }

  function startNewChain() {
    setActiveChainId('')
    setChainName('')
    setHops(['', ''])
    setActiveHopIndex(0)
  }

  async function saveChain() {
    const nodeMap = new Map(store.library.nodes.map(node => [node.id, node]))
    if (hops.length < 2 || hops.some(id => !id || !nodeMap.has(id))) {
      throw new Error(tr('请为每一跳选择有效节点后再保存'))
    }
    await air.validateChain(hops)
    const firstNode = nodeMap.get(hops[0]!)!
    const lastNode = nodeMap.get(hops[hops.length - 1]!)!
    const finalName = chainName.trim() || `${firstNode.name} → ${lastNode.name}`
    const id =
      activeChainId && chains.some(item => item.id === activeChainId)
        ? activeChainId
        : `chain-${Date.now().toString(36)}`
    const record: ChainRecord = { id, name: finalName, hops: [...hops], inheritExitRules: chains.some(chain => chain.id === id) ? chains.find(chain => chain.id === id)?.inheritExitRules : false }
    clearPreferredNode()
    setChains(prev => {
      const idx = prev.findIndex(item => item.id === id)
      if (idx !== -1) return prev.map(item => (item.id === id ? record : item))
      return [...prev, record]
    })
    setActiveChainId(current => current === activeChainId ? id : current)
    setChainName(current => current === chainName ? finalName : current)
  }

  function deleteSavedChain(id: string) {
    const nextChains = chains.filter(item => item.id !== id)
    setChains(nextChains)
    showMessage({ type: 'success', title: tr('链路已删除') })
    if (activeChainId === id) {
      const next = nextChains[0]
      if (next) {
        setActiveChainId(next.id)
        setChainName(next.name)
        setHops([...next.hops])
        setActiveHopIndex(0)
      } else {
        startNewChain()
      }
    }
  }

  async function handleCustomSaved(id: string, groupId?: string) {
    if (groupId) await store.addNodesToCustomGroup(groupId, [id])
    setInspector({ kind: 'none' })
    await reload()
  }

  async function handleCustomDeleted(deletedId: string) {
    setChains(prev =>
      prev.map(item => ({
        ...item,
        hops: item.hops.map(hop => (hop === deletedId ? '' : hop)),
      })),
    )
    setHops(prev => prev.map(hop => (hop === deletedId ? '' : hop)))
    setInspector({ kind: 'none' })
    await reload()
  }

  function handleSourceDeleted(sourceId: string) {
    const deleted = new Set(
      store.library.nodes.filter(node => node.sourceId === sourceId).map(node => node.id),
    )
    if (deleted.has(preferredNodeId)) clearPreferredNode()
    if (deleted.has(subscriptionNode)) setSubscriptionNode('')
    setChains(current => current.map(chain =>
      chain.hops.some(hop => deleted.has(hop))
        ? { ...chain, hops: chain.hops.map(hop => deleted.has(hop) ? '' : hop) }
        : chain,
    ))
    if (hops.some(hop => deleted.has(hop))) startNewChain()
  }

  function reload() {
    return refresh().catch(onError)
  }

  function controlProxy(action: ProxyAction) {
    if (action.action === 'tun' && action.enabled && proxy.status.tunServiceReady === false) {
      setTunSetup('enable')
      return
    }
    return proxy.control(action)
  }

  async function installTunService() {
    if (installingTun) return
    setInstallingTun(true)
    try {
      const status = await air.installTunService()
      proxy.updateStatus(status)
      const enable = tunSetup === 'enable'
      setTunSetup(null)
      showMessage({ title: tr('虚拟网卡服务已安装'), type: 'success' })
      if (enable) await proxy.control({ action: 'tun', enabled: true })
    } catch (error) {
      onError(error)
    } finally {
      setInstallingTun(false)
    }
  }

  function rememberPreferredNode(id: string, groupId?: string) {
    setPreferredGroupId(groupId)
    if (groupId) preferences.setItem('air.preferredGroupId', groupId)
    else preferences.removeItem('air.preferredGroupId')
    preferenceVersion.current += 1
    if (id) preferences.setItem('air.preferredNodeId', id)
    else preferences.removeItem('air.preferredNodeId')
    setPreferredNodeId(id)
  }

  function clearPreferredNode() { rememberPreferredNode('') }

  async function choosePreferredNode(id: string, groupId?: string) {
    if (proxy.pending || proxy.selectingNodeId) return
    if (store.library.nodes.some(node => node.id === id && node.subscriptionNotice)) {
      onError(tr('所选条目是订阅提示，请选择可连接的代理节点'))
      return
    }
    const version = preferenceVersion.current
    if (!proxy.status.running) {
      rememberPreferredNode(id, groupId)
      return
    }
    const next = await proxy.control({ action: 'selectNode', id, groupId })
    if (next?.outbound?.hops[0]?.id === id && preferenceVersion.current === version) {
      rememberPreferredNode(id, groupId)
    }
  }

  function chainTarget(): ProxyTarget {
    const saved = chains.find(chain => chain.id === activeChainId)
    return { kind: 'chain', id: saved?.id, name: chainName, hops, inheritExitRules: saved ? saved.inheritExitRules : false }
  }

  function selectedProxyTarget(): ProxyTarget {
    if (preferredNodeId) return { kind: 'node', id: preferredNodeId, groupId: store.customGroups.some(group => group.id === preferredGroupId && group.members.includes(preferredNodeId)) ? preferredGroupId : undefined }
    if (activeChainId || hops.some(Boolean)) return chainTarget()
    return { kind: 'routing' }
  }

  function routingSettingsTarget(): ProxyTarget {
    if (proxy.status.running && proxy.status.target) return proxy.status.target
    const outbound = proxy.status.running ? proxy.status.outbound : undefined
    if (!outbound) {
      const selected = selectedProxyTarget()
      if (selected.kind === 'chain' && (selected.hops.length < 2 || selected.hops.some(hop => !hop))) {
        return { kind: 'routing' }
      }
      return selected
    }
    const ids = outbound.hops.map(hop => hop.id)
    if (ids.length > 1) return { kind: 'chain', name: outbound.name, hops: ids }
    return ids[0] ? { kind: 'node', id: ids[0] } : { kind: 'routing' }
  }

  const connectOnLaunch = useEffectEvent(async () => {
    const status = await air.startProxyOnLaunch(store.kernelOverride || null, selectedProxyTarget())
    if (status) proxy.updateStatus(status)
  })

  useEffect(() => {
    void connectOnLaunch().catch(onError)
  }, [onError])

  function startProxy(explicitTarget?: ProxyTarget) {
    if (!store.kernelPath) {
      onError(tr('请先在设置里选择本机的 Mihomo 内核'))
      openSettings('kernel')
      return
    }
    if (!explicitTarget && preferredNodeId && !preferredNode) {
      onError(tr('当前选择的节点已不存在，请在节点库重新选择'))
      navigate('nodes')
      return
    }
    if (!explicitTarget && preferredNode?.subscriptionNotice) {
      onError(tr('当前选中的是订阅提示，请在节点库选择可连接的代理节点'))
      navigate('nodes')
      return
    }
    const target = explicitTarget ?? selectedProxyTarget()
    return controlProxy({
      action: 'start',
      kernelPath: store.kernelPath,
      target,
    })
  }

  async function startCurrentChain() {
    const version = preferenceVersion.current
    const next = await startProxy(chainTarget())
    if (next?.running && preferenceVersion.current === version) clearPreferredNode()
  }

  function toggleProxy() {
    if (proxy.status.running) void controlProxy({ action: 'stop' })
    else void startProxy()
  }

  const reloadSubscriptions = useEffectEvent(() => { void store.refresh().catch(onError) })
  useEffect(() => {
    if (!isTauri()) return
    const listener = listen('air://subscriptions-changed', () => reloadSubscriptions())
    return () => { void listener.then(unlisten => unlisten(), () => {}) }
  }, [])

  const handleTrayAction = useEffectEvent(async (request: TrayAction) => {
    if (request.action === 'reportError') {
      onError(request.message)
      return
    }
    if (request.action !== 'mode' && proxy.pending) return
    const next = await (request.action === 'start' ? startProxy() : controlProxy(request))
    if (!next) await invoke('show_main_window')
  })

  useEffect(() => {
    if (!isTauri()) return
    let active = true
    const subscription = listen<TrayAction>('air://tray-action', ({ payload }) => {
      if (active) void handleTrayAction(payload).catch(onError)
    })
    void subscription.catch(onError)
    return () => {
      active = false
      void subscription.then(unlisten => unlisten(), () => {})
    }
  }, [onError])

  return (
    <MotionConfig reducedMotion="user">
      <div
        className="flex h-full min-w-0 overflow-hidden bg-background text-foreground"
        onDragOver={event => {
          if (event.dataTransfer.types.includes('Files')) event.preventDefault()
        }}
        onDrop={event => {
          if (event.dataTransfer.types.includes('Files')) event.preventDefault()
        }}
      >
        <AppSidebar
          page={page}
          kernelPath={store.kernelPath}
          background={store.background}
          updateVersion={updates.status.version && !updates.status.ignored ? updates.status.version : undefined}
          updateBusy={updates.busy}
          onNavigate={navigate}
          onOpenUpdate={handleSidebarUpdate}
          onOpenKernel={handleSidebarKernel}
        />

        <div className="grid min-h-0 min-w-0 flex-1 grid-cols-[minmax(0,1fr)] grid-rows-[42px_minmax(0,1fr)] overflow-hidden">
          <AppTitlebar
            onError={onError}
            status={proxy.status}
            outboundName={activeOutbound?.name ?? titlebarNode?.name}
            outboundLatency={titlebarNode && (
              <NodeLatencyButton
                node={titlebarNode}
                compact
                testing={store.isMeasuring(titlebarNode.id)}
                onMeasure={() => void store.measure(titlebarNode.id).catch(onError)}
              />
            )}
            onClearNode={!proxy.status.running && !proxy.pending && preferredNodeId ? clearPreferredNode : undefined}
            traffic={proxy.telemetry?.stale ? undefined : proxy.telemetry}
            pending={proxy.pending}
            onControl={controlProxy}
            onTunSetup={() => setTunSetup('install')}
            onToggle={toggleProxy}
          />

          <main className="relative min-h-0 min-w-0 overflow-hidden bg-background [contain:layout_style]">
            {visited.home && (
              <Activity mode={page === 'home' ? 'visible' : 'hidden'}>
                <Dashboard
                  visitKey={visits.home}
                  store={store}
                  proxy={proxy.status}
                  exitLookup={proxy.exitLookup}
                  telemetry={proxy.telemetry}
                  preferredNode={preferredNode}
                  verified={verified}
                  hops={hops}
                  chainName={chainName}
                  onChain={openChain}
                  onSubscriptions={() => navigate('subscriptions')}
                  onConnections={() => navigate('connections')}
                  onNodes={() => navigate('nodes')}
                  onConfigureConnection={setPolicyConnection}
                  pending={proxy.pending}
                  onToggle={toggleProxy}
                  onControl={controlProxy}
                  onTunSetup={() => setTunSetup('install')}
                  onError={onError}
                />
              </Activity>
            )}

            {visited.nodes && (
              <Activity mode={page === 'nodes' ? 'visible' : 'hidden'}>
                <NodeLibrary
                  visitKey={visits.nodes}
                  store={store}
                  proxy={proxy.status}
                  preferredNodeId={preferredNodeId}
                  selectingNodeId={proxy.selectingNodeId}
                  powerPending={Boolean(proxy.pending)}
                  onChooseNode={(id, groupId) => void choosePreferredNode(id, groupId)}
                  onEdit={openNode}
                  onAdd={() => openAddCustom()}
                  onAddToGroup={openAddCustom}
                  onChain={toggleChain}
                  customOpen={inspector.kind === 'custom'}
                  chainOpen={inspector.kind === 'chain'}
                  chainSelection={
                    inspector.kind === 'chain'
                      ? {
                          activeHopIndex,
                          hops,
                          onSelectHopIndex: setActiveHopIndex,
                          onAssignNode: assignNodeToHop,
                        }
                      : undefined
                  }
                  visibleSubscriptionIds={selectedSubscriptionIds}
                  totalSubscriptionCount={totalSubscriptionCount}
                  onShowAllSubscriptions={selectAllSubscriptions}
                  onManageSubscriptions={() => navigate('subscriptions')}
                  onSettings={() => openSettings('kernel')}
                  onImport={() => navigate('subscriptions')}
                  onAssignChainRole={assignChainRole}
                  onDeleteCustom={node => void deleteCustomNodeById(node.id)}
                  onRefreshSource={id => void refreshSubscriptionSource(id)}
                  onEditYaml={setYaml}
                  onError={onError}
                >
                  {selectedNode ? (
                    <NodeInspector
                      key={selectedNode.id}
                      node={selectedNode}
                      onClose={() => setInspector({ kind: 'none' })}
                      onSaved={() => void reload()}
                      onYaml={setYaml}
                      onError={onError}
                    />
                  ) : inspector.kind === 'custom' ? (
                    <CustomNodeInspector
                      key={inspector.id ?? inspector.groupId ?? 'new-custom'}
                      nodeId={inspector.id}
                      groupName={store.customGroups.find(group => group.id === inspector.groupId)?.name}
                      kernelPath={store.kernelPath}
                      onClose={() => setInspector({ kind: 'none' })}
                      onSaved={id => handleCustomSaved(id, inspector.groupId)}
                      onDeleted={id => handleCustomDeleted(id)}
                      onSettings={() => openSettings('kernel')}
                      onError={onError}
                    />
                  ) : (
                    inspector.kind === 'chain' && (
                      <ChainInspector
                        nodes={store.library.nodes}
                        chains={chains}
                        activeChainId={activeChainId}
                        chainName={chainName}
                        hops={hops}
                        activeHopIndex={activeHopIndex}
                        kernelPath={store.kernelPath}
                        proxyRunning={proxy.status.running}
                        proxyMode={proxy.status.mode}
                        proxyPending={proxy.pending}
                        verified={verified}
                        onSelectChain={selectSavedChain}
                        onNewChain={startNewChain}
                        onSaveChain={saveChain}
                        onStartChain={() => void startCurrentChain()}
                        onDeleteChain={deleteSavedChain}
                        onChangeName={setChainName}
                        onChangeHops={setHops}
                        onActiveHopChange={setActiveHopIndex}
                        onClose={() => setInspector({ kind: 'none' })}
                        onSettings={() => openSettings('kernel')}
                        onBind={() => openRouting('nodes')}
                        onProbeResult={result => setChainProbe({ key: probeKey, result })}
                        onError={onError}
                      />
                    )
                  )}
                </NodeLibrary>
              </Activity>
            )}

            {visited.subscriptions && (
              <Activity mode={page === 'subscriptions' ? 'visible' : 'hidden'}>
                <Subscriptions
                  visitKey={visits.subscriptions}
                  store={store}
                  selected={selectedSubscriptionIds}
                  onSelectedChange={setSelectedSubscriptionIds}
                  onYaml={setYaml}
                  onNode={node => setSubscriptionNode(node.id)}
                  onSourceDeleted={handleSourceDeleted}
                  onError={onError}
                />
              </Activity>
            )}

            {visited.connections && (
              <Activity mode={page === 'connections' ? 'visible' : 'hidden'}>
                <ConnectionsPage
                  visitKey={visits.connections}
                  proxy={proxy.status}
                  telemetry={proxy.telemetry}
                  probe={probe}
                  hops={hops}
                  chainName={chainName}
                  nodes={store.library.nodes}
                  onOpenChain={openChain}
                  onConfigureConnection={setPolicyConnection}
                  onClearLogs={() => {
                    void proxy.clearLogs().catch(onError)
                  }}
                />
              </Activity>
            )}

            {visited.settings && (
              <Activity mode={page === 'settings' ? 'visible' : 'hidden'}>
                {settingsPage === 'routing' ? (
                  <RoutingSettings
                    sources={store.library.sources}
                    groups={store.library.groups}
                    nodes={store.library.nodes}
                    target={routingSettingsTarget()}
                    apps={(proxy.telemetry?.connectionLogs ?? proxy.telemetry?.connections ?? []).map(conn => ({
                      executable: conn.processName ?? conn.appExecutable, path: conn.processPath, name: conn.app,
                      icon: conn.appIconKey ? proxy.telemetry?.appIcons?.[conn.appIconKey] : undefined,
                    }))}
                    bindApplication={routingReturn === 'nodes'}
                    onBack={() => navigate(routingReturn)}
                  />
                ) : (
                  <SettingsView
                    visitKey={visits.settings}
                    settingsPage={settingsPage}
                    theme={theme}
                    activeTheme={activeTheme}
                    kernelDraft={kernelDraft}
                    store={store}
                    updates={updates}
                    onOpenSettings={openSettings}
                    onOpenRouting={() => openRouting('settings')}
                    onSetTheme={setTheme}
                    onKernelDraft={setKernelDraft}
                  />
                )}
              </Activity>
            )}
          </main>
        </div>

        <UpdateDialog updates={updates} />

        <ConnectionPolicyDialog
          connection={policyConnection}
          recentConnections={proxy.telemetry?.connectionLogs ?? proxy.telemetry?.connections ?? []}
          appIcons={proxy.telemetry?.appIcons}
          proxyMode={proxy.status.mode}
          nodes={store.library.nodes}
          groups={store.library.groups}
          onSwitchToRuleMode={() => Promise.resolve(controlProxy({ action: 'mode', mode: 'rule' }))}
          onClose={closePolicyDialog}
        />

        <Dialog open={tunSetup !== null} onOpenChange={open => {
          if (!open && !installingTun) setTunSetup(null)
        }}>
          <DialogContent className="max-w-[360px]" aria-busy={installingTun}>
            <DialogHeader>
              <DialogTitle>{tr("安装虚拟网卡服务")}</DialogTitle>
            </DialogHeader>
            <DialogDescription>{tr("首次安装需要 Windows 授权，之后可直接开启虚拟网卡。")}</DialogDescription>
            <DialogFooter className="justify-end">
              <Button variant="secondary" disabled={installingTun} onClick={() => setTunSetup(null)}>{tr("取消")}</Button>
              <Button variant="default" disabled={installingTun} onClick={() => void installTunService()}>
                {installingTun ? tr('正在安装…') : tr('确认安装')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {subscriptionItem && (
          <Dialog
            open
            onOpenChange={open => {
              if (!open) setSubscriptionNode('')
            }}
          >
            <DialogContent className="h-[460px] max-w-[420px] overflow-hidden p-0">
              <DialogTitle className="sr-only">{tr("编辑订阅节点")}</DialogTitle>
              <NodeInspector
                key={subscriptionItem.id}
                node={subscriptionItem}
                embedded
                onClose={() => setSubscriptionNode('')}
                onSaved={reload}
                onYaml={id => {
                  setSubscriptionNode('')
                  setYaml(id)
                }}
                onError={onError}
              />
            </DialogContent>
          </Dialog>
        )}

        {yaml && (
          <YamlEditor
            key={yaml}
            sourceId={yaml}
            onClose={() => setYaml('')}
            onSaved={() => {
              setYaml('')
              reload()
            }}
            onError={onError}
          />
        )}
      </div>
      <MessageViewport />
    </MotionConfig>
  )
}
