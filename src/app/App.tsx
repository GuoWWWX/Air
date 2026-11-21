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
import { AnimatePresence, MotionConfig, motion } from 'motion/react'
import { Activity, useCallback, useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from 'react'
import { cn } from '@/shared/lib/utils'
import { Button } from '@/shared/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/shared/ui/dialog'
import { MessageViewport, showMessage } from '@/shared/ui/message'
import { BUTTON_SPRING, ICON_SPRING, navigation, type NavItem, type Page } from '@/shared/ui/app-navigation'
import { AppTitlebar } from './AppTitlebar'
import { ChainInspector } from '../features/chains/ChainInspector'
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
import { YamlEditor } from '../features/subscriptions/YamlEditor'
import { UpdateDialog } from '../features/updates/UpdateDialog'
import { useUpdates } from '../features/updates/useUpdates'
import {
  air,
  type ChainProbeResult,
  type ChainRecord,
  type NodeRecord,
  type ProxyAction,
  type ProxyTarget,
} from '@/platform/desktop/air'

type TrayAction =
  | Exclude<ProxyAction, { action: 'start' | 'selectNode' }>
  | { action: 'start' }
  | { action: 'reportError'; message: string }

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
  const [hovered, setHovered] = useState(false)
  const Icon = item.icon

  return (
    <motion.button
      type="button"
      title={collapsed ? item.label : undefined}
      aria-label={item.label}
      aria-current={active ? 'page' : undefined}
      whileHover={collapsed ? { scale: 1.05 } : undefined}
      whileTap={{ scale: collapsed ? 0.92 : 0.97 }}
      transition={BUTTON_SPRING}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={onClick}
      className={cn(
        'group relative flex h-10 w-full items-center rounded-[8px] text-sm outline-none transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-ring/60',
        collapsed ? 'justify-center px-0' : 'gap-2.5 px-3',
        active
          ? 'font-semibold text-primary'
          : 'font-medium text-secondary-foreground/80 hover:bg-accent-soft/85 hover:text-primary',
      )}
    >
      {active && (
        <motion.span
          layoutId="sidebar-nav-pill"
          transition={{ type: 'spring', stiffness: 500, damping: 38, mass: 0.85 }}
          className="absolute inset-0 z-0 rounded-[8px] border border-accent-border/45 bg-accent-soft"
        />
      )}
      <motion.span
        className="relative z-10 grid place-items-center"
        animate={hovered ? item.hoverAnimate : { scale: 1, rotate: 0, y: 0 }}
        transition={hovered ? item.hoverTransition : ICON_SPRING}
      >
        <Icon
          className={cn(
            'size-5 shrink-0 stroke-[1.9] transition-colors duration-150',
            active
              ? 'text-primary'
              : 'text-secondary-foreground/75 group-hover:text-primary',
          )}
        />
      </motion.span>
      {!collapsed && <span className="relative z-10 whitespace-nowrap">{item.label}</span>}
    </motion.button>
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
  const [hovered, setHovered] = useState(false)
  const kernelLabel = kernelPath
    ? background
      ? '诊断内核：窗口收起后自动测速'
      : '诊断内核：内核就绪 · 点击管理'
    : '诊断内核：未配置 Mihomo 路径'

  return (
    <motion.button
      type="button"
      title={collapsed ? kernelLabel : undefined}
      aria-label={kernelLabel}
      whileHover={collapsed ? { scale: 1.05 } : undefined}
      whileTap={{ scale: collapsed ? 0.92 : 0.97 }}
      transition={BUTTON_SPRING}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={onClick}
      className={cn(
        'group relative flex w-full text-left outline-none transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-ring/60',
        collapsed
          ? 'h-10 items-center justify-center rounded-[8px] border border-border-subtle bg-muted/45 text-secondary-foreground/80 hover:border-accent-border hover:bg-accent-soft/85 hover:text-primary'
          : 'flex-col gap-1 rounded-[9px] border border-border-subtle bg-muted/45 px-3 py-2.5 hover:border-accent-border hover:bg-accent-soft/80',
      )}
    >
      {collapsed ? (
        <>
          <motion.span
            className="grid place-items-center"
            animate={hovered ? { scale: 1.12 } : { scale: 1 }}
            transition={ICON_SPRING}
          >
            <Cpu className="size-5 stroke-[1.9]" />
          </motion.span>
          <span className={cn('absolute top-1.5 right-1.5 size-1.5 rounded-full', kernelPath ? 'bg-success' : 'bg-warning')} />
        </>
      ) : (
        <>
          <div className="flex items-center justify-between gap-2">
            <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-sm font-semibold text-foreground transition-colors group-hover:text-primary">
              <motion.span
                className="grid place-items-center"
                animate={hovered ? { scale: 1.15 } : { scale: 1 }}
                transition={ICON_SPRING}
              >
                <Cpu className="size-5 stroke-[1.9] text-secondary-foreground/75 transition-colors group-hover:text-primary" />
              </motion.span>
              诊断内核
            </span>
            <span className={cn('size-1.5 shrink-0 rounded-full', kernelPath ? 'bg-success' : 'bg-warning')} />
          </div>
          <span className="truncate text-xs text-muted-foreground">
            {kernelPath
              ? background
                ? '收起后自动测速'
                : '内核就绪 · 点击管理'
              : '未配置 Mihomo 路径'}
          </span>
        </>
      )}
    </motion.button>
  )
}

function SidebarCollapseButton({
  collapsed,
  onClick,
}: {
  collapsed: boolean
  onClick: () => void
}) {
  const [hovered, setHovered] = useState(false)

  return (
    <motion.button
      type="button"
      aria-label={collapsed ? '展开侧栏' : '收起侧栏'}
      title={collapsed ? '展开侧栏' : '收起侧栏'}
      whileHover={collapsed ? { scale: 1.05 } : undefined}
      whileTap={{ scale: collapsed ? 0.92 : 0.97 }}
      transition={BUTTON_SPRING}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={onClick}
      className={cn(
        'group flex h-10 w-full items-center rounded-[8px] text-secondary-foreground/80 outline-none transition-colors duration-150 hover:bg-accent-soft/85 hover:text-primary focus-visible:ring-2 focus-visible:ring-ring/60',
        collapsed ? 'justify-center px-0' : 'gap-2.5 px-3',
      )}
    >
      <motion.span
        className="grid place-items-center"
        animate={hovered ? { x: collapsed ? 2 : -2, scale: 1.06 } : { x: 0, scale: 1 }}
        transition={ICON_SPRING}
      >
        {collapsed ? (
          <PanelLeftOpen className="size-5 shrink-0 stroke-[1.9]" />
        ) : (
          <PanelLeftClose className="size-5 shrink-0 stroke-[1.9]" />
        )}
      </motion.span>
      {!collapsed && <span className="whitespace-nowrap text-sm font-medium">收起侧栏</span>}
    </motion.button>
  )
}

type InspectorState =
  | { kind: 'none' }
  | { kind: 'node'; id: string }
  | { kind: 'custom'; id?: string; groupId?: string }
  | { kind: 'chain' }

const DEMO_CHAIN: ChainRecord = {
  id: 'demo-chain-3hop',
  name: '港日美三跳',
  hops: ['demo-hk-01', 'demo-jp-03', 'demo-custom-us'],
}

function loadSavedChains(): ChainRecord[] {
  try {
    const raw = localStorage.getItem('air.chains')
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
    if (!valid.length && !isTauri() && localStorage.getItem('air.demoChainsSeeded') !== '1') {
      localStorage.setItem('air.demoChainsSeeded', '1')
      localStorage.setItem('air.chains', JSON.stringify([DEMO_CHAIN]))
      localStorage.setItem('air.activeChainId', DEMO_CHAIN.id)
      return [DEMO_CHAIN]
    }
    return valid
  } catch {
    return []
  }
}

export function App() {
  const store = useNodes()
  const { refresh, poll, batchPending } = store
  const [page, setPage] = useState<Page>('home')
  const [settingsPage, setSettingsPage] = useState<SettingsPage>('overview')
  const [routingReturn, setRoutingReturn] = useState<'settings' | 'nodes'>('settings')
  const [inspector, setInspector] = useState<InspectorState>({ kind: 'none' })
  const [subscriptionNode, setSubscriptionNode] = useState('')
  const [yaml, setYaml] = useState('')
  const [theme, setTheme] = useState<ThemeMode>(() => {
    const stored = localStorage.getItem('air.theme')
    return stored === 'dark' || stored === 'system' ? stored : 'light'
  })
  const [systemDark, setSystemDark] = useState(
    () => window.matchMedia('(prefers-color-scheme: dark)').matches,
  )
  const [chains, setChains] = useState<ChainRecord[]>(loadSavedChains)
  const [preferredNodeId, setPreferredNodeId] = useState(() => localStorage.getItem('air.preferredNodeId') ?? '')
  const preferenceVersion = useRef(0)
  const [activeChainId, setActiveChainId] = useState<string>(() => {
    const storedId = localStorage.getItem('air.activeChainId') ?? ''
    return chains.some(item => item.id === storedId) ? storedId : ''
  })
  const [initialChain] = useState(() => {
    const saved = chains.find(item => item.id === activeChainId)
    try {
      const draft = JSON.parse(localStorage.getItem('air.chainDraft') ?? 'null') as ChainRecord | null
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
  const [kernelDraft, setKernelDraft] = useState(store.kernelOverride)
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem('air.sidebarCollapsed') === '1')

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
    showMessage({ title: message, id: message, type: 'error' })
  }, [])
  const proxy = useProxy(onError)
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
  }, [activeTheme])

  useEffect(() => {
    localStorage.setItem('air.theme', theme)
  }, [theme])

  useEffect(() => {
    localStorage.setItem('air.sidebarCollapsed', collapsed ? '1' : '0')
  }, [collapsed])

  useEffect(() => {
    localStorage.setItem('air.chains', JSON.stringify(chains))
  }, [chains])

  useEffect(() => {
    localStorage.setItem('air.activeChainId', activeChainId)
    localStorage.setItem('air.chainDraft', JSON.stringify({ id: activeChainId, name: chainName, hops }))
  }, [activeChainId, chainName, hops])

  useEffect(() => {
    const query = window.matchMedia('(prefers-color-scheme: dark)')
    const update = (event: MediaQueryListEvent) => setSystemDark(event.matches)
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [])

  useEffect(() => {
    void refresh().catch(onError)
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
      if (polling) return
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

  useEffect(() => {
    if (page === 'nodes') void Promise.all([refresh(), poll()]).catch(onError)
  }, [page, refresh, poll, onError])

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

  function navigate(target: Page) {
    setPage(target)
    setSettingsPage('overview')
  }

  function openSettings(target: SettingsPage) {
    setSettingsPage(target)
    setPage('settings')
  }

  function openRouting(from: 'settings' | 'nodes') {
    setRoutingReturn(from)
    openSettings('routing')
  }

  function openNode(node: NodeRecord) {
    setPage('nodes')
    if (node.sourceId === 'custom') {
      setInspector({ kind: 'custom', id: node.id })
    } else {
      setInspector({ kind: 'node', id: node.id })
    }
  }

  function openAddCustom(groupId?: string) {
    setPage('nodes')
    setInspector({ kind: 'custom', groupId })
  }

  function openChain() {
    setPage('nodes')
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
    setPage('nodes')
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
      showMessage({ type: 'success', title: '自定义节点已删除' })
    } catch (error) {
      onError(error)
    }
  }

  async function refreshSubscriptionSource(sourceId: string) {
    try {
      await air.refreshSubscription(sourceId)
      await reload()
      showMessage({ type: 'success', title: '订阅已刷新' })
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
      throw new Error('请为每一跳选择有效节点后再保存')
    }
    await air.validateChain(hops)
    const firstNode = nodeMap.get(hops[0]!)!
    const lastNode = nodeMap.get(hops[hops.length - 1]!)!
    const finalName = chainName.trim() || `${firstNode.name} → ${lastNode.name}`
    const id =
      activeChainId && chains.some(item => item.id === activeChainId)
        ? activeChainId
        : `chain-${Date.now().toString(36)}`
    const record: ChainRecord = { id, name: finalName, hops: [...hops] }
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
    showMessage({ type: 'success', title: '链路已删除' })
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
      showMessage({ title: '虚拟网卡服务已安装', type: 'success' })
      if (enable) await proxy.control({ action: 'tun', enabled: true })
    } catch (error) {
      onError(error)
    } finally {
      setInstallingTun(false)
    }
  }

  function rememberPreferredNode(id: string) {
    preferenceVersion.current += 1
    if (id) localStorage.setItem('air.preferredNodeId', id)
    else localStorage.removeItem('air.preferredNodeId')
    setPreferredNodeId(id)
  }

  function clearPreferredNode() { rememberPreferredNode('') }

  async function choosePreferredNode(id: string) {
    if (proxy.pending || proxy.selectingNodeId) return
    if (store.library.nodes.some(node => node.id === id && node.subscriptionNotice)) {
      onError('所选条目是订阅提示，请选择可连接的代理节点')
      return
    }
    const version = preferenceVersion.current
    if (!proxy.status.running) {
      rememberPreferredNode(id)
      return
    }
    const next = await proxy.control({ action: 'selectNode', id })
    if (next?.outbound?.hops[0]?.id === id && preferenceVersion.current === version) {
      rememberPreferredNode(id)
    }
  }

  function selectedProxyTarget(): ProxyTarget {
    if (preferredNodeId) return { kind: 'node', id: preferredNodeId }
    if (activeChainId || hops.some(Boolean)) return { kind: 'chain', name: chainName, hops }
    return { kind: 'routing' }
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
      onError('请先在设置里选择本机的 Mihomo 内核')
      openSettings('kernel')
      return
    }
    if (!explicitTarget && preferredNodeId && !preferredNode) {
      onError('当前选择的节点已不存在，请在节点库重新选择')
      navigate('nodes')
      return
    }
    if (!explicitTarget && preferredNode?.subscriptionNotice) {
      onError('当前选中的是订阅提示，请在节点库选择可连接的代理节点')
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
    const next = await startProxy({ kind: 'chain', name: chainName, hops })
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
        className="grid h-full min-w-0 grid-cols-[minmax(0,1fr)] grid-rows-[42px_minmax(0,1fr)] overflow-hidden bg-background text-foreground"
        onDragOver={event => {
          if (event.dataTransfer.types.includes('Files')) event.preventDefault()
        }}
        onDrop={event => {
          if (event.dataTransfer.types.includes('Files')) event.preventDefault()
        }}
      >
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

        <div className="flex min-h-0 min-w-0">
          <nav
            aria-label="主导航"
            data-tauri-drag-region="deep"
            className={cn(
              'flex shrink-0 flex-col justify-between overflow-hidden border-r border-border bg-shell py-3 select-none transition-[width,padding] duration-200 ease-[cubic-bezier(0.16,1,0.3,1)]',
              collapsed ? 'w-14 px-2' : 'w-[176px] px-2.5',
            )}
          >
            <div className="flex flex-col gap-1">
              {navigation.map(item => (
                <SidebarNavButton
                  key={item.id}
                  item={item}
                  active={page === item.id}
                  collapsed={collapsed}
                  onClick={() => navigate(item.id)}
                />
              ))}
            </div>

            <div className="flex flex-col gap-1.5">
              {updates.status.version && !updates.status.ignored && (
                <Button
                  variant="secondary"
                  size="sm"
                  aria-label="软件更新"
                  title={`Air ${updates.status.version}`}
                  onClick={() => updates.setOpen(true)}
                  className={cn('h-10 justify-start px-2.5 text-sm [&_svg]:size-5', collapsed && 'justify-center px-0')}
                >
                  <ArrowDownToLine data-icon="inline-start" />
                  {!collapsed && (updates.busy ? '正在更新' : '软件更新')}
                </Button>
              )}
              <SidebarKernelButton
                collapsed={collapsed}
                kernelPath={store.kernelPath}
                background={store.background}
                onClick={() => openSettings(store.kernelPath ? 'monitoring' : 'kernel')}
              />

              <SidebarCollapseButton
                collapsed={collapsed}
                onClick={() => setCollapsed(prev => !prev)}
              />
            </div>
          </nav>

          <main className="relative min-h-0 min-w-0 flex-1 overflow-hidden bg-background">
            <Activity mode={page === 'nodes' ? 'visible' : 'hidden'}>
              <NodeLibrary
                store={store}
                proxy={proxy.status}
                preferredNodeId={preferredNodeId}
                selectingNodeId={proxy.selectingNodeId}
                powerPending={Boolean(proxy.pending)}
                onChooseNode={id => void choosePreferredNode(id)}
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

            {page === 'subscriptions' && (
              <Subscriptions
                store={store}
                onYaml={setYaml}
                onNode={node => setSubscriptionNode(node.id)}
                onSourceDeleted={handleSourceDeleted}
                onError={onError}
              />
            )}

            {page === 'home' && (
              <Dashboard
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
                pending={proxy.pending}
                onToggle={toggleProxy}
                onControl={controlProxy}
                onTunSetup={() => setTunSetup('install')}
                onError={onError}
              />
            )}

            {page === 'connections' && (
              <ConnectionsPage
                proxy={proxy.status}
                telemetry={proxy.telemetry}
                probe={probe}
                hops={hops}
                chainName={chainName}
                nodes={store.library.nodes}
                onOpenChain={openChain}
              />
            )}

            {page === 'settings' &&
              (settingsPage === 'routing' ? (
                <RoutingSettings
                  sources={store.library.sources}
                  groups={store.library.groups}
                  bindApplication={routingReturn === 'nodes'}
                  onBack={() => navigate(routingReturn)}
                />
              ) : (
                <SettingsView
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
              ))}
          </main>
        </div>

        <UpdateDialog updates={updates} />

        <Dialog open={tunSetup !== null} onOpenChange={open => {
          if (!open && !installingTun) setTunSetup(null)
        }}>
          <DialogContent className="max-w-[360px]" aria-busy={installingTun}>
            <DialogHeader>
              <DialogTitle>安装虚拟网卡服务</DialogTitle>
            </DialogHeader>
            <DialogDescription>首次安装需要 Windows 授权，之后可直接开启虚拟网卡。</DialogDescription>
            <DialogFooter className="justify-end">
              <Button variant="secondary" disabled={installingTun} onClick={() => setTunSetup(null)}>
                取消
              </Button>
              <Button disabled={installingTun} onClick={() => void installTunService()}>
                {installingTun ? '正在安装…' : '确认安装'}
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
              <DialogTitle className="sr-only">编辑订阅节点</DialogTitle>
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
