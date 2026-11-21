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
import { SubscriptionTool, type SubscriptionToolData } from '@/shared/ui/SubscriptionTool'
import { downloadSubscription, emptyExtension, extendSubscription } from '@/shared/proxy/subscription-extension'
import { useSubscriptionOrder } from '@/shared/proxy/useSubscriptionOrder'
import { copySubscriptionText, native, onAndroid } from './bridge'
import { waitForProxyPowerAnimation } from '@/shared/ui/ProxyPowerButton'
import { id as createId, remoteSubscriptionName, type SubscriptionDownload, canStart, compile, defaultLibrary, effectiveYaml, membersOf, readLibrary, restoreLibrary, selection, withoutSubscription, yamlProfile, type Chain, type Choice, type Connection, type ExitInfo, type Group, type Library, type Node, type Subscription, type ProbeSample, type VpnStatus } from './model'
import { Connections, Home, Nodes, PowerButton, Subscriptions, type ChainMeasurement, type PendingImport } from './views'
import { ChainEditor, GroupEditor, ImportView, NodeEditor, YamlEditor, type SubscriptionImportRequest } from './workflows'
import { BottomNavigation, Empty, Header, Row, Sheet, Tag } from './ui'
import { validateNetwork, validateRouting } from './configuration'
import { NetworkSettings } from './network-settings'
import { AboutSettings, ConfigSettings, KernelSettings, RoutingSettings, SettingsIndex, ThemeSettings, settingsTitles, type KernelInfo, type SettingsPage } from './settings'
type Screen =
  | { kind: 'import' | 'yaml'; id?: string }
  | { kind: 'content' | SettingsPage }
type Dialog =
  | { kind: 'node'; node?: Node }
  | { kind: 'group'; group?: Group }
  | { kind: 'source' | 'deleteSource'; id: string }
  | { kind: 'chain' | 'join' }
  | { kind: 'delete'; label: string; apply: () => void }

const emptyStatus: VpnStatus = { phase: 'idle', startedAt: 0, traffic: {} }
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error)
const defaultKernel: KernelInfo = { version: '1.19.34', appVersion: '1.0.2', sdk: 35, abi: 'Android' }
type MonitorResult = { at: number; available: number; checked: number; error?: string; samples?: Record<string, ProbeSample[]> }

function monitorPlan(library: Library, model = readLibrary(library), config = compile(library, model)) {
  return {
    plan: config.plan, url: library.network.probeUrl, expected: library.network.probeStatus,
    interval: library.network.probeIntervalMinutes,
    targets: Object.fromEntries(model.nodes.map(node => [node.id, config.byId.get(node.id)!])),
  }
}

