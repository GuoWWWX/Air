import { setBinding } from '@/shared/proxy/rule-library'
import { RuleBindingPicker } from '@/shared/ui/RuleLibraryManager'
import { highSpeedProbe, preferences } from '@/shared/lib/preferences'
import { diagnostic, tr, useLanguage } from '@/shared/i18n/messages'
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ArrowDown, ArrowUp, CalendarClock, ChevronDown, Copy, Download, Eye, Puzzle, QrCode, Check, CloudDownload, Code2, FileCode2, Network, Plus, RefreshCw, Trash2 } from 'lucide-react'
import { stringify } from 'yaml'
import { AnimatePresence, MotionConfig, motion } from 'motion/react'
import airLogo from '@/assets/air-m1.svg'
import type { Page as Tab } from '@/shared/ui/app-navigation'
import { Button } from '@/shared/ui/button'
import { MessageViewport, showMessage } from '@/shared/ui/message'
import { subscriptionLabel } from '@/shared/proxy/subscription-name'
import { useCopyFeedback } from '@/shared/ui/CopySubscriptionLink'
import { SubscriptionToolBody, subscriptionToolLabels, type SubscriptionToolData } from '@/shared/ui/SubscriptionTool'
import { downloadSubscription, emptyExtension, extendSubscription } from '@/shared/proxy/subscription-extension'
import { useSubscriptionOrder } from '@/shared/proxy/useSubscriptionOrder'
import { copySubscriptionText, native, onAndroid } from './bridge'
import { waitForProxyPowerAnimation } from '@/shared/ui/ProxyPowerButton'
import { ConnectionPolicySheet } from './connection-policy'
import { id as createId, remoteSubscriptionName, type SubscriptionDownload, canStart, createRoutingCompiler, defaultLibrary, effectiveYaml, membersOf, readLibrary, restoreLibrary, selection, withoutSubscription, yamlProfile, type compile, type Chain, type Choice, type Connection, type ExitInfo, type Group, type Library, type Mode, type Node, type Subscription, type ProbeSample, type VpnStatus } from './model'
import { Connections, Home, NodeDensitySheet, Nodes, NodeScopeSheet, Subscriptions, type ChainMeasurement, type MobileNodeDensity, type MobileNodeScope, type PendingImport } from './views'
import { ChainEditor, GroupEditor, ImportView, NodeEditor, YamlEditor, type SubscriptionImportRequest } from './workflows'
import { BottomNavigation, Empty, Header, Row, Sheet, Tag } from './ui'
import { validateNetwork, validateRouting } from './configuration'
import { NetworkSettings } from './network-settings'
import { AboutSettings, ConfigSettings, KernelSettings, RoutingSettings, SettingsIndex, ThemeSettings, settingsTitles, AndroidUpdatePanel, type AndroidUpdateState, type KernelInfo, type SettingsPage } from './settings'
type Screen =
  | { kind: 'import' | 'yaml'; id?: string }
  | { kind: SettingsPage }
type Dialog =
  | { kind: 'node'; node?: Node }
  | { kind: 'group'; group?: Group }
  | { kind: 'scope' | 'nodeDensity' }
  | { kind: 'source' | 'deleteSource'; id: string }
  | { kind: 'chain' | 'join' }
  | { kind: 'connection'; id: string; snapshot: Connection }
  | { kind: 'tool'; name: string; data: SubscriptionToolData; key: string }
  | { kind: 'update' }
  | { kind: 'delete'; label: string; apply: () => void }

const emptyStatus: VpnStatus = { phase: 'idle', startedAt: 0, traffic: {} }
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error)
const defaultKernel: KernelInfo = { version: '1.19.34', appVersion: '1.1.6', sdk: 35, abi: 'Android' }
const PROBE_REQUEST_SIZE = 72
const MANUAL_PROBE_COALESCE_MS = 80
type MonitorResult = { at: number; available: number; checked: number; error?: string; samples?: Record<string, ProbeSample[]> }

function mergeProbeSamples(base: Library['probes'], samples: Record<string, ProbeSample>): Library['probes'] {
  const next = { ...base }
  const cutoff = Date.now() - 86_400_000
  for (const [id, sample] of Object.entries(samples)) {
    const existing = (next[id] ?? []).filter(old => old.at > cutoff)
    if (existing.some(old => old.at === sample.at && old.delay === sample.delay)) {
      next[id] = existing
      continue
    }
    next[id] = [...existing, sample].sort((a, b) => a.at - b.at).slice(-96)
  }
  return next
}

function loadMobileNodeScope(): MobileNodeScope {
  try {
    const parsed: unknown = JSON.parse(preferences.getItem('air.mobile.nodeScope') ?? 'null')
    if (parsed && typeof parsed === 'object') {
      const item = parsed as Record<string, unknown>
      if (item.kind === 'all') return { kind: 'all' }
      if (item.kind === 'source' && typeof item.sourceId === 'string') return { kind: 'source', sourceId: item.sourceId }
      if (item.kind === 'group' && typeof item.groupId === 'string') return { kind: 'group', groupId: item.groupId }
    }
  } catch { /* Ignore invalid saved scope. */ }
  return { kind: 'all' }
}

function loadMobileConnectionsFilter(): 'all' | 'ok' | 'warn' {
  const saved = preferences.getItem('air.mobile.connectionsFilter')
  return saved === 'ok' || saved === 'warn' ? saved : 'all'
}

function loadMobileNodeDensity(): MobileNodeDensity {
  const saved = preferences.getItem('air.mobile.nodeDensity')
  return saved === 'compact' || saved === 'detailed' ? saved : 'normal'
}

export function App() {
  useLanguage()
  const [tab, setTab] = useState<Tab>('home')
  const [screen, setScreen] = useState<Screen>()
  const { copied, copy } = useCopyFeedback(copySubscriptionText)
  const [dialog, setDialog] = useState<Dialog>()
  const [library, setLibrary] = useState<Library>(defaultLibrary)
  const { sorted: sortedSources, move: moveSource } = useSubscriptionOrder(library.sources)
  const [loaded, setLoaded] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [status, setStatus] = useState(emptyStatus)
  const [exitInfo, setExitInfo] = useState<ExitInfo>()
  const [exitChecking, setExitChecking] = useState(false)
  const [exitFailed, setExitFailed] = useState(false)
  const logClearGeneration = useRef(0)
  const [history, setHistory] = useState<Connection[]>([])
  const [chainMeasurement, setChainMeasurement] = useState<ChainMeasurement>()
  const [busy, setBusy] = useState(false)
  const [powerPending, setPowerPending] = useState<'start' | 'stop'>()
  const powerPendingRef = useRef<'start' | 'stop' | undefined>(undefined)
  const [probing, setProbing] = useState<string[]>([])
  const [batchProgress, setBatchProgress] = useState<{ done: number; total: number } | null>(null)
  const probeRunId = useRef(0)
  const probeLoopRunning = useRef(false)
  const probeCancel = useRef<Promise<unknown> | undefined>(undefined)
  const manualQueueRef = useRef<string[]>([])
  const manualCoalesceTimer = useRef<number | null>(null)
  const activeManualIdsRef = useRef(new Set<string>())
  const activeBatchIdsRef = useRef(new Set<string>())
  const activeCustomIdsRef = useRef(new Set<string>())
  const batchQueueRef = useRef<{ ids: string[]; total: number; done: number; highSpeed: boolean } | null>(null)
  const customTasksRef = useRef<Array<{
    ids: string[]
    libraryForTest: Library
    notify?: 'nodeTest' | 'chainTest'
    resolve: (value: number | undefined) => void
    reject: (error: unknown) => void
  }>>([])
  useEffect(() => () => {
    if (manualCoalesceTimer.current !== null) {
      window.clearTimeout(manualCoalesceTimer.current)
      manualCoalesceTimer.current = null
    }
  }, [])
  const [refreshing, setRefreshing] = useState<string[]>([])
  const [pendingImports, setPendingImports] = useState<PendingImport[]>([])
  const lastStatusError = useRef<string | undefined>(undefined)
  const [kernelInfo, setKernelInfo] = useState(defaultKernel)
  const [updateState, setUpdateState] = useState<AndroidUpdateState>(() => ({
    current: defaultKernel.appVersion,
    phase: 'idle',
    ignored: false,
    progress: { received: 0, total: 0, speed: 0, reused: 0, apkSize: 0 },
  }))
  const [backgroundResult, setBackgroundResult] = useState<MonitorResult>()
  const monitorAt = useRef(0)
  const [checked, setChecked] = useState<string[]>([])
  const [nodesSelecting, setNodesSelecting] = useState(false)
  const [search, setSearch] = useState('')
  const [nodesFilterOpen, setNodesFilterOpen] = useState(false)
  const [nodeScope, setNodeScope] = useState<MobileNodeScope>(loadMobileNodeScope)
  const [nodeDensity, setNodeDensity] = useState<MobileNodeDensity>(loadMobileNodeDensity)
  const [connectionsFilter, setConnectionsFilter] = useState<'all' | 'ok' | 'warn'>(loadMobileConnectionsFilter)
  const [connectionsQuery, setConnectionsQuery] = useState('')
  const working = useRef(false)
  const writeChain = useRef<Promise<unknown>>(Promise.resolve())
  const refreshingSet = useRef(new Set<string>())
  const prevConnSample = useRef<{ at: number; map: Map<string, { upload: number; download: number }> } | null>(null)
  const current = useRef(library)
  current.current = library
  const outboundRevision = useRef(0)
  const modeSwitchToken = useRef(0)
  const modeSwitchPending = useRef(0)
  const modeRollbackRef = useRef<Mode>(library.mode)
  const [darkSystem, setDarkSystem] = useState(() => matchMedia('(prefers-color-scheme: dark)').matches)
  const [expiryTick, setExpiryTick] = useState(0)
  const prepareRouting = useMemo(createRoutingCompiler, [])
  const { model, compiled, expiresAt: routingExpiresAt } = useMemo(
    () => prepareRouting(library),
    [prepareRouting, library, expiryTick],
  )
  const choice = compiled.choice

  useEffect(() => {
    if (!Number.isFinite(routingExpiresAt)) return
    let timer = 0
    const scheduleExpiry = () => {
      window.clearTimeout(timer)
      const delay = routingExpiresAt - Date.now()
      if (delay <= 0) {
        setExpiryTick(tick => tick + 1)
        return
      }
      timer = window.setTimeout(scheduleExpiry, Math.min(delay, 2_147_483_647))
    }
    const onVisibilityChange = () => {
      if (!document.hidden && Date.now() >= routingExpiresAt) {
        setExpiryTick(tick => tick + 1)
      }
    }
    scheduleExpiry()
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      window.clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [routingExpiresAt])
  const canPrepare = canStart(library, choice)
  const running = status.phase === 'running'
  const dark = library.theme === 'dark' || library.theme === 'system' && darkSystem
  const screenSource = screen && 'id' in screen && library.sources.find(source => source.id === screen.id) || undefined
  const visibleSourceSet = useMemo(() => new Set(library.sourceFilter), [library.sourceFilter])
  const visibleSources = useMemo(
    () => sortedSources.filter(source => visibleSourceSet.has(source.id)),
    [sortedSources, visibleSourceSet],
  )
  const visibleLibraryNodes = useMemo(
    () => model.nodes.filter(node => node.sourceId === 'custom' || visibleSourceSet.has(node.sourceId)),
    [model.nodes, visibleSourceSet],
  )
  const hiddenSubscriptionCount = Math.max(0, sortedSources.length - visibleSources.length)

  useEffect(() => {
    preferences.setItem('air.mobile.nodeScope', JSON.stringify(nodeScope))
  }, [nodeScope])

  useEffect(() => {
    preferences.setItem('air.mobile.connectionsFilter', connectionsFilter)
  }, [connectionsFilter])

  useEffect(() => {
    if (!loaded) return
    if (nodeScope.kind === 'source' && nodeScope.sourceId !== 'custom' &&
        !visibleSourceSet.has(nodeScope.sourceId)) {
      setNodeScope({ kind: 'all' })
    } else if (nodeScope.kind === 'group') {
      const group = model.groups.find(item => item.id === nodeScope.groupId)
      if (!group || (group.sourceId && !visibleSourceSet.has(group.sourceId))) {
        setNodeScope({ kind: 'all' })
      }
    }
  }, [loaded, nodeScope, visibleSourceSet, model.groups])

  useEffect(() => {
    let active = true
    void native<Parameters<typeof restoreLibrary>[0] & { upgradeMonitorPlan?: boolean }>('load').then(async ({ upgradeMonitorPlan, ...saved }) => {
      if (!active) return
      const data = restoreLibrary(saved)
      const renamed = data.sources.some((source, index) => source.name !== saved.sources?.[index]?.name)
      const migrated = saved.networkVersion !== data.networkVersion
      if (renamed || migrated || (upgradeMonitorPlan && data.monitoring)) {
        await native('save', { ...data, monitorPlan: data.monitoring ? monitorPlan(data) : undefined })
        if (!active) return
      }
      current.current = data
      setLibrary(data)
      setLoaded(true)
    }).catch(error => {
      if (!active) return
      const text = errorText(error)
      setLoadError(text)
      showMessage({ type: 'error', title: tr('读取节点库失败'), description: text })
    })
    void native<KernelInfo>('kernelInfo').then(info => {
      if (!active) return
      setKernelInfo(info)
      setUpdateState(prev => ({ ...prev, current: info.appVersion }))
    }).catch(() => undefined)
    if (onAndroid) {
      void native<AndroidUpdateState>('updateStatus').then(next => {
        if (active && next) setUpdateState(next)
      }).catch(() => undefined)
    }
    const onNativeUpdateStatus = (event: Event) => {
      const detail = (event as CustomEvent<AndroidUpdateState>).detail
      if (active && detail) setUpdateState(detail)
    }
    window.addEventListener('air-update-status', onNativeUpdateStatus)
    const media = matchMedia('(prefers-color-scheme: dark)')
    const update = () => setDarkSystem(media.matches)
    const onNativeSystemTheme = (event: Event) => {
      const detail = (event as CustomEvent<{ dark?: boolean }>).detail
      if (typeof detail?.dark === 'boolean') setDarkSystem(detail.dark)
    }
    media.addEventListener('change', update)
    window.addEventListener('air-system-theme', onNativeSystemTheme)
    return () => {
      active = false
      media.removeEventListener('change', update)
      window.removeEventListener('air-system-theme', onNativeSystemTheme)
      window.removeEventListener('air-update-status', onNativeUpdateStatus)
    }
  }, [])

  useEffect(() => {
    if (!onAndroid || !loaded) return
    let active = true
    let inFlight = false
    function checkSilently() {
      if (!active || inFlight || document.hidden) return
      const lastChecked = Number(preferences.getItem('air.lastUpdateCheckAt') ?? 0)
      if (Number.isFinite(lastChecked) && Date.now() - lastChecked < 6 * 3_600_000) return
      inFlight = true
      void native<AndroidUpdateState>('checkUpdate')
        .then(next => {
          preferences.setItem('air.lastUpdateCheckAt', String(Date.now()))
          if (!active || !next) return
          setUpdateState(next)
          if (
            next.version &&
            next.version !== next.current &&
            next.version !== kernelInfo.appVersion &&
            !next.ignored &&
            next.phase !== 'idle' &&
            next.phase !== 'current'
          ) {
            if (preferences.getItem('air.promptedUpdateVersion') !== next.version) {
              preferences.setItem('air.promptedUpdateVersion', next.version)
              setDialog(currentDialog => currentDialog ?? { kind: 'update' })
              showMessage({ type: 'info', title: tr('发现新版本 Air Proxy ') + next.version })
            }
          }
        })
        .catch(() => undefined)
        .finally(() => {
          inFlight = false
        })
    }
    checkSilently()
    const onVisibilityChange = () => {
      if (!document.hidden) checkSilently()
    }
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      active = false
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [loaded, kernelInfo.appVersion])

  useEffect(() => {
    if (!loaded || !library.monitoring || !onAndroid) return
    let active = true
    async function read() {
      if (document.hidden || working.current) return
      const result = await native<MonitorResult | null>('monitorResults').catch(() => null)
      if (!active || !result || result.at <= monitorAt.current) return
      monitorAt.current = result.at
      setBackgroundResult(result)
      setLibrary(previous => {
        const probes = { ...previous.probes }
        for (const [id, samples] of Object.entries(result.samples ?? {})) {
          const combined = new Map([...(probes[id] ?? []), ...samples].map(sample => [sample.at, sample]))
          probes[id] = [...combined.values()].filter(sample => Date.now() - sample.at < 86_400_000)
            .sort((a, b) => a.at - b.at).slice(-96)
        }
        return { ...previous, probes }
      })
    }
    void read()
    const timer = window.setInterval(read, 30_000)
    document.addEventListener('visibilitychange', read)
    return () => { active = false; clearInterval(timer); document.removeEventListener('visibilitychange', read) }
  }, [loaded, library.monitoring])

  useLayoutEffect(() => {
    if (!loaded) return
    document.documentElement.dataset.theme = dark ? 'dark' : 'light'
    try { localStorage.setItem('air.bootTheme', library.theme) } catch {}
    void native('theme', { mode: library.theme, dark }).catch(() => undefined)
  }, [dark, loaded, library.theme])

  const readySent = useRef(false)
  useEffect(() => {
    if (readySent.current || (!loaded && !loadError)) return
    readySent.current = true
    void native('ready').catch(() => undefined)
  }, [loaded, loadError])

  useEffect(() => {
    if (!onAndroid || !loaded || status.phase !== 'idle' || !canPrepare) return
    const timer = window.setTimeout(() => {
      if (!document.hidden && !working.current) {
        void native('prepareProxy', prepareRouting(current.current).compiled.plan).catch(() => undefined)
      }
    }, 300)
    return () => window.clearTimeout(timer)
  }, [loaded, status.phase, canPrepare, compiled.plan])

  useEffect(() => {
    let gone = false
    let nowSampling = false
    async function reload() {
      if (document.hidden || nowSampling) return
      nowSampling = true
      try {
        const next = await native<VpnStatus>('status')
        if (!gone && !powerPendingRef.current) setStatus(next)
      } catch { /* Retain the last status during a WebView pause. */ }
      finally { nowSampling = false }
    }
    void reload()
    const interval = window.setInterval(() => void reload(), 850)
    document.addEventListener('visibilitychange', reload)
    return () => { gone = true; clearInterval(interval); document.removeEventListener('visibilitychange', reload) }
  }, [])

  useEffect(() => {
    if (!running || screen || (tab !== 'home' && tab !== 'connections')) {
      prevConnSample.current = null
      return
    }
    let cancelled = false
    let sampling = false
    let revision = 0
    let applications = new Map<string, { name: string; icon?: string }>()
    async function connections() {
      if (document.hidden || sampling) return
      sampling = true
      try {
        const known = applications
        const generation = logClearGeneration.current
        const response = await native<{
          connections?: Connection[]
          applications?: Record<string, { name: string; icon?: string }>
          revision?: number
        }>('connections', { revision, knownPackages: [...known.keys()] })
        if (cancelled || applications !== known || generation !== logClearGeneration.current) return
        const nowAt = performance.now()
        const wallNow = Date.now()
        const prev = prevConnSample.current
        const dt = prev ? Math.max(0.25, (nowAt - prev.at) / 1000) : 0
        const nextMap = new Map<string, { upload: number; download: number }>()
        const timeOf = (row: Connection) => {
          const parsed = row.start ? Date.parse(row.start) : Number.NaN
          return Number.isFinite(parsed) ? parsed : (row.firstSeenAt ?? 0)
        }
        const visibleApps = new Map<string, { name: string; icon?: string }>()
        const rows = (response.connections ?? []).map((row): Connection => {
          const pkg = row.metadata.process ?? ''
          const app = response.applications?.[pkg] ?? applications.get(pkg)
          if (app && visibleApps.size < 128) visibleApps.set(pkg, app)
          return app ? { ...row, appName: app.name, appIcon: app.icon } : row
        })
        applications = visibleApps
        const sampledClosed = rows.filter(row => row.closed)
        const active = rows.filter(row => !row.closed).map((row): Connection => {
          nextMap.set(row.id, { upload: row.upload, download: row.download })
          const old = prev?.map.get(row.id)
          let upRate = 0
          let downRate = 0
          const startedMs = row.start ? Date.parse(row.start) : Number.NaN
          if (old && dt > 0) {
            upRate = Math.max(0, (row.upload - old.upload) / dt)
            downRate = Math.max(0, (row.download - old.download) / dt)
          } else if (Number.isFinite(startedMs)) {
            const ageSec = (wallNow - startedMs) / 1000
            if (ageSec >= 0 && ageSec <= 5) {
              const span = Math.max(1, ageSec)
              upRate = Math.max(0, row.upload / span)
              downRate = Math.max(0, row.download / span)
            }
          }
          return {
            ...row,
            firstSeenAt: Number.isFinite(startedMs) ? startedMs : wallNow,
            upRate,
            downRate,
          }
        })
        prevConnSample.current = { at: nowAt, map: nextMap }
        const ids = new Set(active.map(row => row.id))
        setHistory(previous => {
          const previousMap = new Map(previous.map(row => [row.id, row]))
          const nextActive = active.map(row => {
            const existing = previousMap.get(row.id)
            return existing?.firstSeenAt ? { ...row, firstSeenAt: existing.firstSeenAt } : row
          })
          const nextClosed = new Map<string, Connection>()
          for (const row of previous) {
            if (ids.has(row.id)) continue
            nextClosed.set(row.id, row.closed ? row : { ...row, closed: true, closedAt: wallNow, upRate: 0, downRate: 0 })
          }
          for (const row of sampledClosed) {
            if (ids.has(row.id)) continue
            const old = previousMap.get(row.id)
            nextClosed.set(row.id, { ...row, closedAt: old?.closedAt ?? row.closedAt ?? wallNow,
              firstSeenAt: old?.firstSeenAt ?? row.firstSeenAt, upRate: 0, downRate: 0 })
          }
          const combined = [...nextActive, ...nextClosed.values()].sort((a, b) => timeOf(b) - timeOf(a))
          if (combined.length <= 500) return combined
          const trimmedActive = combined.filter(row => !row.closed)
          const remainingSlots = Math.max(0, 500 - trimmedActive.length)
          return [...trimmedActive, ...combined.filter(row => row.closed).slice(0, remainingSlots)]
            .sort((a, b) => timeOf(b) - timeOf(a))
        })
        revision = response.revision ?? 0
      } catch { /* A connection can end while an update is in progress. */ }
      finally { sampling = false }
    }
    void connections()
    const onVisibility = () => {
      applications = new Map()
      void connections()
    }
    document.addEventListener('visibilitychange', onVisibility)
    const tick = setInterval(() => void connections(), 1500)
    return () => { cancelled = true; clearInterval(tick); document.removeEventListener('visibilitychange', onVisibility) }
  }, [running, tab, screen, status.startedAt])

  useEffect(() => {
    setHistory([])
  }, [running, status.startedAt])

  useEffect(() => {
    if (!running) {
      outboundRevision.current++
      setExitInfo(undefined)
      setExitChecking(false)
      setExitFailed(false)
      prevConnSample.current = null
      return
    }
    const revision = ++outboundRevision.current
    setExitInfo(undefined)
    setExitChecking(true)
    setExitFailed(false)
    prevConnSample.current = null
    void native<ExitInfo>('exit', { mode: library.mode })
      .then(result => {
        if (revision !== outboundRevision.current) return
        setExitInfo(result)
        setExitChecking(false)
      })
      .catch(() => {
        if (revision !== outboundRevision.current) return
        setExitFailed(true)
        setExitChecking(false)
      })
    return () => { outboundRevision.current++ }
  }, [running, status.startedAt, library.mode, choice?.id])

  useEffect(() => {
    const back = (event: Event) => {
      if (dialog) { event.preventDefault(); setDialog(undefined) }
      else if (screen) { event.preventDefault(); setScreen(undefined) }
      else if (tab !== 'home') { event.preventDefault(); setTab('home') }
    }
    window.addEventListener('air-back', back)
    return () => window.removeEventListener('air-back', back)
  }, [dialog, screen, tab])

  function enqueueWrite<T>(work: () => Promise<T>): Promise<T> {
    const run = writeChain.current.then(work, work)
    writeChain.current = run.catch(() => undefined)
    return run
  }

  async function task(work: () => Promise<unknown>) {
    if (!loaded || working.current) return
    working.current = true
    setBusy(true)
    try { await work() }
    catch (error) { showMessage({ type: 'error', title: errorText(error) }) }
    finally { working.current = false; setBusy(false) }
  }

  function monitorPlan(library: Library) {
    const { model, compiled } = prepareRouting(library)
    return {
      plan: compiled.plan, url: library.network.probeUrl, expected: library.network.probeStatus,
      interval: library.network.probeIntervalMinutes,
      targets: Object.fromEntries(model.nodes.map(node => [node.id, compiled.byId.get(node.id)!])),
    }
  }

  async function save(next: Library, applyLive = running, applyNetwork = false) {
    const sources = await Promise.all(next.sources.map(async source => {
      if (!source.extension?.script.trim() && !source.extension?.rules.length)
        return source.extendedYaml === undefined ? source : { ...source, extendedYaml: undefined }
      const old = current.current.sources.find(item => item.id === source.id)
      if (old?.extendedYaml && old.yaml === source.yaml && old.extension === source.extension) return source
      const extendedYaml = await extendSubscription(source.yaml, source.extension)
      yamlProfile(extendedYaml)
      return { ...source, extendedYaml }
    }))
    if (sources.some((source, i) => source !== next.sources[i])) next = { ...next, sources }
    const nextConfig = prepareRouting(next).compiled
    if (applyLive && !canStart(next, nextConfig.choice)) throw new Error(tr('请先停止代理，再移除最后一个可用出站'))
    if (applyLive) await native(applyNetwork ? 'applyNetwork' : 'apply', nextConfig.plan)
    try {
      await native('save', { ...next, monitorPlan: next.monitoring ? monitorPlan(next) : undefined })
      current.current = next
      setLibrary(next)
    } catch (error) {
      if (applyLive) {
        await native(applyNetwork ? 'applyNetwork' : 'apply', prepareRouting(current.current).compiled.plan)
          .catch(() => undefined)
      }
      throw error
    }
  }

  function commit(build: (latest: Library) => Library, applyLive = running, applyNetwork = false) {
    return enqueueWrite(() => save(build(current.current), applyLive, applyNetwork))
  }

  function changeOutbound(patch: Partial<Pick<Library, 'choice' | 'mode'>>) {
    return enqueueWrite(async () => {
      const previous = current.current
      const next = { ...previous, ...patch }
      const nextConfig = prepareRouting(next).compiled
      if (running) {
        if (!canStart(next, nextConfig.choice)) throw new Error(tr('请先导入订阅或添加节点'))
        await native('apply', nextConfig.plan)
      }
      try {
        await native('saveOutbound', { choice: next.choice ?? null, mode: next.mode })
      } catch (error) {
        if (running) await native('apply', prepareRouting(previous).compiled.plan).catch(() => undefined)
        throw error
      }
      current.current = next
      setLibrary(next)
    })
  }

  function switchMode(nextMode: Mode) {
    if (!loaded || working.current || nextMode === current.current.mode) return
    if (modeSwitchPending.current === 0) {
      modeRollbackRef.current = current.current.mode
    }
    const token = ++modeSwitchToken.current
    modeSwitchPending.current += 1
    const optimistic = { ...current.current, mode: nextMode }
    current.current = optimistic
    setLibrary(optimistic)

    void enqueueWrite(async () => {
      if (token !== modeSwitchToken.current) return
      const latest = current.current
      const previous = { ...latest, mode: modeRollbackRef.current }
      const next = { ...latest, mode: nextMode }
      const nextConfig = prepareRouting(next).compiled
      if (running) {
        if (!canStart(next, nextConfig.choice)) throw new Error(tr('请先导入订阅或添加节点'))
        await native('apply', nextConfig.plan)
      }
      try {
        await native('saveOutbound', { choice: next.choice ?? null, mode: next.mode })
      } catch (error) {
        if (running) await native('apply', prepareRouting(previous).compiled.plan).catch(() => undefined)
        throw error
      }
      modeRollbackRef.current = next.mode
    })
      .catch(error => {
        if (token === modeSwitchToken.current) {
          const reverted = { ...current.current, mode: modeRollbackRef.current }
          current.current = reverted
          setLibrary(reverted)
          showMessage({ type: 'error', title: errorText(error) })
        }
      })
      .finally(() => {
        modeSwitchPending.current = Math.max(0, modeSwitchPending.current - 1)
      })
  }

  async function saveConfiguration(next: Library, apply: boolean, applyNetwork = false) {
    let saved = false
    await task(async () => {
      validateNetwork(next.network)
      validateRouting(next.routing)
      if (kernelInfo.sdk < 33 && next.network.routeExcludeAddress.length) throw new Error(tr('绕过网段需要 Android 13 或更新版本'))
      if (kernelInfo.sdk < 29 && next.routing.rules.some(rule => rule.enabled && rule.matcher === 'processName')) {
        throw new Error(tr('按应用包名分流需要 Android 10 或更新版本'))
      }
      const effective = prepareRouting(next).compiled
      const targets = [next.routing.fallback, ...next.routing.rules.filter(rule => rule.enabled).map(rule => rule.target)]
      if (targets.some(target => 'id' in target && !effective.byId.has(target.id))) throw new Error(tr('有规则指向不可用的分组或链路'))
      if (onAndroid) await native('validatePlan', { plan: effective.plan })
      await commit(
        latest => ({ ...latest, network: next.network, routing: next.routing, monitoring: next.monitoring }),
        running && apply,
        applyNetwork,
      )
      saved = true
      if (onAndroid && running && apply && applyNetwork) {
        setStatus(await native<VpnStatus>('status'))
      }
      notice(
        running && apply && applyNetwork
          ? tr('已保存并应用到当前代理')
          : running && !apply
            ? tr('已保存，下次启动代理生效')
            : tr('配置已保存'),
      )
    })
    return saved
  }

  const change = (next: Library, apply = true) => { void task(() => enqueueWrite(() => save(next, running && apply))) }
  const notice = (title: string) => showMessage({ type: 'success', title })
  const go = (next: Tab) => { setTab(next); setScreen(undefined); setDialog(undefined); setNodesSelecting(false); setChecked([]) }
  const importSub = () => { setDialog(undefined); setTab('subscriptions'); setScreen({ kind: 'import' }) }
  function choose(outbound: Choice) {
    void task(async () => {
      await changeOutbound({ choice: outbound })
      setDialog(undefined)
    })
  }

  function togglePower() {
    const fresh = prepareRouting(current.current)
    if (fresh.compiled !== compiled) {
      setExpiryTick(tick => tick + 1)
    }
    if (!running && !canStart(current.current, fresh.compiled.choice)) {
      showMessage({ type: 'info', title: tr('请先导入订阅或添加节点') })
      if (fresh.model.nodes.length) go('nodes')
      else importSub()
      return
    }
    void task(async () => {
      const action = running ? 'stop' : 'start'
      const startedAt = performance.now()
      powerPendingRef.current = action
      setPowerPending(action)
      try {
        if (action === 'start') {
          const next = await native<VpnStatus>('start', fresh.compiled.plan)
          if (!document.hidden && next.phase === 'running') {
            await waitForProxyPowerAnimation(action, startedAt)
          }
          setStatus(next)
        } else {
          await native('stop')
          if (!document.hidden) await waitForProxyPowerAnimation(action, startedAt)
          setStatus(await native<VpnStatus>('status'))
        }
      } finally {
        powerPendingRef.current = undefined
        setPowerPending(undefined)
      }
    })
  }

  function detect() {
    if (!running) return
    const revision = ++outboundRevision.current
    setExitChecking(true)
    setExitFailed(false)
    void native<ExitInfo>('exit', { mode: library.mode })
      .then(value => {
        if (revision !== outboundRevision.current) return
        setExitInfo(value)
      })
      .catch(error => {
        if (revision !== outboundRevision.current) return
        setExitFailed(true)
        showMessage({ type: 'error', title: errorText(error) })
      })
      .finally(() => {
        if (revision === outboundRevision.current) setExitChecking(false)
      })
  }

  useEffect(() => {
    if (status.error && status.error !== lastStatusError.current) {
      lastStatusError.current = status.error
      showMessage({ type: 'error', title: tr('代理异常'), description: diagnostic(status.error) })
    } else if (!status.error) {
      lastStatusError.current = undefined
    }
  }, [status.error])

  function confirm(label: string, apply: () => void) {
    setDialog({ kind: 'delete', label, apply })
  }

  function startImport(request: SubscriptionImportRequest) {
    const taskId = createId()
    const url = request.url
    const host = url ? (() => { try { return new URL(url).hostname || url } catch { return url } })() : (request.file?.name || request.source?.name || tr('本地订阅'))
    const label = request.name.trim() || request.source?.name || host
    setPendingImports(previous => [{ id: taskId, label, detail: host }, ...previous])
    setScreen(undefined)
    setTab('subscriptions')

    void (async () => {
      try {
        const snapshot = current.current
        const source = request.source ? snapshot.sources.find(item => item.id === request.source!.id) ?? request.source : undefined
        const picked = request.kind === 'file' ? request.file : undefined
        const existing = url ? snapshot.sources.find(item => item.url === url && item.id !== source?.id) : undefined
        if (source && existing && url !== source.url) throw new Error(tr('这个链接已用于另一条订阅'))
        const previous = source ?? existing
        const requested = source && source.name === request.name.trim() ? '' : request.name.trim()

        let built: Subscription
        let nodeCount: number | undefined
        if (source && !picked && url === source.url) {
          const localBase = requested || source.baseName || source.name || tr('本地订阅')
          const localName = { ...subscriptionLabel(localBase, snapshot.sources, source), autoName: false }
          built = { ...source, ...(url ? remoteSubscriptionName(url, requested, snapshot.sources, undefined, source) : localName) }
        } else {
          const response: SubscriptionDownload = url
            ? await native<SubscriptionDownload>('fetch', { url })
            : { text: picked?.text ?? source?.original ?? '' }
          const parsed = yamlProfile(response.text)
          nodeCount = parsed.nodes.length
          const keepEdit = Boolean(previous?.edited && !picked)
          const latestSources = current.current.sources
          const latestPrevious = previous ? latestSources.find(item => item.id === previous.id) ?? previous : undefined
          const localBase = requested || latestPrevious?.baseName || latestPrevious?.name || picked?.name || tr('本地订阅')
          const localName = { ...subscriptionLabel(localBase, latestSources, latestPrevious), autoName: false }
          built = {
            ...latestPrevious,
            intervalHours: response.intervalHours,
            autoUpdate: Boolean(url) && (latestPrevious?.autoUpdate ?? true),
            id: latestPrevious?.id ?? createId(),
            ...(url ? remoteSubscriptionName(url, requested, latestSources, response.profileTitle, latestPrevious) : localName),
            refreshError: undefined,
            url,
            yaml: keepEdit ? latestPrevious!.yaml : response.text,
            original: response.text,
            edited: keepEdit,
            updated: Date.now(),
            usage: response.usage,
          }
        }

        const saved = await enqueueWrite(async () => {
          const latest = current.current
          const exists = latest.sources.some(old => old.id === built.id)
          const entry = { ...built, ...subscriptionLabel(built.baseName ?? built.name, latest.sources, built) }
          const next: Library = {
            ...latest,
            sources: exists ? latest.sources.map(old => old.id === built.id ? entry : old) : [...latest.sources, entry],
            sourceFilter: exists ? latest.sourceFilter : [...latest.sourceFilter, entry.id],
          }
          await save(next)
          return { entry, exists }
        })
        showMessage({
          type: 'success',
          title: saved.exists ? tr("已保存订阅 · {0}", saved.entry.name) : tr("订阅已导入 · {0}", saved.entry.name),
          description: nodeCount !== undefined ? tr("{0} 个节点", nodeCount) : undefined,
        })
      } catch (error) {
        showMessage({
          type: 'error',
          title: tr("导入订阅失败 · {0}", label),
          description: errorText(error),
        })
      } finally {
        setPendingImports(previous => previous.filter(item => item.id !== taskId))
      }
    })()
  }

  const nextAutoCheck = useRef(0)

  function refresh(sources: Subscription[], automatic = false) {
    const targets = sources.filter(source => source.url && !refreshingSet.current.has(source.id))
    if (!targets.length) return

    for (const source of targets) refreshingSet.current.add(source.id)
    setRefreshing([...refreshingSet.current])

    const singleManual = !automatic && sources.length === 1 && targets.length === 1
    const errors: string[] = []
    let count = 0

    const jobs = targets.map(async source => {
      const matches = (item: Subscription) => item.id === source.id && item.updated === source.updated &&
        item.url === source.url && (!automatic || item.autoUpdate !== false)
      try {
        const staged = automatic ? await native<SubscriptionDownload | null>('stagedSubscription', {
          id: source.id, url: source.url, updated: source.updated,
        }) : null
        const response = staged ?? await native<SubscriptionDownload>('fetch', { url: source.url })
        yamlProfile(response.text)
        let syncedName: string | undefined
        await enqueueWrite(async () => {
          const latest = current.current
          const original = latest.sources.find(matches)
          if (!original) return
          const next: Subscription = {
            ...original,
            ...remoteSubscriptionName(source.url!, '', latest.sources, response.profileTitle, original),
            yaml: original.edited ? original.yaml : response.text,
            original: response.text,
            usage: response.usage,
            intervalHours: response.intervalHours,
            updated: Date.now(),
            attempted: Date.now(),
            refreshError: undefined,
          }
          await save({ ...latest, sources: latest.sources.map(item => item.id === next.id ? next : item) })
          syncedName = next.name
        })
        if (syncedName) {
          count++
          if (singleManual) showMessage({ type: 'success', title: tr("已同步「{0}」", syncedName) })
        }
      } catch (error) {
        const reason = errorText(error)
        errors.push(source.name + '：' + reason)
        await enqueueWrite(async () => {
          const latest = current.current
          if (!latest.sources.some(matches)) return
          await save({
            ...latest,
            sources: latest.sources.map(item => matches(item) ? { ...item, attempted: Date.now(), refreshError: reason } : item),
          }, false)
        }).catch(() => undefined)
        if (singleManual) {
          showMessage({ type: 'error', title: tr("刷新失败 · {0}", source.name), description: reason })
        }
      } finally {
        refreshingSet.current.delete(source.id)
        setRefreshing([...refreshingSet.current])
      }
    })

    if (!automatic && !singleManual) {
      void Promise.allSettled(jobs).then(() => {
        if (errors.length) {
          showMessage({
            type: 'error',
            title: count ? tr("已同步 {0} 个，{1} 个失败", count, errors.length) : tr('刷新订阅失败'),
            description: errors.join('；'),
          })
        } else if (count) {
          notice(tr('全部订阅已同步'))
        }
      })
    }
  }

  useEffect(() => {
    if (!loaded || !onAndroid || screen || dialog) return
    function check() {
      if (working.current || document.hidden || Date.now() < nextAutoCheck.current) return
      const now = Date.now()
      const due = library.sources.filter(source => source.url && source.autoUpdate !== false &&
        now >= source.updated + (source.customHours ?? source.intervalHours ?? 24) * 3_600_000 &&
        now >= (source.attempted ?? 0) + 900_000)
      if (due.length) { nextAutoCheck.current = now + 60_000; refresh(due, true) }
    }
    check()
    const timer = window.setInterval(check, 60_000)
    document.addEventListener('visibilitychange', check)
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', check) }
  }, [loaded, library, screen, dialog, running])

  function replaceYaml(source: Subscription, text: string, edited: boolean) {
    void task(async () => {
      yamlProfile(text)
      await commit(latest => ({
        ...latest,
        sources: latest.sources.map(old => old.id === source.id ? { ...old, yaml: text, edited, autoUpdate: edited ? false : old.autoUpdate } : old),
      }))
      setScreen(undefined)
      setDialog(undefined)
      notice(edited ? tr('YAML 已保存并应用') : tr('已恢复订阅原文'))
    })
  }

  function pauseSource(id: string, base: Library) {
    return base.sources.map(source => source.id === id ? { ...source, autoUpdate: false } : source)
  }

  function nextNode(node: Node, base = current.current): Library {
    if (node.sourceId !== 'custom') {
      const existing = readLibrary(base).nodesById.get(node.id)
      if (existing && JSON.stringify(existing.config) === JSON.stringify(node.config)) return base
      return { ...base, sources: pauseSource(node.sourceId, base), edits: { ...base.edits, [node.id]: node.config } }
    }
    const exists = base.nodes.some(old => old.id === node.id)
    return { ...base, nodes: exists ? base.nodes.map(old => old.id === node.id ? node : old) : [...base.nodes, node] }
  }

  function updateSource(id: string, patch: Partial<Subscription>, live: boolean) {
    return enqueueWrite(async () => {
      const latest = current.current
      if (!latest.sources.some(src => src.id === id)) throw new Error(tr('订阅已不存在'))
      await save({ ...latest, sources: latest.sources.map(src => src.id === id ? { ...src, ...patch } : src) }, live)
    })
  }

  function withBinding(next: Library, owner: string, value?: string): Library {
    if (value === undefined) return next
    return { ...next, routing: { ...next.routing, ruleLibrary:setBinding(next.routing.ruleLibrary, owner, value) } }
  }
  function subscriptionBinding(id: string) {
    const owner = 'subscription:' + id
    return <RuleBindingPicker sources={library.sources} catalog={library.routing.ruleLibrary} disabled={busy}
      value={library.routing.ruleLibrary?.bindings[owner] ?? ''} change={value => void task(() => commit(latest => withBinding(latest, owner, value)))} />
  }
  function saveNode(node: Node, binding?: string) {
    void task(async () => { await commit(latest => withBinding(nextNode(node, latest), 'node:' + node.id, binding)); setDialog(undefined); notice(tr('节点已保存')) })
  }

  function removeNode(node: Node) {
    return enqueueWrite(() => {
      const latest = current.current
      const edits = { ...latest.edits }
      delete edits[node.id]
      return save({
        ...latest,
        routing: withBinding(latest, 'node:' + node.id, '').routing,
        nodes: latest.nodes.filter(n => n.id !== node.id),
        sources: pauseSource(node.sourceId, latest),
        hiddenNodes: node.sourceId === 'custom' ? latest.hiddenNodes : [...latest.hiddenNodes, node.id],
        edits,
        groups: latest.groups.map(group => ({ ...group, members: group.members.filter(id => id !== node.id) })),
      })
    })
  }

  function clearManualCoalesce() {
    if (manualCoalesceTimer.current !== null) {
      window.clearTimeout(manualCoalesceTimer.current)
      manualCoalesceTimer.current = null
    }
  }

  function syncProbing() {
    const next = new Set<string>(activeBatchIdsRef.current)
    for (const id of activeManualIdsRef.current) next.add(id)
    for (const id of activeCustomIdsRef.current) next.add(id)
    for (const id of manualQueueRef.current) next.add(id)
    setProbing([...next])
  }

  type ProbeNode = { id: string; alias: string }

  function groupProbeChunks(ids: string[], libraryForTest: Library) {
    const plan = prepareRouting(libraryForTest).compiled
    const chunks: ProbeNode[][] = []
    let lastScope: number | undefined
    for (const id of new Set(ids)) {
      const alias = plan.byId.get(id)
      if (!alias) continue
      const scope = plan.plan.hostScopes?.byProxy[alias] ?? 0
      let chunk = chunks.at(-1)
      if (!chunk || scope !== lastScope || chunk.length === PROBE_REQUEST_SIZE) {
        chunk = []
        chunks.push(chunk)
        lastScope = scope
      }
      chunk.push({ id, alias })
    }
    return { plan, chunks }
  }

  async function runProbeChunk(
    chunk: ProbeNode[],
    plan: ReturnType<typeof compile>,
    libraryForTest: Library,
    runId: number,
    options: { record: boolean; isBatch: boolean; highSpeed?: boolean; onNodeDone?: (id: string, delay: number) => void },
  ) {
    await probeCancel.current
    if (probeRunId.current !== runId) return { aborted: true, last: -1 }
    const aliasToId = new Map(chunk.map(item => [item.alias, item.id]))
    const collected: Record<string, ProbeSample> = {}
    const finishedIds = new Set<string>()
    let last = -1

    function handleSample(id: string, measured: number) {
      last = measured
      if (!finishedIds.has(id)) {
        finishedIds.add(id)
        options.onNodeDone?.(id, measured)
      }
      if (!Object.hasOwn(collected, id)) {
        const sample: ProbeSample = { at: Date.now(), delay: measured }
        collected[id] = sample
        if (options.record) {
          setLibrary(previous => ({
            ...previous,
            probes: mergeProbeSamples(previous.probes, { [id]: sample }),
          }))
        }
      }
    }

    try {
      const results = await native<Record<string, number>>(
        'probe',
        {
          plan: plan.plan,
          url: libraryForTest.network.probeUrl,
          expected: libraryForTest.network.probeStatus,
          aliases: chunk.map(item => item.alias),
          reportProgress: options.record || options.isBatch,
          highSpeed: options.highSpeed === true,
        },
        (_completed, alias, delay) => {
          if (probeRunId.current !== runId || !alias || typeof delay !== 'number') return
          const id = aliasToId.get(alias)
          if (id) handleSample(id, delay)
        },
      )
      if (probeRunId.current === runId) {
        for (const { id, alias } of chunk) {
          if (!Object.hasOwn(results, alias)) continue
          const measured = results[alias]
          if (typeof measured === 'number') handleSample(id, measured)
        }
      }
    } finally {
      if (options.record && Object.keys(collected).length > 0) {
        await enqueueWrite(async () => {
          const latest = current.current
          await save({ ...latest, probes: mergeProbeSamples(latest.probes, collected) }, false)
        })
      }
    }

    const aborted = probeRunId.current !== runId
    if (!aborted && options.record && Object.keys(collected).length > 0 && running && current.current.groups.some(group => Boolean(group.automatic))) {
      await enqueueWrite(() => save(current.current, true))
    }
    return { aborted, last }
  }

  async function drainProbeQueue() {
    if (probeLoopRunning.current) return
    probeLoopRunning.current = true
    clearManualCoalesce()
    try {
      while (customTasksRef.current.length || manualQueueRef.current.length || batchQueueRef.current) {
        const customTask = customTasksRef.current.shift()
        if (customTask) {
          const { plan, chunks } = groupProbeChunks(customTask.ids, customTask.libraryForTest)
          if (!chunks.length) {
            customTask.resolve(undefined)
            continue
          }
          const taskIds = chunks.flat().map(item => item.id)
          for (const id of taskIds) activeCustomIdsRef.current.add(id)
          syncProbing()
          const runId = ++probeRunId.current
          try {
            let last = -1
            let aborted = false
            for (const chunk of chunks) {
              const outcome = await runProbeChunk(chunk, plan, customTask.libraryForTest, runId, {
                record: false,
                isBatch: false,
              })
              if (outcome.aborted) {
                aborted = true
                break
              }
              last = outcome.last
            }
            if (!aborted && customTask.notify === 'nodeTest') {
              showMessage({
                type: last > 0 ? 'success' : 'error',
                title: last > 0 ? tr('连接测试通过 · {0} ms', last) : tr('连接测试失败'),
              })
            } else if (!aborted && customTask.notify === 'chainTest') {
              showMessage({
                type: last > 0 ? 'success' : 'error',
                title: last > 0 ? tr('整链可达 · {0} ms', last) : tr('整链不可达'),
              })
            }
            customTask.resolve(aborted ? undefined : last)
          } catch (error) {
            if (probeRunId.current !== runId) {
              customTask.resolve(undefined)
            } else {
              customTask.reject(error)
            }
          } finally {
            if (probeRunId.current === runId) {
              for (const id of taskIds) activeCustomIdsRef.current.delete(id)
              syncProbing()
            }
          }
          continue
        }

        if (manualQueueRef.current.length) {
          const queuedIds = manualQueueRef.current.splice(0, PROBE_REQUEST_SIZE)
          const libraryForTest = current.current
          const { plan, chunks } = groupProbeChunks(queuedIds, libraryForTest)
          if (!chunks.length) {
            syncProbing()
            continue
          }
          const [firstChunk, ...remainingChunks] = chunks
          if (remainingChunks.length) {
            manualQueueRef.current.unshift(...remainingChunks.flatMap(chunk => chunk.map(item => item.id)))
          }
          const chunkIds = firstChunk.map(item => item.id)
          for (const id of chunkIds) activeManualIdsRef.current.add(id)
          syncProbing()

          const runId = ++probeRunId.current
          try {
            await runProbeChunk(firstChunk, plan, libraryForTest, runId, {
              record: true,
              isBatch: false,
              onNodeDone: id => {
                if (probeRunId.current !== runId) return
                activeManualIdsRef.current.delete(id)
                syncProbing()
              },
            })
          } catch (error) {
            if (probeRunId.current === runId) {
              showMessage({ type: 'error', title: errorText(error) })
            }
          } finally {
            if (probeRunId.current === runId) {
              for (const id of chunkIds) activeManualIdsRef.current.delete(id)
              syncProbing()
            }
          }
          continue
        }

        const batch = batchQueueRef.current
        if (batch) {
          const libraryForTest = current.current
          const { plan, chunks } = groupProbeChunks(batch.ids, libraryForTest)
          if (!chunks.length) {
            batchQueueRef.current = null
            activeBatchIdsRef.current.clear()
            setBatchProgress(null)
            syncProbing()
            continue
          }
          const nextChunk = chunks[0]
          const chunkSet = new Set(nextChunk.map(item => item.id))
          batch.ids = batch.ids.filter(id => !chunkSet.has(id))
          const isLastChunk = batch.ids.length === 0

          const runId = ++probeRunId.current
          try {
            await runProbeChunk(nextChunk, plan, libraryForTest, runId, {
              record: true,
              isBatch: true,
              highSpeed: batch.highSpeed,
              onNodeDone: id => {
                if (probeRunId.current !== runId) return
                chunkSet.delete(id)
                activeBatchIdsRef.current.delete(id)
                if (batchQueueRef.current) {
                  batchQueueRef.current.done = Math.min(batchQueueRef.current.total, batchQueueRef.current.done + 1)
                  setBatchProgress({ done: batchQueueRef.current.done, total: batchQueueRef.current.total })
                }
                syncProbing()
              },
            })
          } catch (error) {
            if (probeRunId.current === runId) {
              showMessage({ type: 'error', title: errorText(error) })
            }
          } finally {
            if (probeRunId.current === runId) {
              for (const id of chunkSet) activeBatchIdsRef.current.delete(id)
              if (isLastChunk || !batchQueueRef.current?.ids.length) {
                batchQueueRef.current = null
                activeBatchIdsRef.current.clear()
                setBatchProgress(null)
              } else if (chunkSet.size) {
                // A failed native request also finishes its remaining nodes.
                batch.done += chunkSet.size
                setBatchProgress({ done: batch.done, total: batch.total })
              }
              syncProbing()
            }
          }
        }
      }
    } finally {
      probeLoopRunning.current = false
      if (customTasksRef.current.length || manualQueueRef.current.length || batchQueueRef.current) {
        void drainProbeQueue()
      }
    }
  }

  function enqueueManualProbe(ids: string[]) {
    const plan = prepareRouting(current.current).compiled
    let added = false
    for (const id of new Set(ids)) {
      if (!plan.byId.has(id)) continue
      if (activeManualIdsRef.current.has(id) || activeBatchIdsRef.current.has(id)) continue
      if (manualQueueRef.current.includes(id)) continue
      manualQueueRef.current.push(id)
      added = true
    }
    if (!added) return
    syncProbing()
    if (probeLoopRunning.current) return
    clearManualCoalesce()
    manualCoalesceTimer.current = window.setTimeout(() => {
      manualCoalesceTimer.current = null
      void drainProbeQueue()
    }, MANUAL_PROBE_COALESCE_MS)
  }

  function cancelProbe() {
    const hasPending =
      probeLoopRunning.current ||
      manualCoalesceTimer.current !== null ||
      manualQueueRef.current.length > 0 ||
      activeManualIdsRef.current.size > 0 ||
      activeBatchIdsRef.current.size > 0 ||
      activeCustomIdsRef.current.size > 0 ||
      batchQueueRef.current !== null ||
      customTasksRef.current.length > 0
    if (!hasPending) return
    clearManualCoalesce()
    probeRunId.current += 1
    manualQueueRef.current = []
    activeManualIdsRef.current.clear()
    activeBatchIdsRef.current.clear()
    activeCustomIdsRef.current.clear()
    batchQueueRef.current = null
    for (const pending of customTasksRef.current.splice(0)) {
      pending.resolve(undefined)
    }
    setBatchProgress(null)
    setProbing([])
    if (onAndroid) probeCancel.current = native('cancelProbe').catch(() => undefined)
  }

  async function measure(
    ids: string[],
    libraryForTest = current.current,
    record = true,
    options?: { batch?: boolean; notify?: 'nodeTest' | 'chainTest' },
  ): Promise<number | undefined> {
    if (!record) {
      clearManualCoalesce()
      return new Promise<number | undefined>((resolve, reject) => {
        customTasksRef.current.push({ ids, libraryForTest, notify: options?.notify, resolve, reject })
        void drainProbeQueue()
      })
    }
    if (options?.batch) {
      if (batchQueueRef.current) return undefined
      const { chunks } = groupProbeChunks(ids, libraryForTest)
      const validIds = chunks.flat().map(item => item.id)
      if (!validIds.length) return undefined
      batchQueueRef.current = { ids: validIds, total: validIds.length, done: 0, highSpeed: highSpeedProbe.get() }
      for (const id of validIds) activeBatchIdsRef.current.add(id)
      setBatchProgress({ done: 0, total: validIds.length })
      syncProbing()
      clearManualCoalesce()
      void drainProbeQueue()
      return undefined
    }
    enqueueManualProbe(ids)
    return undefined
  }

  const chainLibrary = (chain: Chain, base = current.current) => ({
    ...base,
    chains: [...base.chains.filter(old => old.id !== chain.id), chain],
  })
  async function measureChain(chain: Chain, notify = false) {
    const result = await measure([chain.id], chainLibrary(chain), false, notify ? { notify: 'chainTest' } : undefined)
    if (result === undefined) throw new Error(tr('请选择至少两个可用节点组成链路'))
    setChainMeasurement({ name: chain.name, delay: result,
      hops: chain.hops.map(id => model.nodes.find(node => node.id === id)?.config.name ?? tr('未知节点')) })
  }

  async function removeSource(sourceId: string) {
    const statusNow = await native<VpnStatus>('status')
    if (statusNow.phase === 'starting') throw new Error(tr('代理正在启动，请稍后再删除订阅'))
    const connected = statusNow.phase === 'running'
    const draft = withoutSubscription(current.current, sourceId)
    const draftChoice = selection(draft, readLibrary(draft))
    const stop = connected && (!canStart(draft, draftChoice) ||
      (draft.mode !== 'direct' && Boolean(choice) && !draftChoice))
    if (stop) await native('stop')
    await enqueueWrite(async () => {
      const latest = current.current
      const next = withoutSubscription(latest, sourceId)
      await save(next, connected && !stop)
    })
    setDialog(undefined)
    notice(tr('订阅已删除'))
  }

  const showAllSubscriptions = () =>
    void task(() =>
      commit(latest => ({ ...latest, sourceFilter: latest.sources.map(source => source.id) }), false),
    )

  const nodePage = (
    nodes: Node[],
    scopeSources = sortedSources,
    includeCustom = true,
    activeScope = nodeScope,
    setActiveScope = setNodeScope,
    hiddenCount = 0,
  ) => <Nodes
    nodes={nodes} sources={scopeSources} includeCustom={includeCustom} model={model} library={library} selected={choice} busy={busy} probing={probing}
    batchProgress={batchProgress} onCancelProbe={cancelProbe}
    selecting={nodesSelecting} setSelecting={setNodesSelecting}
    hiddenSubscriptionCount={hiddenCount}
    onShowAllSubscriptions={showAllSubscriptions}
    onManageSubscriptions={() => go('subscriptions')}
    checked={checked} setChecked={setChecked} choose={choose}
    openNode={node => setDialog({ kind: 'node', node })} openGroup={group => setDialog({ kind: 'group', group })}
    openChain={() => setDialog({ kind: 'chain' })} openScope={() => setDialog({ kind: 'scope' })}
    density={nodeDensity} onOpenDensity={() => setDialog({ kind: 'nodeDensity' })}
    view={view => void task(() => commit(latest => ({ ...latest, view }), false))}
    probe={ids => void measure(ids, current.current, true, { batch: ids.length > 1 })} join={() => setDialog({ kind: 'join' })}
    scope={activeScope} setScope={setActiveScope}
    filters={{ search, setSearch, showFilter: nodesFilterOpen, setShowFilter: setNodesFilterOpen }} />

  const currentPhase: VpnStatus['phase'] =
    powerPending === 'start'
      ? 'starting'
      : powerPending === 'stop'
        ? 'stopping'
        : status.phase

  const hasPendingUpdate = Boolean(
    updateState.version &&
    updateState.version !== kernelInfo.appVersion &&
    !updateState.ignored &&
    updateState.phase !== 'idle' &&
    updateState.phase !== 'current',
  )

  async function runUpdateCommand(action: 'checkUpdate' | 'startUpdate' | 'pauseUpdate' | 'cancelUpdate' | 'ignoreUpdate' | 'installUpdate') {
    try {
      const payload = action === 'ignoreUpdate' && updateState.version ? { version: updateState.version } : undefined
      const next = await native<AndroidUpdateState>(action, payload)
      if (next) setUpdateState(next)
      if (action === 'ignoreUpdate') {
        setDialog(cur => (cur?.kind === 'update' ? undefined : cur))
        notice(tr('已忽略此版本'))
      }
      return next
    } catch (failure) {
      showMessage({ type: 'error', title: errorText(failure) })
      return undefined
    }
  }

  let page: ReactNode
  const back = () => { setDialog(undefined); setScreen(undefined); setNodesSelecting(false); setChecked([]) }
  if (!loaded) {
    page = null
  } else if (screen?.kind === 'import') {
    page = <><Header icon="import" animateKey={`import:${screenSource?.id ?? 'new'}`} statusPhase={currentPhase} title={screenSource ? tr('编辑订阅') : tr('导入订阅')} back={back} /><ImportView key={screenSource?.id ?? 'new'} source={screenSource} sources={library.sources} bindingField={screenSource && subscriptionBinding(screenSource.id)} onStartImport={startImport} /></>
  } else if (screen?.kind === 'yaml' && screenSource) {
    page = <><Header icon="yaml" animateKey={`yaml:${screenSource.id}`} statusPhase={currentPhase} title={tr("编辑 YAML")} back={back} /><YamlEditor key={screenSource.id} source={screenSource} compiled={effectiveYaml(library, screenSource.id)}
      busy={busy} save={text => replaceYaml(screenSource, text, true)} reset={() => confirm(tr('恢复订阅原文并清除本地副本'), () => replaceYaml(screenSource, screenSource.original, false))} /></>
  } else if (screen && screen.kind !== 'yaml') {
    const pageKind = screen.kind
    page = <><Header icon={pageKind} animateKey={`settings:${pageKind}`} statusPhase={currentPhase} title={settingsTitles[pageKind]} back={back} />
      {pageKind === 'theme' && <ThemeSettings value={library.theme} onChange={theme => void task(() => commit(latest => ({ ...latest, theme }), false))} />}
      {pageKind === 'routing' && <RoutingSettings library={library} model={model} busy={busy} sdk={kernelInfo.sdk}
        apps={history.map(conn => ({ executable: conn.metadata.process, path: conn.metadata.processPath, name: conn.appName, icon: conn.appIcon }))}
        save={routing => saveConfiguration({ ...current.current, routing }, true)} />}
      {pageKind === 'configFile' && <ConfigSettings library={library} busy={busy}
        save={patch => saveConfiguration(
          { ...current.current, ...patch },
          true,
          JSON.stringify(patch.network) !== JSON.stringify(current.current.network),
        )} />}
      {pageKind === 'kernel' && <KernelSettings info={kernelInfo} active={running}
        check={() => native<void>('validatePlan', { plan: prepareRouting(current.current).compiled.plan })} />}
      {pageKind === 'about' && (
        <AboutSettings
          info={kernelInfo}
          update={updateState}
          onCheckUpdate={() => runUpdateCommand('checkUpdate')}
          onStartUpdate={() => void runUpdateCommand('startUpdate')}
          onPauseUpdate={() => void runUpdateCommand('pauseUpdate')}
          onCancelUpdate={() => void runUpdateCommand('cancelUpdate')}
          onIgnoreUpdate={() => void runUpdateCommand('ignoreUpdate')}
          onInstallUpdate={() => void runUpdateCommand('installUpdate')}
        />
      )}
      {(pageKind === 'dns' || pageKind === 'tun' || pageKind === 'inbound' || pageKind === 'monitoring') &&
        <NetworkSettings key={pageKind} page={pageKind} library={library} busy={busy} sdk={kernelInfo.sdk}
          backgroundResult={backgroundResult}
          save={(network, monitoring) => saveConfiguration(
            { ...current.current, network, monitoring },
            pageKind !== 'monitoring',
            pageKind !== 'monitoring',
          )} />}
    </>
  } else {
    switch (tab) {
      case 'home': {
        page = <><Header
          icon="home"
          animateKey="tab:home"
          statusPhase={currentPhase}
          title={tr("仪表盘")}
        />
          <Home status={status} pending={powerPending} library={library} model={model} choice={choice} exit={exitInfo} exitChecking={exitChecking} exitFailed={exitFailed} rows={history} labels={compiled.labels} busy={busy}
            detect={detect} mode={switchMode}
            select={() => choice?.type === 'chain' ? setDialog({ kind: 'chain' }) : go('nodes')}
            openGroups={() => { setTab('nodes'); setScreen(undefined); setNodesSelecting(false); setChecked([]); setDialog({ kind: 'scope' }) }}
            connections={() => go('connections')}
            importSub={importSub} toggle={togglePower}
            openGroup={group => setDialog({ kind: 'group', group })}
            openConnection={conn => setDialog({ kind: 'connection', id: conn.id, snapshot: conn })}
            copyIp={ip => copySubscriptionText(ip).then(() => { notice(tr('出口 IP 已复制')); return true }).catch(() => { showMessage({ type: 'error', title: tr('复制失败') }); return false })} /></>
        break
      }
      case 'subscriptions':
        page = <><Header icon="subscriptions" animateKey="tab:subscriptions" statusPhase={currentPhase} title={tr("订阅")} action={(library.sources.length > 0 || pendingImports.length > 0) && <Button variant="default" onClick={importSub}><CloudDownload data-icon="inline-start" />{tr("导入订阅")}</Button>} />
          <Subscriptions sources={sortedSources} pendingImports={pendingImports} model={model} library={library} refreshing={refreshing}
            toggle={id => void task(() => commit(latest => ({
              ...latest,
              sourceFilter: id === '*'
                ? (latest.sourceFilter.length === latest.sources.length ? [] : latest.sources.map(source => source.id))
                : (latest.sourceFilter.includes(id) ? latest.sourceFilter.filter(source => source !== id) : [...latest.sourceFilter, id]),
            }), false))}
            refresh={source => refresh([source])} all={() => refresh(library.sources)} edit={source => setDialog({ kind: 'source', id: source.id })}
            detail={() => go('nodes')} importSub={importSub} /></>
        break
      case 'nodes':
        page = <><Header icon="nodes" animateKey="tab:nodes" statusPhase={currentPhase} title={tr("节点库")} action={<Button variant="default" onClick={() => setDialog({ kind: 'node' })}><Plus />{tr("添加节点")}</Button>} />{nodePage(visibleLibraryNodes, visibleSources, true, nodeScope, setNodeScope, hiddenSubscriptionCount)}</>
        break
      case 'connections':
        page = <><Header icon="connections" animateKey="tab:connections" statusPhase={currentPhase} title={tr("连接日志")} action={<Button variant="default" disabled={busy} onClick={() => {
          const chain = library.chains.find(chain => choice?.type === 'chain' && choice.id === chain.id) ?? library.chains.find(chain => compiled.byId.has(chain.id))
          if (chain) void task(() => measureChain(chain))
          else setDialog({ kind: 'chain' })
        }}><RefreshCw data-icon="inline-start" className={probing.length ? 'motion-safe:animate-spin' : undefined} />{tr("测整链")}</Button>} />
          <Connections running={running} rows={history} exit={exitInfo} labels={compiled.labels} busy={busy} measurement={chainMeasurement}
            filter={connectionsFilter} setFilter={setConnectionsFilter} query={connectionsQuery} setQuery={setConnectionsQuery}
            diagnose={detect}
            onClearLogs={() => void task(async () => {
              if (onAndroid) await native('clearConnectionLogs')
              logClearGeneration.current++
              setHistory(previous => previous.filter(row => !row.closed))
            })}
            onSelect={conn => setDialog({ kind: 'connection', id: conn.id, snapshot: conn })} /></>
        break
      case 'settings':
        page = <><Header icon="settings" animateKey="tab:settings" statusPhase={currentPhase} title={tr("设置")} /><SettingsIndex library={library} open={kind => setScreen({ kind })} update={updateState} /></>
        break
    }
  }

  let sheet: ReactNode
  let sheetTitle = ''
  if (dialog?.kind === 'node') {
    const node = dialog.node
    sheetTitle = node ? tr('编辑节点') : tr('添加自定义节点')
    sheet = <NodeEditor node={node} library={library} busy={busy} save={saveNode} test={draft => void task(() => measure([draft.id], nextNode(draft), false, { notify: 'nodeTest' }))}
      reset={node && (library.edits[node.id] || library.routing.ruleLibrary?.bindings['node:' + node.id]) ? () => void task(async () => {
        await commit(latest => {
          const edits = { ...latest.edits }; delete edits[node.id]
          return withBinding({ ...latest, edits }, 'node:' + node.id, '')
        })
        setDialog(undefined); notice(tr('已恢复订阅值'))
      }) : undefined}
      remove={node ? () => confirm(tr('删除节点「{0}」', node.config.name), () => void task(async () => {
        await removeNode(node); setDialog(undefined); notice(tr('节点已删除'))
      })) : undefined} />
  } else if (dialog?.kind === 'group') {
    const group = dialog.group
    sheetTitle = group ? (group.sourceId ? group.name : tr('编辑分组')) : tr('新建分组')
    sheet = <GroupEditor group={group} library={library} model={model} busy={busy}
      save={(next, binding) => void task(async () => {
        await commit(latest => withBinding({ ...latest, groups: [...latest.groups.filter(old => old.id !== next.id), next] }, 'group:' + next.id, binding))
        setDialog(undefined); notice(tr('分组已保存'))
      })}
      choose={group ? () => choose({ type: 'group', id: group.id }) : undefined}
      remove={group && !group.sourceId ? () => confirm(tr('删除分组「{0}」', group.name), () => void task(async () => {
        await commit(latest => withBinding({ ...latest, groups: latest.groups.filter(old => old.id !== group.id) }, 'group:' + group.id, ''))
        setDialog(undefined); notice(tr('分组已删除'))
      })) : undefined} />
  } else if (dialog?.kind === 'chain') {
    sheetTitle = tr('链路')
    sheet = <ChainEditor library={library} model={model} busy={busy}
      save={(chain, binding) => void task(async () => { await enqueueWrite(() => save(withBinding(chainLibrary(chain), 'chain:' + chain.id, binding))); notice(tr('链路已保存')) })}
      use={chain => choose({ type: 'chain', id: chain.id })}
      remove={chain => confirm(tr('删除链路「{0}」', chain.name), () => void task(async () => {
        await commit(latest => withBinding({ ...latest, chains: latest.chains.filter(c => c.id !== chain.id) }, 'chain:' + chain.id, ''))
        setDialog(undefined); notice(tr('链路已删除'))
      }))}
      test={chain => void task(() => measureChain(chain, true))} />
  } else if (dialog?.kind === 'join') {
    const groups = library.groups.filter(group => !group.automatic)
    sheetTitle = tr('加入分组')
    sheet = <div className="sheet-form">
      {!groups.length && <Empty icon={Network} title={tr("暂无手动分组")}><Button variant="default" onClick={() => setDialog({ kind: 'group' })}>{tr("新建分组")}</Button></Empty>}
      {groups.map(group => <button key={group.id} type="button" className="pick-row" disabled={busy} onClick={() => void task(async () => {
        const visibleIds = new Set(visibleLibraryNodes.map(node => node.id))
        const adding = checked.filter(id => visibleIds.has(id))
        await commit(latest => ({
          ...latest,
          groups: latest.groups.map(old => old.id === group.id ? { ...old, members: [...new Set([...old.members, ...adding])] } : old),
        }))
        setDialog(undefined); setNodesSelecting(false); setChecked([]); notice(tr('已加入「{0}」', group.name))
      })}><Network size={16} /><span>{group.name}</span><Tag>{group.members.length}{tr(" 个成员")}</Tag></button>)}
    </div>
  } else if (dialog?.kind === 'connection') {
    const conn = history.find(item => item.id === dialog.id) ?? dialog.snapshot
    sheetTitle = tr('连接与分流策略')
    sheet = (
      <ConnectionPolicySheet
        key={conn.id}
        conn={conn}
        history={history}
        library={library}
        model={model}
        labels={compiled.labels}
        running={running}
        busy={busy}
        sdk={kernelInfo.sdk}
        onSwitchToRuleMode={() =>
          void task(async () => {
            await commit(latest => ({ ...latest, mode: 'rule' }), running)
          })
        }
        onSaveRouting={(nextRouting, processName, host) =>
          void task(async () => {
            validateRouting(nextRouting)
            await commit(latest => ({ ...latest, routing: nextRouting }), running)
            if (running) {
              const targetProc = processName?.trim().toLowerCase()
              const targetHost = host?.trim().toLowerCase()
              const matching = history.filter(item => {
                if (item.closed) return false
                if (targetProc) return item.metadata.process?.trim().toLowerCase() === targetProc
                if (targetHost) {
                  const itemHost = (item.metadata.host || item.metadata.destinationIP || '').trim().toLowerCase()
                  return itemHost === targetHost || itemHost.endsWith('.' + targetHost)
                }
                return false
              })
              await Promise.allSettled(matching.map(item => native('closeConnection', { id: item.id })))
            }
            setDialog(undefined)
            notice(tr('已保存到「设置 → 分流规则 → 自定义规则」'))
          })
        }
        onCopyDest={dest =>
          void copySubscriptionText(dest)
            .then(() => notice(tr('已复制目标地址')))
            .catch(() => showMessage({ type: 'error', title: tr('复制失败') }))
        }
        onCloseConnection={id =>
          void task(async () => {
            await native('closeConnection', { id })
            setDialog(undefined)
          })
        }
      />
    )
  } else if (dialog?.kind === 'source') {
    const source = library.sources.find(source => source.id === dialog.id)
    sheetTitle = source?.name ?? tr('订阅管理')
    if (source) {
      const openTool = (data: SubscriptionToolData) => {
        setDialog({ kind: 'tool', key: `${source.id}:${data.kind}`, name: source.name, data })
      }
      sheet = <SourceActionsSheet
        bindingField={subscriptionBinding(source.id)}
        source={source}
        copied={copied === source.id}
        isRefreshing={refreshing.includes(source.id)}
        canMoveUp={sortedSources[0]?.id !== source.id}
        canMoveDown={sortedSources.at(-1)?.id !== source.id}
        onEditImport={() => { setDialog(undefined); setScreen({ kind: 'import', id: source.id }) }}
        onEditYaml={() => { setDialog(undefined); setScreen({ kind: 'yaml', id: source.id }) }}
        onExtension={() => openTool({
          kind: 'extension',
          extension: source.extension ?? emptyExtension,
          save: extension => updateSource(source.id, JSON.stringify(source.extension ?? emptyExtension) === JSON.stringify(extension) ? {} : { extension, autoUpdate: false }, running),
        })}
        onPolicy={() => openTool({
          kind: 'policy',
          enabled: source.autoUpdate !== false,
          hours: source.customHours,
          provider: source.intervalHours,
          save: (autoUpdate, customHours) => updateSource(source.id, { autoUpdate, customHours }, false),
        })}
        onRefresh={() => { setDialog(undefined); refresh([source]) }}
        onRuntime={() => void task(async () => {
          const usesSource = compiled.ruleSourceId === source.id
          const active = running && usesSource ? await native<object | null>('runtimeConfig') : null
          openTool({
            kind: 'runtime',
            yaml: active ? '# ' + tr('当前运行配置') + '\n' + stringify(active) : '# ' + tr('按当前设置生成的订阅预览') + '\n' + effectiveYaml(library, source.id),
          })
        })}
        onCopyLink={() => void task(() => copy(source.id, source.url!))}
        onQr={() => openTool({ kind: 'qr', url: source.url! })}
        onExport={() => void task(async () => {
          const text = source.extendedYaml ?? source.yaml
          const name = source.name.replace(/[<>:"/\\|?*]/g, '_').replace(/\.ya?ml$/i, '') + '.yaml'
          if (onAndroid) {
            if (await native('export', { name, text })) notice(tr('订阅文件已导出'))
          } else downloadSubscription(name, text)
        })}
        onMove={delta => { moveSource(source.id, delta); setDialog(undefined) }}
        onDelete={() => setDialog({ kind: 'deleteSource', id: source.id })}
      />
    }
  } else if (dialog?.kind === 'tool') {
    sheetTitle = `${subscriptionToolLabels[dialog.data.kind]} · ${dialog.name}`
    sheet = <SubscriptionToolBody key={dialog.key} mobile data={dialog.data} close={() => setDialog(undefined)} />
  } else if (dialog?.kind === 'deleteSource') {
    const source = library.sources.find(source => source.id === dialog.id)
    sheetTitle = tr('删除订阅')
    if (source) {
      const stopsProxy = running && library.mode !== 'direct' && model.nodes.length > 0 &&
        model.nodes.every(node => node.sourceId === source.id)
      sheet = <div className="sheet-form">
        <p>{tr('删除「{0}」及其节点和分组？规则集绑定将跟随默认。指向已删除节点或分组的全局规则将拒绝连接。', source.name)}{stopsProxy && tr('删除后将自动停止代理。')}</p>
        <div className="sheet-actions justify-end">
          <Button variant="outline" onClick={() => setDialog(undefined)}>{tr("取消")}</Button>
          <Button variant="destructive" disabled={busy} onClick={() => void task(() => removeSource(source.id))}>{tr("确认删除")}</Button>
        </div>
      </div>
    }
  } else if (dialog?.kind === 'scope') {
    sheetTitle = tr('订阅与分组')
    sheet = <NodeScopeSheet
      nodes={visibleLibraryNodes}
      sources={visibleSources}
      includeCustom
      model={model}
      library={library}
      selected={choice}
      scope={nodeScope}
      onSelect={next => {
        setNodeScope(next)
        setNodesSelecting(false)
        setChecked([])
        setDialog(undefined)
      }}
      onCreateGroup={() => setDialog({ kind: 'group' })}
      onEditGroup={group => setDialog({ kind: 'group', group })}
    />
  } else if (dialog?.kind === 'nodeDensity') {
    sheetTitle = tr('选择布局模式')
    sheet = (
      <NodeDensitySheet
        value={nodeDensity}
        onSelect={next => {
          setNodeDensity(next)
          preferences.setItem('air.mobile.nodeDensity', next)
          if (library.view !== 'cards') {
            void task(() => commit(latest => ({ ...latest, view: 'cards' }), false))
          }
          setDialog(undefined)
        }}
      />
    )
  } else if (dialog?.kind === 'update') {
    sheetTitle = updateState.version ? `Air Proxy ${updateState.version}${tr(' 可更新')}` : tr('软件更新')
    const openUpdateFallback = (url: string) => {
      if (!onAndroid) {
        window.open(url, '_blank', 'noopener,noreferrer')
        return
      }
      void native('openLink', { url }).catch(failure => showMessage({ type: 'error', title: errorText(failure) }))
    }
    sheet = (
      <div className="sheet-form">
        <AndroidUpdatePanel
          update={updateState}
          onOpenLink={openUpdateFallback}
          onStart={() => void runUpdateCommand('startUpdate')}
          onPause={() => void runUpdateCommand('pauseUpdate')}
          onCancel={() => void runUpdateCommand('cancelUpdate')}
          onIgnore={() => void runUpdateCommand('ignoreUpdate')}
          onInstall={() => void runUpdateCommand('installUpdate')}
          onDismiss={() => setDialog(undefined)}
          notesMaxHeightClass="max-h-48"
          inSheet
        />
      </div>
    )
  } else if (dialog?.kind === 'delete') {
    sheetTitle = tr('确认操作')
    sheet = <div className="sheet-form"><p>{dialog.label}</p><div className="sheet-actions justify-end">
      <Button variant="outline" onClick={() => setDialog(undefined)}>{tr("取消")}</Button><Button variant="destructive" disabled={busy} onClick={dialog.apply}>{tr("确认")}</Button>
    </div></div>
  }

  return <MotionConfig reducedMotion="user"><div className="mobile-shell">
    {loaded && (
      <>
        {page}
        <BottomNavigation page={tab} onChange={go} settingsBadge={hasPendingUpdate} />
        <Sheet open={Boolean(dialog && sheet)} title={sheetTitle} close={() => { if (updateState.phase !== 'installing') setDialog(undefined) }}>{sheet}</Sheet>
      </>
    )}
    <AnimatePresence>
      {!loaded && (!onAndroid || Boolean(loadError)) && (
        <motion.div
          key="air-splash"
          className="air-splash"
          initial={{ opacity: 1 }}
          exit={{ opacity: 0, scale: 1.03, transition: { duration: 0.22, ease: 'easeOut' } }}
        >
          <div className="air-splash-mark">
            <div className="air-splash-glow" aria-hidden="true" />
            <img src={airLogo} alt="" className="air-splash-logo" draggable={false} />
          </div>
          <strong className="air-splash-title">Air Proxy</strong>
          {loadError ? (
            <div className="air-splash-error">
              <p role="alert">{loadError}</p>
              <Button variant="default" onClick={() => location.reload()}>{tr("重新加载")}</Button>
            </div>
          ) : (
            <div className="air-splash-bar" aria-label={tr("正在启动")} role="status" />
          )}
        </motion.div>
      )}
    </AnimatePresence>
    <MessageViewport mobile />
  </div></MotionConfig>
}

function SourceActionsSheet({ source, bindingField, copied, isRefreshing, canMoveUp, canMoveDown, onEditImport, onEditYaml, onExtension, onPolicy, onRefresh, onRuntime, onCopyLink, onQr, onExport, onMove, onDelete }: {
  source: Subscription
  bindingField?: ReactNode
  copied: boolean
  isRefreshing: boolean
  canMoveUp: boolean
  canMoveDown: boolean
  onEditImport: () => void
  onEditYaml: () => void
  onExtension: () => void
  onPolicy: () => void
  onRefresh: () => void
  onRuntime: () => void
  onCopyLink: () => void
  onQr: () => void
  onExport: () => void
  onMove: (delta: -1 | 1) => void
  onDelete: () => void
}) {
  const [expanded, setExpanded] = useState(false)
  return (
    <div className="sheet-form">
      {bindingField}
      <div className="panel settings-panel">
        <Row icon={CloudDownload} title={tr("编辑订阅")} onClick={onEditImport} />
        <Row icon={FileCode2} title={tr("编辑 YAML")} onClick={onEditYaml} />
        <Row icon={Puzzle} title={tr("扩展")} onClick={onExtension} />
        {source.url && (
          <Row icon={CalendarClock} title={source.autoUpdate === false ? tr('自动更新（已暂停）') : tr('自动更新')} onClick={onPolicy} />
        )}
        {source.url && (
          <Row icon={RefreshCw} title={isRefreshing ? tr('正在刷新…') : tr('同步')} onClick={() => { if (!isRefreshing) onRefresh() }} />
        )}
        <button
          type="button"
          className="setting-row"
          aria-expanded={expanded}
          onClick={() => setExpanded(value => !value)}
        >
          <span className="row-icon">
            <ChevronDown size={17} className="setting-row-arrow" data-open={expanded || undefined} />
          </span>
          <span className="row-main">
            <b>{tr("更多操作")}</b>
            <small>{tr("预览配置、二维码、导出与排序")}</small>
          </span>
          <small className="shrink-0 whitespace-nowrap">{expanded ? tr('收起') : tr('展开')}</small>
        </button>
        <AnimatePresence initial={false}>
          {expanded && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
              className="overflow-hidden border-t border-border-subtle"
            >
              <Row icon={Eye} title={tr("运行时配置")} onClick={onRuntime} />
              {source.url && (
                <>
                  <Row icon={copied ? Check : Copy} title={copied ? tr('复制成功') : tr('复制链接')} onClick={onCopyLink} />
                  <Row icon={QrCode} title={tr("二维码")} onClick={onQr} />
                </>
              )}
              <Row icon={Download} title={tr("导出文件")} onClick={onExport} />
              {canMoveUp && <Row icon={ArrowUp} title={tr("上移订阅")} onClick={() => onMove(-1)} />}
              {canMoveDown && <Row icon={ArrowDown} title={tr("下移订阅")} onClick={() => onMove(1)} />}
            </motion.div>
          )}
        </AnimatePresence>
        <Row icon={Trash2} title={tr("删除订阅")} onClick={onDelete} />
      </div>
    </div>
  )
}