export function App() {
  const [tab, setTab] = useState<Tab>('home')
  const [screen, setScreen] = useState<Screen>()
  const { copied, copy } = useCopyFeedback(copySubscriptionText)
  const [tool, setTool] = useState<{ name: string; data: SubscriptionToolData }>()
  const [dialog, setDialog] = useState<Dialog>()
  const [library, setLibrary] = useState<Library>(defaultLibrary)
  const { sorted: sortedSources, move: moveSource } = useSubscriptionOrder(library.sources)
  const [loaded, setLoaded] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [status, setStatus] = useState(emptyStatus)
  const [exitInfo, setExitInfo] = useState<ExitInfo>()
  const [history, setHistory] = useState<Connection[]>([])
  const [chainMeasurement, setChainMeasurement] = useState<ChainMeasurement>()
  const [busy, setBusy] = useState(false)
  const [powerPending, setPowerPending] = useState<'start' | 'stop'>()
  const [probing, setProbing] = useState<string[]>([])
  const [refreshing, setRefreshing] = useState<string[]>([])
  const [pendingImports, setPendingImports] = useState<PendingImport[]>([])
  const lastStatusError = useRef<string | undefined>(undefined)
  const [kernelInfo, setKernelInfo] = useState(defaultKernel)
  const [backgroundResult, setBackgroundResult] = useState<MonitorResult>()
  const monitorAt = useRef(0)
  const [checked, setChecked] = useState<string[]>([])
  const [search, setSearch] = useState('')
  const [sourceFilter, setSourceFilter] = useState('')
  const working = useRef(false)
  const outboundRevision = useRef(0)
  const [darkSystem, setDarkSystem] = useState(() => matchMedia('(prefers-color-scheme: dark)').matches)
  const model = useMemo(() => readLibrary(library), [library])
  const choice = useMemo(() => selection(library, model), [library, model])
  const compiled = useMemo(() => compile(library, model), [library, model])
  const running = status.phase === 'running'
  const dark = library.theme === 'dark' || library.theme === 'system' && darkSystem
  const screenSource = screen && 'id' in screen && library.sources.find(source => source.id === screen.id) || undefined
  const selectedNodes = model.nodes.filter(node => library.sourceFilter.includes(node.sourceId))

  useEffect(() => {
    let active = true
    void native<Parameters<typeof restoreLibrary>[0] & { upgradeMonitorPlan?: boolean }>('load').then(async ({ upgradeMonitorPlan, ...saved }) => {
      if (!active) return
      const data = restoreLibrary(saved)
      const renamed = data.sources.some((source, index) => source.name !== saved.sources?.[index]?.name)
      if (renamed || (upgradeMonitorPlan && data.monitoring)) {
        await native('save', { ...data, monitorPlan: data.monitoring ? monitorPlan(data) : undefined })
        if (!active) return
      }
      setLibrary(data)
      setLoaded(true)
    }).catch(error => {
      if (!active) return
      const text = errorText(error)
      setLoadError(text)
      showMessage({ type: 'error', title: '读取节点库失败', description: text })
    })
    void native<KernelInfo>('kernelInfo').then(info => { if (active) setKernelInfo(info) }).catch(() => undefined)
    const media = matchMedia('(prefers-color-scheme: dark)')
    const update = () => setDarkSystem(media.matches)
    media.addEventListener('change', update)
    return () => { active = false; media.removeEventListener('change', update) }
  }, [])

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
    document.documentElement.dataset.theme = dark ? 'dark' : 'light'
    void native('theme', { dark }).catch(() => undefined)
  }, [dark])

  useEffect(() => {
    let gone = false
    let nowSampling = false
    async function reload() {
      if (document.hidden || nowSampling) return
      nowSampling = true
      try {
        const next = await native<VpnStatus>('status')
        if (!gone) setStatus(next)
      } catch { /* Retain the last status during a WebView pause. */ }
      finally { nowSampling = false }
    }
    void reload()
    const interval = window.setInterval(() => void reload(), 850)
    document.addEventListener('visibilitychange', reload)
    return () => { gone = true; clearInterval(interval); document.removeEventListener('visibilitychange', reload) }
  }, [])

  useEffect(() => {
    let cancelled = false
    let sampling = false
    if (!running) return
    async function connections() {
      if (document.hidden || sampling) return
      sampling = true
      try {
        const response = await native<{ connections?: Connection[]; applications?: Record<string, { name: string; icon?: string }> }>('connections')
        if (cancelled) return
        const active = (response.connections ?? []).map((row): Connection => {
          const app = response.applications?.[row.metadata.process ?? '']
          return app ? { ...row, appName: app.name, appIcon: app.icon } : row
        })
        const ids = new Set(active.map(row => row.id))
        setHistory(previous => [...active, ...previous.filter(row => !ids.has(row.id)).map(row => ({ ...row, closed: true }))].slice(0, 80))
      } catch { /* A connection can end while an update is in progress. */ }
      finally { sampling = false }
    }
    void connections()
    const tick = setInterval(() => void connections(), tab === 'connections' ? 1400 : 2500)
    return () => { cancelled = true; clearInterval(tick) }
  }, [running, tab, status.startedAt])

  useEffect(() => {
    if (!running) { setExitInfo(undefined); return }
    const revision = ++outboundRevision.current
    setExitInfo(undefined)
    setHistory([])
    void native<ExitInfo>('exit', { mode: library.mode }).then(result => {
      if (revision === outboundRevision.current) setExitInfo(result)
    }).catch(() => undefined)
    return () => { outboundRevision.current++ }
  }, [running, status.startedAt, library.mode, choice?.id])

  useEffect(() => {
    const back = (event: Event) => {
      if (tool) { event.preventDefault(); setTool(undefined) }
      else if (dialog) { event.preventDefault(); setDialog(undefined) }
      else if (screen) { event.preventDefault(); setScreen(undefined) }
      else if (tab !== 'home') { event.preventDefault(); setTab('home') }
    }
    window.addEventListener('air-back', back)
    return () => window.removeEventListener('air-back', back)
  }, [dialog, screen, tab, tool])

  async function task(work: () => Promise<unknown>) {
    if (!loaded || working.current) return
    working.current = true
    setBusy(true)
    try { await work() }
    catch (error) { showMessage({ type: 'error', title: errorText(error) }) }
    finally { working.current = false; setBusy(false) }
  }

  async function save(next: Library, applyLive = running) {
    const sources = await Promise.all(next.sources.map(async source => {
      if (!source.extension?.script.trim() && !source.extension?.rules.length)
        return source.extendedYaml === undefined ? source : { ...source, extendedYaml: undefined }
      const old = current.current.sources.find(item => item.id === source.id)
      if (old?.extendedYaml && old.yaml === source.yaml && old.extension === source.extension) return source
      const extendedYaml = await extendSubscription(source.yaml, source.extension)
      yamlProfile(extendedYaml)
      return { ...source, extendedYaml }
    }))
    next = { ...next, sources }
    const nextModel = readLibrary(next)
    const nextConfig = compile(next, nextModel)
    if (applyLive && !canStart(next, nextConfig.choice)) throw new Error('请先停止代理，再移除最后一个可用出站')
    if (applyLive) await native('apply', nextConfig.plan)
    try {
      await native('save', { ...next, monitorPlan: next.monitoring ? monitorPlan(next, nextModel, nextConfig) : undefined })
      current.current = next
      setLibrary(next)
    } catch (error) {
      if (applyLive) await native('apply', compiled.plan).catch(() => undefined)
      throw error
    }
  }

  function saveConfiguration(next: Library, apply: boolean) {
    void task(async () => {
      validateNetwork(next.network)
      validateRouting(next.routing)
      if (kernelInfo.sdk < 33 && next.network.routeExcludeAddress.length) throw new Error('绕过网段需要 Android 13 或更新版本')
      if (kernelInfo.sdk < 29 && next.routing.rules.some(rule => rule.enabled && rule.matcher === 'processName')) {
        throw new Error('按应用包名分流需要 Android 10 或更新版本')
      }
      const effective = compile(next)
      const targets = [next.routing.fallback, ...next.routing.rules.filter(rule => rule.enabled).map(rule => rule.target)]
      if (targets.some(target => 'id' in target && !effective.byId.has(target.id))) throw new Error('有规则指向不可用的分组或链路')
      if (targets.some(target => target.kind === 'subscription') && !next.sources.some(source => source.id === next.routing.subscriptionId)) {
        throw new Error('请选择可用的订阅规则来源')
      }
      if (onAndroid) await native('validatePlan', { plan: effective.plan })
      await save(next, running && apply)
      notice(running && !apply ? '已保存，下次启动代理生效' : '配置已保存')
    })
  }

  const change = (next: Library, apply = true) => { void task(() => save(next, running && apply)) }
  const notice = (title: string) => showMessage({ type: 'success', title })
  const go = (next: Tab) => { setTab(next); setScreen(undefined); setDialog(undefined) }
  const importSub = () => { setDialog(undefined); setTab('subscriptions'); setScreen({ kind: 'import' }) }
  function choose(outbound: Choice) {
    void task(async () => {
      await save({ ...library, choice: outbound })
      setDialog(undefined)
      notice('已设为当前出站')
    })
  }

  function togglePower() {
    if (!running && !canStart(library, choice)) {
      showMessage({ type: 'info', title: '请先导入订阅或添加节点' })
      if (model.nodes.length) go('nodes')
      else importSub()
      return
    }
    void task(async () => {
      const action = running ? 'stop' : 'start'
      const startedAt = performance.now()
      setPowerPending(action)
      try {
        if (action === 'stop') await native('stop')
        else await native('start', compiled.plan)
        if (!document.hidden) await waitForProxyPowerAnimation(action, startedAt)
        setStatus(await native<VpnStatus>('status'))
      } finally {
        setPowerPending(undefined)
      }
    })
  }

  function detect() {
    void task(async () => {
      const value = await native<ExitInfo>('exit', { mode: library.mode })
      setExitInfo(value)
      notice('已验证出口 IP')
    })
  }

  useEffect(() => {
    if (status.error && status.error !== lastStatusError.current) {
      lastStatusError.current = status.error
      showMessage({ type: 'error', title: '代理异常', description: status.error })
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
    const host = url ? (() => { try { return new URL(url).hostname || url } catch { return url } })() : (request.file?.name || request.source?.name || '本地订阅')
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
        if (source && existing && url !== source.url) throw new Error('这个链接已用于另一条订阅')
        const previous = source ?? existing
        const requested = source && source.name === request.name.trim() ? '' : request.name.trim()

        let built: Subscription
        let nodeCount: number | undefined
        if (source && !picked && url === source.url) {
          const localBase = requested || source.baseName || source.name || '本地订阅'
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
          const localBase = requested || latestPrevious?.baseName || latestPrevious?.name || picked?.name || '本地订阅'
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

        // 等待正在进行的其他写操作释放后再安全合并最新状态
        while (working.current) {
          await new Promise(resolve => window.setTimeout(resolve, 60))
        }
        working.current = true
        setBusy(true)
        try {
          const latest = current.current
          const exists = latest.sources.some(old => old.id === built.id)
          const saved = { ...built, ...subscriptionLabel(built.baseName ?? built.name, latest.sources, built) }
          const next: Library = {
            ...latest,
            sources: exists ? latest.sources.map(old => old.id === built.id ? saved : old) : [...latest.sources, saved],
            sourceFilter: exists ? latest.sourceFilter : [...latest.sourceFilter, saved.id],
          }
          await save(next)
          showMessage({
            type: 'success',
            title: exists ? `已保存订阅 · ${saved.name}` : `订阅已导入 · ${saved.name}`,
            description: nodeCount !== undefined ? `${nodeCount} 个节点` : undefined,
          })
        } finally {
          working.current = false
          setBusy(false)
        }
      } catch (error) {
        showMessage({
          type: 'error',
          title: `导入订阅失败 · ${label}`,
          description: errorText(error),
        })
      } finally {
        setPendingImports(previous => previous.filter(item => item.id !== taskId))
      }
    })()
  }

  const nextAutoCheck = useRef(0)
  const current = useRef(library)
  current.current = library

  function refresh(sources: Subscription[], automatic = false) {
    void task(async () => {
      setRefreshing(sources.filter(source => source.url).map(source => source.id))
      try {
        let count = 0
        const errors: string[] = []
        for (const source of sources.filter(source => source.url)) {
          const matches = (item: Subscription) => item.id === source.id && item.updated === source.updated &&
            item.url === source.url && (!automatic || item.autoUpdate !== false)
          if (!current.current.sources.some(matches)) continue
          try {
            const staged = automatic ? await native<SubscriptionDownload | null>('stagedSubscription', {
              id: source.id, url: source.url, updated: source.updated,
            }) : null
            const response = staged ?? await native<SubscriptionDownload>('fetch', { url: source.url })
            yamlProfile(response.text)
            const latest = current.current
            const original = latest.sources.find(matches)
            if (!original) continue
            const next = { ...original, ...remoteSubscriptionName(source.url!, '', latest.sources, response.profileTitle, original),
              yaml: original.edited ? original.yaml : response.text,
              original: response.text, usage: response.usage, intervalHours: response.intervalHours,
              updated: Date.now(), attempted: Date.now(), refreshError: undefined }
            await save({ ...latest, sources: latest.sources.map(item => item.id === next.id ? next : item) })
            count++
          } catch (error) {
            const reason = errorText(error)
            errors.push(source.name + '：' + reason)
            const latest = current.current
            if (latest.sources.some(matches)) await save({ ...latest, sources: latest.sources.map(item => matches(item) ?
              { ...item, attempted: Date.now(), refreshError: reason } : item) }, false)
          }
        }
        if (!automatic && errors.length) throw new Error(errors.join('；'))
        if (!automatic && count) notice('订阅已同步')
      } finally { setRefreshing([]) }
    })
  }

  useEffect(() => {
    if (!loaded || !onAndroid || screen || dialog || tool) return
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
  }, [loaded, library, screen, dialog, tool, running])

  function replaceYaml(source: Subscription, text: string, edited: boolean) {
    void task(async () => {
      yamlProfile(text)
      await save({ ...library, sources: library.sources.map(old => old.id === source.id ? { ...old, yaml: text, edited, autoUpdate: edited ? false : old.autoUpdate } : old) })
      setScreen(undefined)
      setDialog(undefined)
      notice(edited ? 'YAML 已保存' : '已恢复订阅原文')
    })
  }

  function nextNode(node: Node): Library {
    if (node.sourceId !== 'custom') return { ...library, sources: pauseSource(node.sourceId), edits: { ...library.edits, [node.id]: node.config } }
    const exists = library.nodes.some(old => old.id === node.id)
    return { ...library, nodes: exists ? library.nodes.map(old => old.id === node.id ? node : old) : [...library.nodes, node] }
  }

  function pauseSource(id: string) {
    return library.sources.map(source => source.id === id ? { ...source, autoUpdate: false } : source)
  }

  async function updateSource(id: string, patch: Partial<Subscription>, live: boolean) {
    if (working.current) throw new Error('正在处理其他操作，请稍后重试')
    working.current = true
    setBusy(true)
    try {
      const latest = current.current
      if (!latest.sources.some(src => src.id === id)) throw new Error('订阅已不存在')
      await save({ ...latest, sources: latest.sources.map(src => src.id === id ? { ...src, ...patch } : src) }, live)
    } finally { working.current = false; setBusy(false) }
  }

  function saveNode(node: Node) {
    void task(async () => { await save(nextNode(node)); setDialog(undefined); notice('节点已保存') })
  }

  function removeNode(node: Node) {
    const edits = { ...library.edits }
    delete edits[node.id]
    return save({
      ...library,
      nodes: library.nodes.filter(n => n.id !== node.id),
      sources: pauseSource(node.sourceId),
      hiddenNodes: node.sourceId === 'custom' ? library.hiddenNodes : [...library.hiddenNodes, node.id],
      edits,
      groups: library.groups.map(group => ({ ...group, members: group.members.filter(id => id !== node.id) })),
    })
  }

  async function measure(ids: string[], libraryForTest = library, record = true) {
    const plan = compile(libraryForTest)
    const probes = { ...library.probes }
    // Each hosts scope needs its own native profile and eight-second probe window.
    const batches: { id: string; alias: string }[][] = []
    const byScope = new Map<number, (typeof batches)[number]>()
    for (const id of new Set(ids)) {
      const alias = plan.byId.get(id)
      if (!alias) continue
      const scope = plan.plan.hostScopes?.byProxy[alias] ?? 0
      let batch = byScope.get(scope)
      if (!batch || batch.length === 6) {
        batch = []
        batches.push(batch)
        byScope.set(scope, batch)
      }
      batch.push({ id, alias })
    }
    const targets = batches.flat()
    if (!targets.length) return
    setProbing(targets.map(target => target.id))
    try {
      let last = -1
      let successes = 0
      for (const chunk of batches) {
        const results = await native<Record<string, number>>('probe', {
          plan: plan.plan, url: library.network.probeUrl, expected: library.network.probeStatus, aliases: chunk.map(item => item.alias),
        })
        for (const { id, alias } of chunk) {
          last = results[alias] ?? -1
          if (last > 0) successes++
          probes[id] = [...(probes[id] ?? []).filter(sample => Date.now() - sample.at < 86_400_000).slice(-95), { at: Date.now(), delay: last }]
        }
      }
      if (record) await save({ ...library, probes }, running && library.groups.some(group => Boolean(group.automatic)))
      if (targets.length === 1) {
        showMessage({ type: last > 0 ? 'success' : 'warning', title: last > 0 ? '连接成功 · ' + last + ' ms' : '连接超时' })
      } else showMessage({ type: successes ? 'success' : 'warning', title: '测速完成 · ' + successes + ' / ' + targets.length + ' 可用' })
      return last
    } finally { setProbing([]) }
  }

  const chainLibrary = (chain: Chain) => ({ ...library, chains: [...library.chains.filter(old => old.id !== chain.id), chain] })
  async function measureChain(chain: Chain) {
    const result = await measure([chain.id], chainLibrary(chain), false)
    if (result === undefined) throw new Error('请选择至少两个可用节点组成链路')
    setChainMeasurement({ name: chain.name, delay: result,
      hops: chain.hops.map(id => model.nodes.find(node => node.id === id)?.config.name ?? '未知节点') })
  }

  async function removeSource(sourceId: string) {
    const next = withoutSubscription(library, sourceId)
    const current = await native<VpnStatus>('status')
    if (current.phase === 'starting') throw new Error('代理正在启动，请稍后再删除订阅')
    const connected = current.phase === 'running'
    const stop = connected && (!canStart(next, next.choice) ||
      (next.mode !== 'direct' && Boolean(choice) && !next.choice))
    if (stop) await native('stop')
    await save(next, connected && !stop)
    setDialog(undefined)
    notice('订阅已删除')
  }

  const nodePage = (nodes: Node[]) => <Nodes
    nodes={nodes} model={model} library={library} selected={choice} busy={busy} probing={probing}
    checked={checked} setChecked={setChecked} choose={choose}
    openNode={node => setDialog({ kind: 'node', node })} openGroup={group => setDialog({ kind: 'group', group })}
    openChain={() => setDialog({ kind: 'chain' })} view={view => change({ ...library, view }, false)}
    probe={ids => void task(() => measure(ids))} join={() => setDialog({ kind: 'join' })}
    filters={{ search, setSearch, source: sourceFilter, setSource: setSourceFilter }} />

  let page: ReactNode
  const back = () => { setDialog(undefined); setScreen(undefined) }
  if (!loaded) {
    page = null
  } else if (screen?.kind === 'import') {
    page = <><Header title={screenSource ? '编辑订阅' : '导入订阅'} back={back} /><ImportView key={screenSource?.id ?? 'new'} source={screenSource} sources={library.sources} onStartImport={startImport} /></>
  } else if (screen?.kind === 'yaml' && screenSource) {
    page = <><Header title="编辑 YAML" back={back} /><YamlEditor key={screenSource.id} source={screenSource} compiled={effectiveYaml(library, screenSource.id)}
      busy={busy} save={text => replaceYaml(screenSource, text, true)} reset={() => confirm('恢复订阅原文并清除本地副本', () => replaceYaml(screenSource, screenSource.original, false))} /></>
  } else if (screen?.kind === 'content') {
    page = <><Header title="所选订阅内容" back={back} />{nodePage(selectedNodes)}</>
  } else if (screen && screen.kind !== 'yaml') {
    const current = screen.kind
    page = <><Header title={settingsTitles[current]} back={back} />
      {current === 'theme' && <ThemeSettings value={library.theme} onChange={theme => change({ ...library, theme }, false)} />}
      {current === 'routing' && <RoutingSettings library={library} model={model} busy={busy} sdk={kernelInfo.sdk}
        save={routing => saveConfiguration({ ...library, routing }, true)} />}
      {current === 'configFile' && <ConfigSettings library={library} busy={busy}
        save={patch => saveConfiguration({ ...library, ...patch }, true)} />}
      {current === 'kernel' && <KernelSettings info={kernelInfo} active={running}
        check={() => native<void>('validatePlan', { plan: compiled.plan })} />}
      {current === 'about' && <AboutSettings info={kernelInfo} />}
      {(current === 'dns' || current === 'tun' || current === 'inbound' || current === 'monitoring') &&
        <NetworkSettings key={current} page={current} library={library} busy={busy} sdk={kernelInfo.sdk}
          backgroundResult={backgroundResult} save={(network, monitoring) => saveConfiguration({ ...library, network, monitoring }, false)} />}
    </>
  } else {
    switch (tab) {
      case 'home':
        page = <><Header title="仪表盘" action={<PowerButton status={status} pending={powerPending} busy={busy} toggle={togglePower} />} />
          <Home status={status} pending={powerPending} library={library} model={model} choice={choice} exit={exitInfo} rows={history} busy={busy}
            detect={detect} mode={mode => change({ ...library, mode })} select={() => choice?.type === 'chain' ? setDialog({ kind: 'chain' }) : go('nodes')}
            connections={() => go('connections')}
            importSub={importSub} toggle={togglePower} /></>
        break
      case 'subscriptions':
        page = <><Header title="订阅" action={(library.sources.length > 0 || pendingImports.length > 0) && <Button variant="default" onClick={importSub}><CloudDownload data-icon="inline-start" />导入订阅</Button>} />
          <Subscriptions sources={sortedSources} pendingImports={pendingImports} model={model} library={library} busy={busy} refreshing={refreshing}
            toggle={id => change({ ...library, sourceFilter: id === '*' ?
              (library.sourceFilter.length === library.sources.length ? [] : library.sources.map(source => source.id)) :
              (library.sourceFilter.includes(id) ? library.sourceFilter.filter(source => source !== id) : [...library.sourceFilter, id]) }, false)}
            refresh={source => refresh([source])} all={() => refresh(library.sources)} edit={source => setDialog({ kind: 'source', id: source.id })}
            detail={() => { setSearch(''); setSourceFilter(''); setScreen({ kind: 'content' }) }} importSub={importSub} /></>
        break
      case 'nodes':
        page = <><Header title="节点库" action={<Button variant="default" onClick={() => setDialog({ kind: 'node' })}><Plus />添加节点</Button>} />{nodePage(model.nodes)}</>
        break
      case 'connections':
        page = <><Header title="连接日志" action={<Button variant="default" disabled={busy} onClick={() => {
          const chain = library.chains.find(chain => choice?.type === 'chain' && choice.id === chain.id) ?? library.chains.find(chain => compiled.byId.has(chain.id))
          if (chain) void task(() => measureChain(chain))
          else setDialog({ kind: 'chain' })
        }}><RefreshCw data-icon="inline-start" className={probing.length ? 'motion-safe:animate-spin' : undefined} />测整链</Button>} />
          <Connections running={running} rows={history} exit={exitInfo} labels={compiled.labels} busy={busy} measurement={chainMeasurement}
            diagnose={detect} close={id => void task(async () => { await native('closeConnection', { id }) })} /></>
        break
      case 'settings':
        page = <><Header title="设置" /><SettingsIndex library={library} open={kind => setScreen({ kind })} /></>
        break
    }
  }

  let sheet: ReactNode
  let sheetTitle = ''
  if (dialog?.kind === 'node') {
    const node = dialog.node
    sheetTitle = node ? '编辑节点' : '添加自定义节点'
    sheet = <NodeEditor node={node} busy={busy} save={saveNode} test={draft => void task(() => measure([draft.id], nextNode(draft), false))}
      reset={node && library.edits[node.id] ? () => void task(async () => {
        const edits = { ...library.edits }; delete edits[node.id]
        await save({ ...library, edits }); setDialog(undefined); notice('已恢复订阅值')
      }) : undefined}
      remove={node ? () => confirm('删除节点「' + node.config.name + '」', () => void task(async () => {
        await removeNode(node); setDialog(undefined); notice('节点已删除')
      })) : undefined} />
  } else if (dialog?.kind === 'group') {
    const group = dialog.group
    sheetTitle = group ? (group.sourceId ? group.name : '编辑分组') : '新建分组'
    sheet = <GroupEditor group={group} library={library} model={model} busy={busy}
      save={next => void task(async () => {
        await save({ ...library, groups: [...library.groups.filter(old => old.id !== next.id), next] })
        setDialog(undefined); notice('分组已保存')
      })}
      choose={group ? () => choose({ type: 'group', id: group.id }) : undefined}
      remove={group && !group.sourceId ? () => confirm('删除分组「' + group.name + '」', () => void task(async () => {
        await save({ ...library, groups: library.groups.filter(old => old.id !== group.id) }); setDialog(undefined); notice('分组已删除')
      })) : undefined} />
  } else if (dialog?.kind === 'chain') {
    sheetTitle = '链路'
    sheet = <ChainEditor library={library} model={model} busy={busy}
      save={chain => void task(async () => { await save(chainLibrary(chain)); notice('链路已保存') })}
      use={chain => choose({ type: 'chain', id: chain.id })}
      remove={chain => confirm('删除链路「' + chain.name + '」', () => void task(async () => {
        await save({ ...library, chains: library.chains.filter(c => c.id !== chain.id) }); setDialog(undefined); notice('链路已删除')
      }))}
      test={chain => void task(() => measureChain(chain))} />
  } else if (dialog?.kind === 'join') {
    const groups = library.groups.filter(group => !group.automatic)
    sheetTitle = '加入分组'
    sheet = <div className="sheet-form">
      {!groups.length && <Empty icon={Network} title="暂无手动分组"><Button onClick={() => setDialog({ kind: 'group' })}>新建分组</Button></Empty>}
      {groups.map(group => <button key={group.id} type="button" className="pick-row" disabled={busy} onClick={() => void task(async () => {
        await save({ ...library, groups: library.groups.map(old => old.id === group.id ? { ...old, members: [...new Set([...old.members, ...checked])] } : old) })
        setDialog(undefined); setChecked([]); notice('节点已加入 ' + group.name)
      })}><Network size={16} /><span>{group.name}</span><Tag>{group.members.length} 个成员</Tag></button>)}
    </div>
  } else if (dialog?.kind === 'source') {
    const source = library.sources.find(source => source.id === dialog.id)
    sheetTitle = source?.name ?? '订阅管理'
    if (source) sheet = <div className="sheet-form">
      <div className="panel settings-panel">
        <Row icon={CloudDownload} title="编辑订阅" onClick={() => { setDialog(undefined); setScreen({ kind: 'import', id: source.id }) }} />
        <Row icon={FileCode2} title="编辑 YAML" onClick={() => { setDialog(undefined); setScreen({ kind: 'yaml', id: source.id }) }} />
        <Row icon={Puzzle} title="扩展" onClick={() => {
          setDialog(undefined)
          setTool({ name: source.name, data: { kind: 'extension', extension: source.extension ?? emptyExtension,
            save: extension => updateSource(source.id, JSON.stringify(source.extension ?? emptyExtension) === JSON.stringify(extension) ? {} : { extension, autoUpdate: false }, running) } })
        }} />
        {source.url && <Row icon={CalendarClock} title={source.autoUpdate === false ? '自动更新（已暂停）' : '自动更新'} onClick={() => {
          setDialog(undefined)
          setTool({ name: source.name, data: { kind: 'policy', enabled: source.autoUpdate !== false, hours: source.customHours,
            provider: source.intervalHours, save: (autoUpdate, customHours) => updateSource(source.id, { autoUpdate, customHours }, false) } })
        }} />}
        {source.url && <Row icon={RefreshCw} title="同步" onClick={() => { setDialog(undefined); refresh([source]) }} />}
        <details><summary className="flex cursor-pointer items-center gap-3 p-3 text-sm"><ChevronDown size={17} />更多</summary>
          <Row icon={Eye} title="运行时配置" onClick={() => void task(async () => {
            const usesSource = library.routing.subscriptionId === source.id ||
              (choice?.type === 'node' && model.nodes.some(n => n.id === choice.id && n.sourceId === source.id)) ||
              (choice?.type === 'group' && model.groups.some(g => g.id === choice.id && membersOf(g, model, library).some(n => n.sourceId === source.id))) ||
              (choice?.type === 'chain' && library.chains.find(c => c.id === choice.id)?.hops.some(hop => model.nodes.some(n => n.id === hop && n.sourceId === source.id)))
            const active = running && usesSource ? await native<object | null>('runtimeConfig') : null
            setDialog(undefined)
            setTool({ name: source.name, data: { kind: 'runtime', yaml: active ? '# 当前运行配置\n' + stringify(active) :
              '# 按当前设置生成的订阅预览\n' + effectiveYaml(library, source.id) } })
          })} />
          {source.url && <>
            <Row icon={copied === source.id ? Check : Copy} title={copied === source.id ? '复制成功' : '复制链接'}
              onClick={() => void task(() => copy(source.id, source.url!))} />
            <Row icon={QrCode} title="二维码" onClick={() => {
              setDialog(undefined); setTool({ name: source.name, data: { kind: 'qr', url: source.url! } })
            }} />
          </>}
          <Row icon={Download} title="导出文件" onClick={() => void task(async () => {
            const text = source.extendedYaml ?? source.yaml
            const name = source.name.replace(/[<>:"/\\|?*]/g, '_').replace(/\.ya?ml$/i, '') + '.yaml'
            if (onAndroid) {
              if (await native('export', { name, text })) notice('订阅已导出')
            } else downloadSubscription(name, text)
          })} />
          {sortedSources[0]?.id !== source.id && <Row icon={ArrowUp} title="上移订阅" onClick={() => { moveSource(source.id, -1); setDialog(undefined) }} />}
          {sortedSources.at(-1)?.id !== source.id && <Row icon={ArrowDown} title="下移订阅" onClick={() => { moveSource(source.id, 1); setDialog(undefined) }} />}
        </details>
        <Row icon={Trash2} title="删除订阅" onClick={() => setDialog({ kind: 'deleteSource', id: source.id })} />
      </div>
    </div>
  } else if (dialog?.kind === 'deleteSource') {
    const source = library.sources.find(source => source.id === dialog.id)
    sheetTitle = '删除订阅'
    if (source) {
      const stopsProxy = running && library.mode !== 'direct' && model.nodes.length > 0 &&
        model.nodes.every(node => node.sourceId === source.id)
      sheet = <div className="sheet-form">
        <p>删除「{source.name}」及其节点和分组？失效的分流出口会改为「拒绝连接」。{stopsProxy && '删除后将自动停止代理。'}</p>
        <div className="sheet-actions justify-end">
          <Button variant="outline" onClick={() => setDialog(undefined)}>取消</Button>
          <Button variant="destructive" disabled={busy} onClick={() => void task(() => removeSource(source.id))}>确认删除</Button>
        </div>
      </div>
    }
  } else if (dialog?.kind === 'delete') {
    sheetTitle = '确认操作'
    sheet = <div className="sheet-form"><p>{dialog.label}</p><div className="sheet-actions justify-end">
      <Button variant="outline" onClick={() => setDialog(undefined)}>取消</Button><Button variant="destructive" disabled={busy} onClick={dialog.apply}>确认</Button>
    </div></div>
  }

  return <MotionConfig reducedMotion="user"><div className="mobile-shell">
    {loaded && (
      <>
        {page}
        {tool && <SubscriptionTool data={tool.data} name={tool.name} close={() => setTool(undefined)} />}
        <BottomNavigation page={tab} onChange={go} />
        <Sheet open={Boolean(dialog && sheet)} title={sheetTitle} close={() => setDialog(undefined)}>{sheet}</Sheet>
      </>
    )}
    <AnimatePresence>
      {!loaded && (
        <motion.div
          key="air-splash"
          className="air-splash"
          initial={{ opacity: 1 }}
          exit={{ opacity: 0, scale: 1.03, transition: { duration: 0.22, ease: 'easeOut' } }}
        >
          <div className="air-splash-mark">
            <div className="air-splash-glow" aria-hidden="true" />
            <img src={airLogo} alt="Air" className="air-splash-logo" draggable={false} />
          </div>
          <strong className="air-splash-title">Air</strong>
          {loadError ? (
            <div className="air-splash-error">
              <p role="alert">{loadError}</p>
              <Button onClick={() => location.reload()}>重新加载</Button>
            </div>
          ) : (
            <div className="air-splash-bar" aria-label="正在启动" role="status" />
          )}
        </motion.div>
      )}
    </AnimatePresence>
    <MessageViewport mobile />
  </div></MotionConfig>
}
