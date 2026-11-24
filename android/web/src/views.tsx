import { preferences } from '@/shared/lib/preferences'
import { diagnostic, tr } from '@/shared/i18n/messages'
import { formatDateTime } from '@/shared/lib/utils'
import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion, useMotionValueEvent, useReducedMotion, useTransform, type MotionValue } from 'motion/react'
import { Activity, ArrowDown, ArrowUp, Bookmark, Check, CheckSquare, ChevronDown, ChevronLeft, ChevronRight, CloudDownload, Copy, Folder, FolderOpen, Globe2, Grid2X2, Layers, List, ListFilter, Loader2, Network, Pencil, Pin, Plus, RefreshCw, Search, Server, Trash2, Waypoints, X, Zap } from 'lucide-react'
import { Segmented } from '@/shared/ui/segmented'
import { proxyModes } from '@/shared/proxy/modes'
import { NodeLatencyButton } from '@/shared/ui/NodeLatencyButton'
import { ConnectionApp } from '@/shared/ui/ConnectionApp'
import { ProxyPowerButton } from '@/shared/ui/ProxyPowerButton'
import { DashboardPowerButton } from '@/shared/ui/DashboardPowerButton'
import { SpinningGlobeIcon } from '@/shared/ui/SpinningGlobeIcon'
import { idleHeights, TrafficBars, trafficHeights } from '@/shared/ui/TrafficBars'
import { Button } from '@/shared/ui/button'
import { bytes, membersOf, protocol, selectionName, stats, usage, type Choice, type Connection, type ExitInfo, type Group, type Library, type Mode, type Node, type Subscription, type VpnStatus, type readLibrary } from './model'
import { Empty, Tag } from './ui'

export const policyLabels = { get select() { return tr('手动选择') }, get 'url-test'() { return tr('自动择优') }, get fallback() { return tr('故障转移') }, get 'load-balance'() { return tr('负载均衡') } }
const exitKinds = {
  datacenter: { get label() { return tr('机房') }, tone: 'blue' as const },
  residential: { get label() { return tr('住宅') }, tone: 'green' as const },
  mobile: { get label() { return tr('移动网络') }, tone: 'amber' as const },
  gateway: { get label() { return tr('网关') }, tone: 'gray' as const },
}
const exitQuality = {
  noEvidence: { get label() { return tr('未见风险') }, tone: 'gray' as const },
  lowRisk: { get label() { return tr('低风险') }, tone: 'green' as const },
  mediumRisk: { get label() { return tr('中风险') }, tone: 'amber' as const },
  highRisk: { get label() { return tr('高风险') }, tone: 'red' as const },
}
export type Model = ReturnType<typeof readLibrary>
export type ChainMeasurement = { name: string; hops: string[]; delay: number }

export function formatSpeed(rate?: number) {
  if (!rate || rate < 1) return '0 B/s'
  return bytes(rate < 1024 ? Math.round(rate) : rate) + '/s'
}

export function connectionRoute(c: Connection, labels: Record<string, string>) {
  const leaf = c.chains?.[0] ?? ''
  const upper = leaf.toUpperCase()
  if (upper === 'DIRECT') {
    return { kind: 'direct' as const, label: tr('直连'), shortLabel: tr('直连'), exitName: tr('直连'), tone: 'green' as const, fullLabel: tr('直连') }
  }
  if (upper === 'REJECT' || upper === 'REJECT-DROP') {
    return { kind: 'reject' as const, label: tr('拒绝'), shortLabel: tr('拒绝'), exitName: tr('拒绝'), tone: 'red' as const, fullLabel: tr('拒绝') }
  }
  if (!leaf) {
    return { kind: 'direct' as const, label: tr('未知'), shortLabel: tr('未知'), exitName: tr('未知'), tone: 'gray' as const, fullLabel: tr('未知出站') }
  }
  const exitName = labels[leaf] ?? leaf
  return { kind: 'proxy' as const, label: exitName, shortLabel: tr('代理'), exitName, tone: 'blue' as const, fullLabel: exitName }
}

export function PowerButton({ status, pending, busy, toggle }: {
  status: VpnStatus; pending?: 'start' | 'stop'; busy: boolean; toggle: () => void
}) {
  const phase = pending === 'start' ? 'starting' : pending === 'stop' ? 'stopping' : status.phase === 'error' ? 'idle' : status.phase
  const active = phase === 'running' || phase === 'stopping'
  return <ProxyPowerButton
      mobile
      phase={phase}
      tone={active ? 'tun' : 'stopped'}
      traffic={{ uploadRate: status.traffic.up ?? 0, downloadRate: status.traffic.down ?? 0 }}
      disabled={busy}
      onToggle={toggle}
  />
}

export function HomeHeaderPower({
  progress,
  widthMv,
  status,
  pending,
  busy,
  toggle,
}: {
  progress: MotionValue<number>
  widthMv: MotionValue<number>
  status: VpnStatus
  pending?: 'start' | 'stop'
  busy: boolean
  toggle: () => void
}) {
  const reducedMotion = useReducedMotion()
  const [interactive, setInteractive] = useState(() => progress.get() >= 0.45)

  useMotionValueEvent(progress, 'change', value => {
    const next = value >= 0.45
    setInteractive(prev => (prev === next ? prev : next))
  })

  const opacity = useTransform(progress, [0, 0.14, 0.5, 0.86, 1], [0, 0.14, 0.5, 0.9, 1])
  const y = useTransform(progress, [0, 1], [reducedMotion ? 0 : 16, 0])
  const scale = useTransform(progress, [0, 0.5, 1], [reducedMotion ? 1 : 0.84, reducedMotion ? 1 : 0.94, 1])
  const clipPath = useTransform([progress, widthMv], ([p, w]: number[]) => {
    const hClip = Math.max(0, ((w - 36) / 2) * (1 - p))
    const radius = 18 - 11 * p
    return `inset(0px ${hClip.toFixed(2)}px 0px ${hClip.toFixed(2)}px round ${radius.toFixed(2)}px)`
  })
  const x = useTransform([progress, widthMv], ([p, w]: number[]) =>
    reducedMotion ? 0 : Math.max(0, ((w - 36) / 2) * (1 - p)),
  )

  return (
    <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center">
      <motion.div
        aria-hidden={!interactive}
        style={{ opacity, x, y, scale, clipPath: reducedMotion ? undefined : clipPath }}
        className={interactive ? 'pointer-events-auto flex shrink-0 items-center' : 'pointer-events-none flex shrink-0 items-center'}
      >
        <PowerButton status={status} pending={pending} busy={busy} toggle={toggle} />
      </motion.div>
    </div>
  )
}

export function Home({ status, pending, library, model, choice, exit, exitChecking = false, exitFailed = false, rows, labels, busy, detect, mode, select, openGroups, connections, importSub, toggle, openGroup, openConnection, copyIp, headerPowerProgress }: {
  status: VpnStatus; library: Library; model: Model; choice?: Choice; exit?: ExitInfo; exitChecking?: boolean; exitFailed?: boolean; busy: boolean
  pending?: 'start' | 'stop'; rows: Connection[]; labels: Record<string, string>
  detect: () => void; mode: (mode: Mode) => void; select: () => void; openGroups: () => void; connections: () => void
  importSub: () => void; toggle: () => void; openGroup: (group: Group) => void
  openConnection: (conn: Connection) => void; copyIp: (ip: string) => Promise<boolean> | void
  headerPowerProgress?: MotionValue<number>
}) {
  const running = status.phase === 'running'
  const chosen = selectionName(choice, model, library)
  const chain = library.chains.find(chain => choice?.type === 'chain' && chain.id === choice.id)
  const node = model.nodes.find(node => choice?.type === 'node' && node.id === choice.id)
  const group = model.groups.find(group => choice?.type === 'group' && group.id === choice.id)
  const source = library.sources.find(s => s.id === (node?.sourceId ?? group?.sourceId))
  const waveformPending = pending ?? (status.phase === 'starting' ? 'start' : status.phase === 'stopping' ? 'stop' : undefined)
  const [samples, setSamples] = useState<{ session: number; up: number[]; down: number[] }>({ session: 0, up: [], down: [] })
  const [copiedIp, setCopiedIp] = useState(false)
  const copiedTimerRef = useRef<number | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const connListRef = useRef<HTMLDivElement>(null)
  const powerAnchorRef = useRef<HTMLDivElement>(null)
  const interactiveRef = useRef(true)
  const [cardInteractive, setCardInteractive] = useState(true)

  useEffect(() => () => {
    if (copiedTimerRef.current !== null) window.clearTimeout(copiedTimerRef.current)
  }, [])

  useEffect(() => {
    setCopiedIp(false)
  }, [exit?.ip])

  async function handleCopyIp(ip: string) {
    const ok = await Promise.resolve(copyIp(ip))
    if (ok === false) return
    setCopiedIp(true)
    if (copiedTimerRef.current !== null) window.clearTimeout(copiedTimerRef.current)
    copiedTimerRef.current = window.setTimeout(() => {
      copiedTimerRef.current = null
      setCopiedIp(false)
    }, 1500)
  }

  useEffect(() => {
    const container = scrollRef.current
    const anchor = powerAnchorRef.current
    if (!container || !anchor) return

    const sync = () => {
      const cRect = container.getBoundingClientRect()
      const bRect = anchor.getBoundingClientRect()
      const startY = cRect.top + 14
      const span = Math.max(48, bRect.height + 6)
      const next = Math.min(1, Math.max(0, (startY - bRect.top) / span))
      headerPowerProgress?.set(next)
      const interactive = next <= 0.65
      if (interactive !== interactiveRef.current) {
        interactiveRef.current = interactive
        setCardInteractive(interactive)
      }
    }

    sync()
    container.addEventListener('scroll', sync, { passive: true })
    const observer = new ResizeObserver(sync)
    observer.observe(container)
    observer.observe(anchor)
    return () => {
      container.removeEventListener('scroll', sync)
      observer.disconnect()
      headerPowerProgress?.set(0)
      interactiveRef.current = true
    }
  }, [headerPowerProgress])

  useEffect(() => {
    if (status.phase !== 'running') return
    setSamples(previous => ({
      session: status.startedAt,
      up: [...(previous.session === status.startedAt ? previous.up.slice(-16) : []), status.traffic.up ?? 0],
      down: [...(previous.session === status.startedAt ? previous.down.slice(-16) : []), status.traffic.down ?? 0],
    }))
  }, [status])
  const flag = exit?.country && /^[A-Z]{2}$/.test(exit.country)
    ? [...exit.country].map(c => String.fromCodePoint(127397 + c.charCodeAt(0))).join('') : ''
  const exitKindInfo = exit?.kind ? exitKinds[exit.kind] : undefined
  const exitQualityInfo = exit?.quality ? exitQuality[exit.quality] : undefined
  const activeCount = rows.filter(row => !row.closed).length
  const liveConnections = rows
    .filter(row => !row.closed)
    .sort((a, b) => {
      const rateDiff = ((b.downRate ?? 0) + (b.upRate ?? 0)) - ((a.downRate ?? 0) + (a.upRate ?? 0))
      return rateDiff !== 0 ? rateDiff : (b.download + b.upload) - (a.download + a.upload)
    })
  const hasLiveConnections = liveConnections.length > 0

  useEffect(() => {
    const list = connListRef.current
    const page = scrollRef.current
    if (!list || !page) return

    const OVERSCROLL_THRESHOLD = 20
    let activeId: number | null = null
    let lastY = 0
    let lastTime = 0
    let overscrollAccum = 0
    let overscrollDir: -1 | 0 | 1 = 0
    let handedOff = false
    let nativeChained = false
    let velocity = 0
    let expectedPageScroll = page.scrollTop
    let rafId = 0

    const stopMomentum = () => {
      if (rafId) {
        cancelAnimationFrame(rafId)
        rafId = 0
      }
    }

    const startMomentum = (initialVelocity: number) => {
      stopMomentum()
      let v = initialVelocity
      let prevTime = performance.now()
      const step = (now: number) => {
        const dt = Math.min(32, Math.max(1, now - prevTime))
        prevTime = now
        const before = page.scrollTop
        page.scrollTop = before + v * dt
        v *= Math.pow(0.92, dt / 16)
        if (Math.abs(v) < 0.04 || Math.abs(page.scrollTop - before) < 0.1) {
          rafId = 0
          return
        }
        rafId = requestAnimationFrame(step)
      }
      rafId = requestAnimationFrame(step)
    }

    const onTouchStart = (event: TouchEvent) => {
      stopMomentum()
      if (event.touches.length !== 1) {
        activeId = null
        return
      }
      const touch = event.touches[0]
      activeId = touch.identifier
      lastY = touch.clientY
      lastTime = performance.now()
      overscrollAccum = 0
      overscrollDir = 0
      handedOff = false
      nativeChained = false
      velocity = 0
      expectedPageScroll = page.scrollTop
    }

    const onTouchMove = (event: TouchEvent) => {
      if (nativeChained || activeId === null || event.touches.length !== 1) return
      let touch: Touch | undefined
      for (let i = 0; i < event.touches.length; i++) {
        if (event.touches[i].identifier === activeId) {
          touch = event.touches[i]
          break
        }
      }
      if (!touch) return

      if (Math.abs(page.scrollTop - expectedPageScroll) > 1.5) {
        nativeChained = true
        return
      }
      if (list.scrollHeight <= list.clientHeight + 1) return

      const now = performance.now()
      const dy = lastY - touch.clientY
      const dt = Math.max(1, now - lastTime)
      lastY = touch.clientY
      lastTime = now
      if (dy === 0) return

      const atTop = list.scrollTop <= 0.5
      const atBottom = list.scrollTop + list.clientHeight >= list.scrollHeight - 0.5
      const hittingEdge = (dy < 0 && atTop) || (dy > 0 && atBottom)
      const dir: -1 | 1 = dy > 0 ? 1 : -1

      if (hittingEdge) {
        if (overscrollDir !== dir) {
          overscrollAccum = 0
          overscrollDir = dir
          handedOff = false
          velocity = 0
        }
        overscrollAccum += Math.abs(dy)
        if (!handedOff && overscrollAccum >= OVERSCROLL_THRESHOLD) {
          handedOff = true
        }
        if (handedOff) {
          const before = page.scrollTop
          page.scrollTop = before + dy
          expectedPageScroll = page.scrollTop
          const instV = dy / dt
          velocity = velocity === 0 ? instV : velocity * 0.45 + instV * 0.55
        }
      } else {
        overscrollAccum = 0
        overscrollDir = 0
        handedOff = false
        velocity = 0
        expectedPageScroll = page.scrollTop
      }
    }

    const finishTouch = () => {
      if (activeId === null) return
      const shouldFling = handedOff && !nativeChained && Math.abs(velocity) >= 0.12 && performance.now() - lastTime <= 80
      const flingVelocity = velocity
      activeId = null
      overscrollAccum = 0
      overscrollDir = 0
      handedOff = false
      nativeChained = false
      velocity = 0
      if (shouldFling) startMomentum(flingVelocity)
    }

    list.addEventListener('touchstart', onTouchStart, { passive: true })
    list.addEventListener('touchmove', onTouchMove, { passive: true })
    list.addEventListener('touchend', finishTouch, { passive: true })
    list.addEventListener('touchcancel', finishTouch, { passive: true })
    page.addEventListener('touchstart', stopMomentum, { passive: true })
    page.addEventListener('wheel', stopMomentum, { passive: true })

    return () => {
      stopMomentum()
      list.removeEventListener('touchstart', onTouchStart)
      list.removeEventListener('touchmove', onTouchMove)
      list.removeEventListener('touchend', finishTouch)
      list.removeEventListener('touchcancel', finishTouch)
      page.removeEventListener('touchstart', stopMomentum)
      page.removeEventListener('wheel', stopMomentum)
    }
  }, [hasLiveConnections])

  return <div ref={scrollRef} className="page-scroll home">
    <section className="panel dashboard-node">
      <div className="dashboard-node-body">
        <div className="dashboard-node-head">
          <Globe2 size={15} className="shrink-0 text-primary" />
          <h2>{node ? tr('当前节点') : group ? tr('自动分组') : chain ? tr('链路出口') : running && library.mode === 'direct' ? tr('直连出口') : tr('当前节点')}</h2>
          {(source || node || group || chain) && (
            <div className="flex min-w-0 flex-wrap items-center gap-1">
              {source && <Tag tone="gray" className="tag-truncate exit-chip">{source.name}</Tag>}
              {node && <Tag tone="gray" className="mono exit-chip">{protocol(node)}</Tag>}
              {group && <Tag tone="gray" className="exit-chip">{policyLabels[group.type]}</Tag>}
              {chain && <Tag tone="gray" className="exit-chip">{chain.hops.length}{tr(" 跳链路")}</Tag>}
            </div>
          )}
        </div>
        <button className="dashboard-node-pick" type="button" onClick={chosen ? select : importSub}>
          <span className="truncate">{chosen ?? (running && library.mode === 'direct' ? tr('直连模式') : tr('导入订阅'))}</span>
          <ChevronRight size={15} className="shrink-0 text-muted-foreground" />
        </button>
        <div className="dashboard-exit-row">
          <button
            className="dashboard-exit-flag"
            type="button"
            aria-label={tr('重新检测出口 IP')}
            aria-busy={exitChecking || undefined}
            title={tr('重新检测出口 IP')}
            disabled={!running || exitChecking}
            onClick={detect}
          >
            {exitChecking ? (
              <SpinningGlobeIcon spinning className="size-[15px] text-primary" />
            ) : flag ? (
              <span aria-hidden="true">{flag}</span>
            ) : (
              <SpinningGlobeIcon className="size-[15px] text-muted-foreground" />
            )}
          </button>
          {exit?.ip ? (
            <>
              <button
                type="button"
                className="dashboard-exit-ip"
                aria-label={tr("复制出口 IP · {0}", exit.ip)}
                title={tr("复制出口 IP · {0}", exit.ip)}
                onClick={() => void handleCopyIp(exit.ip)}
              >
                <span className="mono truncate">{exit.ip}</span>
                {copiedIp ? (
                  <Check size={13} className="shrink-0 text-success" aria-hidden="true" />
                ) : (
                  <Copy size={13} className="shrink-0 text-muted-foreground" aria-hidden="true" />
                )}
              </button>
              {running && (
                <button
                  type="button"
                  className="dashboard-exit-refresh"
                  aria-label={tr("刷新出口 IP")}
                  title={tr("刷新出口 IP")}
                  disabled={exitChecking}
                  onClick={detect}
                >
                  <RefreshCw size={12} className={exitChecking ? 'motion-safe:animate-spin text-primary' : undefined} aria-hidden="true" />
                </button>
              )}
              {exitKindInfo && <Tag tone={exitKindInfo.tone}>{exitKindInfo.label}</Tag>}
              {exitQualityInfo && (
                <Tag tone={exitQualityInfo.tone} className={exitQualityInfo.tone === 'gray' ? 'exit-quality-outline' : undefined}>
                  {exitQualityInfo.label}
                </Tag>
              )}
            </>
          ) : (
            <>
              <span className="min-w-0 truncate text-xs text-muted-foreground">
                {tr("出口 IP · ")}{running ? (exitChecking ? tr('正在检测…') : exitFailed ? tr('暂时无法检测') : tr('正在检测…')) : tr('启动后检测')}
              </span>
              {running && (
                <button
                  type="button"
                  className="dashboard-exit-refresh"
                  aria-label={tr("刷新出口 IP")}
                  title={tr("刷新出口 IP")}
                  disabled={exitChecking}
                  onClick={detect}
                >
                  <RefreshCw size={12} className={exitChecking ? 'motion-safe:animate-spin text-primary' : undefined} aria-hidden="true" />
                </button>
              )}
            </>
          )}
        </div>
      </div>
      <div
        ref={powerAnchorRef}
        aria-hidden={!cardInteractive}
        className={cardInteractive ? 'shrink-0' : 'pointer-events-none shrink-0'}
      >
        <DashboardPowerButton status={{ running, tun: running, systemProxy: false }} pending={waveformPending}
          morphProgress={headerPowerProgress}
          telemetry={running ? { uploadRate: status.traffic.up ?? 0, downloadRate: status.traffic.down ?? 0 } : undefined}
          disabled={busy} onToggle={toggle} />
      </div>
    </section>
    <div className="grid grid-cols-2 gap-2">{([
      { label: tr('上传'), icon: ArrowUp, direction: 'up' }, { label: tr('下载'), icon: ArrowDown, direction: 'down' },
    ] as const).map(({ label, icon: Icon, direction }) => {
      const history = samples.session === status.startedAt ? samples[direction] : []
      const total = status.totals?.[direction]
      const peakValue = history.length ? bytes(Math.max(...history)) + '/s' : '—'
      const totalValue = total === undefined ? '—' : bytes(total)
      return <div className="panel rate" key={direction}>
        <span><Icon size={16} />{label}</span>
        <strong>{running ? formatSpeed(status.traffic[direction] ?? 0) : '—'}</strong>
        <div className="rate-meta">
          <div className="rate-meta-row"><span>{tr("峰值")}</span><b>{peakValue}</b></div>
          <div className="rate-meta-row"><span>{tr("累计")}</span><b>{totalValue}</b></div>
        </div>
        <TrafficBars running={running} heights={history.length ? trafficHeights(history) : idleHeights} />
      </div>
    })}</div>
    <section className="panel mode-card">
      <strong>{tr("出站模式")}</strong>
      <Segmented layoutId="android-proxy-mode" ariaLabel={tr("出站模式")} size="md" fullWidth
        options={proxyModes} value={library.mode} onChange={mode} disabled={busy} />
    </section>
    <section className="panel diagnostic">
      <div className="section-title"><strong>{tr("实时连接")}<Tag>{activeCount}</Tag></strong>
        <Button size="sm" variant="outline" onClick={connections}>{tr("查看连接")}<ChevronRight data-icon="inline-end" /></Button>
      </div>
      {liveConnections.length > 0 ? (
        <div ref={connListRef} className="home-conn-list">
          {liveConnections.map(row => {
            const route = connectionRoute(row, labels)
            const dl = row.downRate ?? 0
            const ul = row.upRate ?? 0
            const activeSpeed = dl >= 1 || ul >= 1
            return <button type="button" key={row.id} className="home-conn" onClick={() => openConnection(row)}>
              <div className="home-conn-inner">
                <div className="home-conn-top">
                  <div className="home-conn-app">
                    <ConnectionApp name={row.appName || row.metadata.process || tr('未知应用')} icon={row.appIcon} />
                  </div>
                  <div className="home-conn-route">
                    <Tag tone={route.tone}>{route.label}</Tag>
                  </div>
                </div>
                <div className="home-conn-bottom">
                  <span className="home-conn-host">{row.metadata.host || row.metadata.destinationIP || tr('未知目标')}</span>
                  <span className="home-conn-speed">
                    {activeSpeed ? (
                      <>
                        {dl >= 1 && <span className="home-conn-dl"><ArrowDown size={11} aria-hidden="true" />{formatSpeed(dl)}</span>}
                        {ul >= 1 && <span className="home-conn-ul"><ArrowUp size={11} aria-hidden="true" />{formatSpeed(ul)}</span>}
                      </>
                    ) : (
                      <span className="home-conn-idle">0 B/s</span>
                    )}
                  </span>
                </div>
              </div>
            </button>
          })}
        </div>
      ) : <p className="fine-print">{running ? tr('等待应用发起连接') : tr('启动代理后将显示实时连接')}</p>}
    </section>
    {model.groups.length > 0 && <section className="panel diagnostic">
      <div className="section-title"><strong>{tr("分组")}<Tag>{model.groups.length}</Tag></strong>
        <Button size="sm" variant="outline" onClick={openGroups}>{tr("查看分组")}<ChevronRight data-icon="inline-end" /></Button>
      </div>
      <div className="min-w-0">
        {model.groups.slice(0, 3).map(group => <button type="button" className="dashboard-connection" key={group.id} onClick={() => openGroup(group)}>
          <span className="truncate font-medium">{group.name}</span>
          <span className="flex shrink-0 items-center gap-1">
            <Tag tone="gray">{policyLabels[group.type]}</Tag>
            <ChevronRight size={14} className="text-muted-foreground" aria-hidden="true" />
          </span>
        </button>)}
      </div>
    </section>}
  </div>
}

export interface PendingImport {
  id: string
  label: string
  detail: string
}

export function Subscriptions({ model, library, sources, pendingImports, refreshing, toggle, refresh, all, edit, detail, importSub }: {
  model: Model; library: Library; sources: Subscription[]; pendingImports: PendingImport[]; toggle: (id: string) => void; refresh: (source: Subscription) => void
  refreshing: string[]; all: () => void; edit: (source: Subscription) => void; detail: () => void; importSub: () => void
}) {
  if (!sources.length && !pendingImports.length) return <main className="page-scroll"><Empty icon={CloudDownload} title={tr("暂无订阅")}
    description={tr("用 URL 链接、本地 YAML 或二维码导入")} className="min-h-56">
    <Button variant="default" className="justify-center" onClick={importSub}><CloudDownload data-icon="inline-start" />{tr("导入订阅")}</Button>
  </Empty></main>
  const count = sources.filter(s => library.sourceFilter.includes(s.id)).length
  const canRefreshAll = sources.some(s => s.url && !refreshing.includes(s.id))
  return <>
    <main className="page-scroll">
      <div className="section-title"><strong>{tr("订阅来源")}<small>{sources.length}{tr(" 个")}</small></strong><Button size="sm" variant="outline" disabled={!canRefreshAll} onClick={all}><RefreshCw data-icon="inline-start" className={refreshing.length ? 'motion-safe:animate-spin' : undefined} />{tr("刷新全部")}</Button></div>
      {sources.length > 0 && <div className="selection-summary">
        <label><input type="checkbox" checked={count === sources.length} onChange={() => toggle('*')} />{tr("全选")}</label>
        <span>{tr('已选 {0}/{1} 个 · 同步至节点库', count, sources.length)}</span>
      </div>}
      <div className="item-stack">
        {pendingImports.map(task => (
          <article key={task.id} role="status" aria-live="polite" className="panel subscription-card" data-selected="true">
            <div className="flex items-center justify-between gap-2 min-w-0">
              <div className="flex items-center gap-2 min-w-0">
                <Loader2 size={16} className="shrink-0 animate-spin text-primary" aria-hidden="true" />
                <b className="truncate">{task.label}</b>
              </div>
              <Tag tone="blue">{tr("导入中")}</Tag>
            </div>
            <div className="sub-meta">
              <small className="mono truncate">{task.detail}</small>
              <small className="shrink-0">{tr("后台加载中…")}</small>
            </div>
            <div className="air-import-bar" aria-hidden="true" />
          </article>
        ))}
        {sources.map(source => {
          const meta = usage(source)
          const expired = Boolean(meta.expire && meta.expire < Date.now())
          const checked = library.sourceFilter.includes(source.id)
          const isRefreshing = refreshing.includes(source.id)
          return <article className="panel subscription-card" data-selected={checked} data-refreshing={isRefreshing || undefined} key={source.id} onContextMenu={event => { event.preventDefault(); edit(source) }}>
            {isRefreshing && <span className="sub-card-glow" aria-hidden="true" />}
            <div className="flex min-w-0 items-start gap-3">
              <label className="source-check">
                <input type="checkbox" checked={checked} onChange={() => toggle(source.id)} />
                <span><b>{source.name}</b><small>{tr('{0} 个节点 · {1} 个分组', model.nodes.filter(n => n.sourceId === source.id).length, model.groups.filter(g => g.sourceId === source.id).length)}</small></span>
              </label>
              <Button size="icon" variant="outline" className="shrink-0" aria-label={tr('管理 ') + source.name} onClick={() => edit(source)}><ListFilter /></Button>
            </div>
            <div className="sub-meta">
              <Tag tone={isRefreshing ? 'blue' : source.refreshError || expired ? 'red' : 'green'}>
                {isRefreshing ? tr('刷新中…') : source.refreshError ? tr('刷新失败') : expired ? tr('已过期') : tr('正常')}
              </Tag>
              <small className="shrink-0">{source.url ? tr('URL 订阅') : tr('本地订阅')}</small>
            </div>
            {!isRefreshing && source.refreshError && (
              <p className="truncate text-xs text-destructive" title={diagnostic(source.refreshError)}>
                {diagnostic(source.refreshError)}
              </p>
            )}
            {meta.total > 0 && <progress max={meta.total} value={Math.min(meta.total, meta.used)} aria-label={tr("订阅流量用量")} />}
            <div className="sub-meta">
              <small className="min-w-0 flex-1 break-words">{meta.total > 0 ? bytes(meta.used) + ' / ' + bytes(meta.total) : tr('用量未提供')}{meta.expire ? ' · ' + formatDateTime(meta.expire) + tr(' 到期') : ''}</small>
              {source.url && <Button size="icon-sm" variant="outline" className="shrink-0" disabled={isRefreshing} aria-label={tr('刷新 ') + source.name} onClick={event => { event.stopPropagation(); refresh(source) }}><RefreshCw className={isRefreshing ? 'motion-safe:animate-spin' : undefined} /></Button>}
            </div>
          </article>
        })}
      </div>
    </main>
    <footer className="page-action"><Button variant="default" className="w-full" onClick={detail}><Network />{count ? tr('前往节点库（已选 {0} 个订阅）', count) : tr('前往节点库')}</Button></footer>
  </>
}

export type MobileNodeScope =
  | { kind: 'all' }
  | { kind: 'source'; sourceId: string }
  | { kind: 'group'; groupId: string }

type ResolvedNodeScope =
  | { kind: 'all' }
  | { kind: 'source'; sourceId: string; source?: Subscription }
  | { kind: 'group'; group: Group; parentSource?: Subscription }

function resolveNodeScope(
  scope: MobileNodeScope,
  sources: Subscription[],
  includeCustom: boolean,
  model: Model,
): ResolvedNodeScope {
  if (scope.kind === 'source') {
    if (scope.sourceId === 'custom') {
      return includeCustom ? { kind: 'source', sourceId: 'custom' } : { kind: 'all' }
    }
    const source = sources.find(item => item.id === scope.sourceId)
    return source ? { kind: 'source', sourceId: source.id, source } : { kind: 'all' }
  }
  if (scope.kind === 'group') {
    const group = model.groups.find(item => item.id === scope.groupId)
    if (!group) return { kind: 'all' }
    if (group.sourceId) {
      const parentSource = sources.find(item => item.id === group.sourceId)
      return parentSource ? { kind: 'group', group, parentSource } : { kind: 'all' }
    }
    return includeCustom ? { kind: 'group', group } : { kind: 'all' }
  }
  return { kind: 'all' }
}

export function NodeScopeSheet({
  nodes,
  sources,
  includeCustom,
  model,
  library,
  selected,
  scope,
  onSelect,
  onCreateGroup,
  onEditGroup,
}: {
  nodes: Node[]
  sources: Subscription[]
  includeCustom: boolean
  model: Model
  library: Library
  selected?: Choice
  scope: MobileNodeScope
  onSelect: (scope: MobileNodeScope) => void
  onCreateGroup: () => void
  onEditGroup: (group: Group) => void
}) {
  const resolved = resolveNodeScope(scope, sources, includeCustom, model)
  const initialActiveSubId =
    resolved.kind === 'source' && resolved.sourceId !== 'custom'
      ? resolved.sourceId
      : resolved.kind === 'group'
        ? resolved.group.sourceId
        : undefined
  const [collapsedSources, setCollapsedSources] = useState<Set<string>>(() => {
    try {
      const raw = preferences.getItem('air.mobile.nodeScopeCollapsed')
      if (raw !== null) {
        const saved: unknown = JSON.parse(raw)
        if (Array.isArray(saved)) {
          const next = new Set(saved.filter((item): item is string => typeof item === 'string'))
          if (initialActiveSubId) next.delete(initialActiveSubId)
          return next
        }
      }
    } catch { /* Ignore invalid saved collapsed sources. */ }
    return sources.length <= 1
      ? new Set()
      : new Set(sources.filter(item => item.id !== initialActiveSubId).map(item => item.id))
  })
  const allowedNodeIds = new Set(nodes.map(node => node.id))
  const countBySource = new Map<string, number>()
  for (const node of nodes) {
    countBySource.set(node.sourceId, (countBySource.get(node.sourceId) ?? 0) + 1)
  }
  const customCount = countBySource.get('custom') ?? 0
  const customGroups = library.groups
  const groupMemberCount = (group: Group) => membersOf(group, model, library).filter(node => allowedNodeIds.has(node.id)).length

  function toggleSourceExpand(sourceId: string) {
    setCollapsedSources(previous => {
      const next = new Set(previous)
      if (!next.delete(sourceId)) next.add(sourceId)
      preferences.setItem('air.mobile.nodeScopeCollapsed', JSON.stringify([...next]))
      return next
    })
  }

  return (
    <div className="sheet-form scope-sheet">
      <div className="scope-tree-row" data-selected={resolved.kind === 'all' || undefined}>
        <button
          type="button"
          className="scope-tree-btn"
          onClick={() => onSelect({ kind: 'all' })}
        >
          <Network size={16} />
          <span className="min-w-0 flex-1 truncate">{tr("全部节点")}</span>
          <span className="scope-tree-count mono">{nodes.length}</span>
          {resolved.kind === 'all' && <Check size={15} className="shrink-0 text-primary" />}
        </button>
      </div>

      {sources.length > 0 && (
        <div className="scope-tree-section">
          <div className="scope-tree-label"><span>{tr("订阅来源")}</span></div>
          {sources.map(source => {
            const sourceGroups = model.groups.filter(group => group.sourceId === source.id)
            const hasChildren = sourceGroups.length > 0
            const isExpanded = hasChildren && !collapsedSources.has(source.id)
            const sourceSelected = resolved.kind === 'source' && resolved.sourceId === source.id
            const childSelected = resolved.kind === 'group' && resolved.group.sourceId === source.id
            const count = countBySource.get(source.id) ?? 0
            return (
              <div key={source.id} className="flex flex-col gap-0.5">
                <div
                  className="scope-tree-row"
                  data-selected={sourceSelected || undefined}
                  data-ancestor={!sourceSelected && childSelected ? true : undefined}
                >
                  {hasChildren ? (
                    <button
                      type="button"
                      className="scope-tree-expand"
                      aria-label={isExpanded ? tr("收起 {0}", source.name) : tr("展开 {0}", source.name)}
                      aria-expanded={isExpanded}
                      onClick={() => toggleSourceExpand(source.id)}
                    >
                      <motion.span
                        className="grid place-items-center"
                        initial={false}
                        animate={{ rotate: isExpanded ? 90 : 0 }}
                        transition={{ type: 'spring', stiffness: 460, damping: 30 }}
                      >
                        <ChevronRight size={15} />
                      </motion.span>
                    </button>
                  ) : (
                    <span className="w-[34px] shrink-0" />
                  )}
                  <button
                    type="button"
                    className="scope-tree-btn scope-tree-sub-btn"
                    data-expanded={isExpanded || undefined}
                    onClick={() => onSelect({ kind: 'source', sourceId: source.id })}
                  >
                    {isExpanded ? <FolderOpen size={16} /> : <Folder size={16} />}
                    <span className="min-w-0 flex-1 truncate">{source.name}</span>
                    <span className="scope-tree-count mono">{count}</span>
                    {sourceSelected && <Check size={15} className="shrink-0 text-primary" />}
                  </button>
                </div>

                <AnimatePresence initial={false}>
                  {hasChildren && isExpanded && (
                    <motion.div
                      initial={{ opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: 'auto' }}
                      exit={{ opacity: 0, height: 0 }}
                      transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
                      className="overflow-hidden"
                    >
                      <div className="scope-tree-children">
                        {sourceGroups.map(group => {
                          const groupSelected = resolved.kind === 'group' && resolved.group.id === group.id
                          const isOutbound = selected?.id === group.id
                          return (
                            <button
                              key={group.id}
                              type="button"
                              className="scope-tree-btn scope-tree-child-btn"
                              data-selected={groupSelected || undefined}
                              onClick={() => onSelect({ kind: 'group', groupId: group.id })}
                            >
                              <Layers size={15} />
                              <span className="min-w-0 flex-1 truncate">{group.name}</span>
                              {isOutbound && <Tag tone="green">{tr("当前出站")}</Tag>}
                              <span className="scope-tree-count mono">{groupMemberCount(group)}</span>
                              {groupSelected && <Check size={15} className="shrink-0 text-primary" />}
                            </button>
                          )
                        })}
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            )
          })}
        </div>
      )}

      {includeCustom && (
        <div className="scope-tree-section">
          <div className="scope-tree-label">
            <span>{tr("本地自定义")}</span>
            <Button type="button" variant="ghost" size="sm" onClick={onCreateGroup}>
              <Plus />{tr("新增")}
            </Button>
          </div>
          <div
            className="scope-tree-row"
            data-selected={resolved.kind === 'source' && resolved.sourceId === 'custom' ? true : undefined}
          >
            <button
              type="button"
              className="scope-tree-btn"
              onClick={() => onSelect({ kind: 'source', sourceId: 'custom' })}
            >
              <Server size={16} />
              <span className="min-w-0 flex-1 truncate">{tr("自定义节点")}</span>
              <span className="scope-tree-count mono">{customCount}</span>
              {resolved.kind === 'source' && resolved.sourceId === 'custom' && <Check size={15} className="shrink-0 text-primary" />}
            </button>
          </div>
          {customGroups.map(group => {
            const groupSelected = resolved.kind === 'group' && resolved.group.id === group.id
            const isOutbound = selected?.id === group.id
            return (
              <div
                key={group.id}
                className="scope-tree-row scope-tree-row-custom"
                data-selected={groupSelected || undefined}
              >
                <button
                  type="button"
                  className="scope-tree-btn"
                  onClick={() => onSelect({ kind: 'group', groupId: group.id })}
                >
                  <Bookmark size={16} />
                  <span className="min-w-0 flex-1 truncate">{group.name}</span>
                  {isOutbound && <Tag tone="green">{tr("当前出站")}</Tag>}
                  <span className="scope-tree-count mono">{groupMemberCount(group)}</span>
                  {groupSelected && <Check size={15} className="shrink-0 text-primary" />}
                </button>
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  aria-label={tr("编辑分组")}
                  onClick={() => onEditGroup(group)}
                >
                  <Pencil />
                </Button>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

export type MobileNodeDensity = 'compact' | 'normal' | 'detailed'

export function NodeDensitySheet({
  value,
  onSelect,
}: {
  value: MobileNodeDensity
  onSelect: (next: MobileNodeDensity) => void
}) {
  const options: { value: MobileNodeDensity; title: string; subtitle: string }[] = [
    { value: 'compact', title: tr('简洁'), subtitle: tr('一行显示 3 个节点卡片') },
    { value: 'normal', title: tr('标准'), subtitle: tr('一行显示 2 个节点卡片') },
    { value: 'detailed', title: tr('详细'), subtitle: tr('一行显示 1 个完整卡片') },
  ]
  return (
    <div className="sheet-form">
      {options.map(option => {
        const active = option.value === value
        return (
          <button
            key={option.value}
            type="button"
            className="density-option"
            data-active={active || undefined}
            onClick={() => onSelect(option.value)}
          >
            <div className="density-option-text">
              <strong>{option.title}</strong>
              <small>{option.subtitle}</small>
            </div>
            {active && <Check size={16} className="shrink-0 text-primary" />}
          </button>
        )
      })}
    </div>
  )
}

export function Nodes({
  nodes,
  sources,
  includeCustom = true,
  model,
  library,
  selected,
  busy,
  probing,
  batchProgress,
  onCancelProbe,
  checked,
  setChecked,
  choose,
  openNode,
  openGroup,
  openChain,
  openScope,
  density,
  onOpenDensity,
  view,
  probe,
  join,
  selecting: controlledSelecting,
  setSelecting: setControlledSelecting,
  hiddenSubscriptionCount = 0,
  onShowAllSubscriptions,
  onManageSubscriptions,
  scope,
  setScope,
  filters,
}: {
  nodes: Node[]
  sources: Subscription[]
  includeCustom?: boolean
  model: Model
  library: Library
  selected?: Choice
  busy: boolean
  checked: string[]
  setChecked: (ids: string[]) => void
  probing: string[]
  batchProgress?: { done: number; total: number } | null
  onCancelProbe?: () => void
  choose: (choice: Choice) => void
  openNode: (node?: Node) => void
  openGroup: (group?: Group) => void
  openChain: () => void
  openScope: () => void
  density: MobileNodeDensity
  onOpenDensity: () => void
  view: (view: Library['view']) => void
  probe: (ids: string[]) => void
  join: () => void
  selecting?: boolean
  setSelecting?: (next: boolean) => void
  hiddenSubscriptionCount?: number
  onShowAllSubscriptions?: () => void
  onManageSubscriptions?: () => void
  scope: MobileNodeScope
  setScope: (scope: MobileNodeScope) => void
  filters: {
    search: string
    setSearch: (value: string) => void
    showFilter?: boolean
    setShowFilter?: (open: boolean) => void
  }
}) {
  const [localShowFilter, setLocalShowFilter] = useState(false)
  const showFilter = filters.showFilter ?? localShowFilter
  const setShowFilter = filters.setShowFilter ?? setLocalShowFilter
  const [localSelecting, setLocalSelecting] = useState(false)
  const selecting = controlledSelecting ?? localSelecting
  const setSelecting = setControlledSelecting ?? setLocalSelecting
  const selectAllRef = useRef<HTMLInputElement>(null)
  const longPressTimerRef = useRef<number | null>(null)
  const longPressOriginRef = useRef<{ x: number; y: number } | null>(null)
  const longPressTriggeredAtRef = useRef(0)

  function clearLongPress() {
    if (longPressTimerRef.current !== null) {
      window.clearTimeout(longPressTimerRef.current)
      longPressTimerRef.current = null
    }
    longPressOriginRef.current = null
  }

  useEffect(() => clearLongPress, [])
  const resolved = resolveNodeScope(scope, sources, includeCustom, model)
  const allowedNodeIds = new Set(nodes.map(node => node.id))
  const validChecked = checked.filter(id => allowedNodeIds.has(id))
  const nodeCountBySource = new Map<string, number>()
  for (const node of nodes) {
    nodeCountBySource.set(node.sourceId, (nodeCountBySource.get(node.sourceId) ?? 0) + 1)
  }
  const customCount = nodeCountBySource.get('custom') ?? 0
  const groupNodes = (group: Group) => membersOf(group, model, library).filter(node => allowedNodeIds.has(node.id))

  const scopedNodes = resolved.kind === 'all'
    ? nodes
    : resolved.kind === 'source'
      ? nodes.filter(node => node.sourceId === resolved.sourceId)
      : groupNodes(resolved.group)

  const query = filters.search.trim().toLocaleLowerCase()
  const current = query
    ? scopedNodes.filter(n => [n.config.name, n.config.server, protocol(n)].some(value => value.toLocaleLowerCase().includes(query)))
    : scopedNodes
  const hasActiveFilter = Boolean(filters.search.trim())
  const currentIds = current.map(n => n.id)
  const allCurrentSelected = currentIds.length > 0 && currentIds.every(id => validChecked.includes(id))
  const someCurrentSelected = currentIds.some(id => validChecked.includes(id))
  useEffect(() => {
    if (selectAllRef.current) {
      selectAllRef.current.indeterminate = someCurrentSelected && !allCurrentSelected
    }
  }, [someCurrentSelected, allCurrentSelected])

  function selectScope(next: MobileNodeScope) {
    setScope(next)
    setChecked([])
  }

  function toggleAllCurrent() {
    if (allCurrentSelected) {
      const hidden = new Set(currentIds)
      setChecked(checked.filter(id => !hidden.has(id)))
    } else {
      setChecked([...new Set([...checked, ...currentIds])])
    }
  }

  const activeGroup = resolved.kind === 'group' ? resolved.group : undefined
  const activeSource = resolved.kind === 'source' ? resolved.source : undefined
  const scopeTitle = resolved.kind === 'all'
    ? tr('全部节点')
    : resolved.kind === 'source'
      ? (resolved.sourceId === 'custom' ? tr('自定义节点') : (activeSource?.name ?? tr('全部节点')))
      : resolved.group.name
  const densityLabel =
    density === 'compact' ? tr('简洁') : density === 'detailed' ? tr('详细') : tr('标准')

  const subscriptionContextId = resolved.kind === 'source' && resolved.sourceId !== 'custom'
    ? resolved.sourceId
    : resolved.kind === 'group'
      ? resolved.group.sourceId
      : undefined
  const isCustomContext = resolved.kind === 'source'
    ? resolved.sourceId === 'custom'
    : Boolean(resolved.kind === 'group' && !resolved.group.sourceId)

  const contextSubGroups = subscriptionContextId
    ? model.groups.filter(group => group.sourceId === subscriptionContextId)
    : []
  const showQuickRow =
    resolved.kind === 'all'
      ? sources.length > 0 || (includeCustom && (customCount > 0 || library.groups.length > 0))
      : subscriptionContextId
        ? contextSubGroups.length > 0
        : isCustomContext && includeCustom && library.groups.length > 0
  const isProbing = Boolean(batchProgress) || probing.length > 0

  return <>
    <main className="page-scroll">
    <section className="panel groups">
      <div className="section-title">
        <button
          type="button"
          className="scope-trigger"
          data-filtered={resolved.kind !== 'all' || undefined}
          aria-label={tr("选择订阅或分组")}
          onClick={openScope}
        >
          {resolved.kind === 'all' && <Layers size={15} className="shrink-0 text-primary" />}
          {resolved.kind === 'source' && (resolved.sourceId === 'custom'
            ? <Server size={15} className="shrink-0 text-primary" />
            : <FolderOpen size={15} className="shrink-0 text-primary" />)}
          {resolved.kind === 'group' && (resolved.group.sourceId
            ? <Layers size={15} className="shrink-0 text-primary" />
            : <Bookmark size={15} className="shrink-0 text-primary" />)}
          <span className="min-w-0 flex-1 truncate">
            {resolved.kind === 'group' && resolved.parentSource && (
              <span className="scope-trigger-prefix">{resolved.parentSource.name} / </span>
            )}
            {scopeTitle}
          </span>
          <small className="mono shrink-0">{scopedNodes.length}</small>
          <ChevronDown size={15} className="shrink-0 text-muted-foreground" />
        </button>
        <Button variant="subtle" size="sm" onClick={() => openGroup()}><Plus />{tr("新增")}</Button>
      </div>
      {showQuickRow ? (
        <div className="group-list">
          {resolved.kind === 'all' && <>
            {sources.map(source => (
              <button
                key={source.id}
                type="button"
                className="group-chip"
                onClick={() => selectScope({ kind: 'source', sourceId: source.id })}
              >
                <Folder size={15} /><b>{source.name}</b><small>{nodeCountBySource.get(source.id) ?? 0}{tr(" 个")}</small>
              </button>
            ))}
            {includeCustom && customCount > 0 && (
              <button
                type="button"
                className="group-chip"
                onClick={() => selectScope({ kind: 'source', sourceId: 'custom' })}
              >
                <Server size={15} /><b>{tr("自定义节点")}</b><small>{customCount}{tr(" 个")}</small>
              </button>
            )}
            {includeCustom && library.groups.map(group => (
              <button
                key={group.id}
                type="button"
                className="group-chip"
                onClick={() => selectScope({ kind: 'group', groupId: group.id })}
                onContextMenu={event => { event.preventDefault(); openGroup(group) }}
              >
                <Bookmark size={15} /><b>{group.name}</b><small>{groupNodes(group).length}{tr(" 个")}</small>
              </button>
            ))}
          </>}
          {subscriptionContextId && <>
            <button
              type="button"
              className="group-chip"
              data-selected={resolved.kind === 'source'}
              onClick={() => selectScope({ kind: 'source', sourceId: subscriptionContextId })}
            >
              <FolderOpen size={15} /><b>{tr("全部")}</b><small>{nodeCountBySource.get(subscriptionContextId) ?? 0}{tr(" 个")}</small>
            </button>
            {contextSubGroups.map(group => (
              <button
                key={group.id}
                type="button"
                className="group-chip"
                data-selected={resolved.kind === 'group' && resolved.group.id === group.id}
                onClick={() => selectScope({ kind: 'group', groupId: group.id })}
                onContextMenu={event => { event.preventDefault(); openGroup(group) }}
              >
                <Layers size={15} /><b>{group.name}</b><small>{groupNodes(group).length}{tr(" 个")}</small>
              </button>
            ))}
          </>}
          {isCustomContext && includeCustom && <>
            <button
              type="button"
              className="group-chip"
              data-selected={resolved.kind === 'source'}
              onClick={() => selectScope({ kind: 'source', sourceId: 'custom' })}
            >
              <Server size={15} /><b>{tr("自定义节点")}</b><small>{customCount}{tr(" 个")}</small>
            </button>
            {library.groups.map(group => (
              <button
                key={group.id}
                type="button"
                className="group-chip"
                data-selected={resolved.kind === 'group' && resolved.group.id === group.id}
                onClick={() => selectScope({ kind: 'group', groupId: group.id })}
                onContextMenu={event => { event.preventDefault(); openGroup(group) }}
              >
                <Bookmark size={15} /><b>{group.name}</b><small>{groupNodes(group).length}{tr(" 个")}</small>
              </button>
            ))}
          </>}
        </div>
      ) : resolved.kind === 'all' ? (
        <small className="text-muted-foreground">{tr("暂无分组")}</small>
      ) : null}
    </section>

    {(hiddenSubscriptionCount ?? 0) > 0 && (
      <div className="filter-summary">
        <span>{tr('已隐藏 {0} 个未勾选订阅', hiddenSubscriptionCount ?? 0)}</span>
        <div className="flex shrink-0 items-center gap-1">
          {onManageSubscriptions && (
            <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" onClick={onManageSubscriptions}>
              {tr('去调整')}
            </Button>
          )}
          {onShowAllSubscriptions && (
            <Button size="sm" variant="ghost" className="h-6 px-2 text-xs text-primary" onClick={onShowAllSubscriptions}>
              {tr('全部显示')}
            </Button>
          )}
        </div>
      </div>
    )}

    {activeGroup && (
      <div className="panel scope-group-bar">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <Tag>{policyLabels[activeGroup.type]}</Tag>
          {selected?.id === activeGroup.id && <Tag tone="green">{tr("当前出站")}</Tag>}
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          {selected?.id !== activeGroup.id && (
            <Button
              type="button"
              size="sm"
              variant="subtle"
              disabled={busy || !scopedNodes.length}
              onClick={() => choose({ type: 'group', id: activeGroup.id })}
            >
              {tr("设为出站")}
            </Button>
          )}
          {!activeGroup.sourceId && (
            <Button type="button" size="sm" variant="outline" onClick={() => openGroup(activeGroup)}>
              {tr("编辑分组")}
            </Button>
          )}
        </div>
      </div>
    )}

    <div className="section-title">
      <strong className="min-w-0"><span className="truncate">{scopeTitle}</span><small className="shrink-0">{current.length}</small></strong>
      <div className="node-section-tools">
        {batchProgress && (
          <Tag tone="blue" className="node-probe-tag">
            {`${batchProgress.done}/${batchProgress.total}`}
          </Tag>
        )}
        <div className="node-tool-group" role="group" aria-label={tr("节点常用操作")}>
          <button
            type="button"
            className="node-tool-btn"
            data-active={showFilter || hasActiveFilter || undefined}
            aria-label={tr("搜索与筛选")}
            aria-pressed={showFilter}
            onClick={() => setShowFilter(!showFilter)}
          >
            <Search size={15} />
            {!showFilter && hasActiveFilter && <span className="filter-dot" aria-hidden="true" />}
          </button>
          <span className="node-tool-sep" aria-hidden="true" />
          <button
            type="button"
            className="node-tool-btn"
            data-active={isProbing || undefined}
            disabled={busy || (!isProbing && !current.length)}
            aria-busy={isProbing || undefined}
            aria-label={
              isProbing
                ? batchProgress
                  ? tr('停止测速 ({0}/{1})', batchProgress.done, batchProgress.total)
                  : tr('停止测速')
                : tr('批量测速')
            }
            onClick={() => {
              if (isProbing) {
                onCancelProbe?.()
              } else {
                probe(validChecked.length ? validChecked : current.map(n => n.id))
              }
            }}
          >
            {isProbing ? <RefreshCw size={15} className="motion-safe:animate-spin" /> : <Zap size={15} />}
          </button>
          <span className="node-tool-sep" aria-hidden="true" />
          <button
            type="button"
            className="node-tool-btn"
            aria-label={tr("链路")}
            onClick={openChain}
          >
            <Waypoints size={15} />
          </button>
        </div>
      </div>
    </div>
    {showFilter && <div className="filter-bar">
      <input aria-label={tr("搜索节点")} placeholder={tr("搜索名称、地址或协议")} value={filters.search} onChange={e => filters.setSearch(e.target.value)} />
    </div>}
    {!showFilter && hasActiveFilter && <div className="filter-summary">
      <span>{tr("已筛选：")}{`“${filters.search.trim()}”`}</span>
      <Button size="sm" variant="ghost" className="h-6 shrink-0 px-2 text-xs text-primary" onClick={() => filters.setSearch('')}>{tr("清除筛选")}</Button>
    </div>}
    <div className="node-actions">
      <div className="node-actions-left">
        {selecting ? (
          <>
            <Button
              size="icon-sm"
              variant="subtle"
              aria-label={tr('退出多选')}
              onClick={() => { setSelecting(false); setChecked([]) }}
            >
              <X />
            </Button>
            <label className="node-select-all" title={allCurrentSelected ? tr('取消全选') : tr('全选')}>
              <input
                ref={selectAllRef}
                type="checkbox"
                checked={allCurrentSelected}
                disabled={!current.length}
                aria-label={allCurrentSelected ? tr('取消全选') : tr('全选')}
                onChange={toggleAllCurrent}
              />
            </label>
          </>
        ) : (
          <Button size="sm" variant="outline" onClick={() => { setSelecting(true); setChecked([]) }}>
            <CheckSquare data-icon="inline-start" />
            {tr('多选')}
          </Button>
        )}
      </div>
      <div className="node-actions-right">
        <Button
          size="sm"
          variant={library.view === 'cards' ? 'outline' : 'ghost'}
          className="node-density-btn"
          aria-label={tr('选择布局模式')}
          onClick={onOpenDensity}
        >
          <span>{densityLabel}</span>
          <ChevronDown size={13} />
        </Button>
        <Segmented
          ariaLabel={tr("节点视图")}
          layoutId="android-node-view"
          value={library.view}
          onChange={view}
          disabled={busy}
          options={[{ value: 'cards', label: tr('卡片'), icon: <Grid2X2 /> }, { value: 'list', label: tr('列表'), icon: <List /> }]}
        />
      </div>
    </div>
    {current.length === 0 && (
      <Empty
        icon={Network}
        title={
          nodes.length
            ? tr('没有匹配的节点')
            : (hiddenSubscriptionCount ?? 0) > 0
              ? tr('未勾选任何订阅')
              : tr('暂无节点')
        }
        description={
          !nodes.length && (hiddenSubscriptionCount ?? 0) > 0
            ? tr('请先在订阅页勾选要展示的订阅，或点击显示全部订阅')
            : undefined
        }
      >
        <div className="flex flex-wrap justify-center gap-2">
          {!nodes.length && (hiddenSubscriptionCount ?? 0) > 0 ? (
            <>
              {onShowAllSubscriptions && (
                <Button variant="default" onClick={onShowAllSubscriptions}>
                  {tr('显示全部订阅')}
                </Button>
              )}
              {onManageSubscriptions && (
                <Button variant="outline" onClick={onManageSubscriptions}>
                  {tr('去订阅页勾选')}
                </Button>
              )}
              <Button variant="outline" onClick={() => openNode()}>
                <Plus />{tr("添加自定义节点")}
              </Button>
            </>
          ) : (
            <>
              {hasActiveFilter && (
                <Button variant="outline" onClick={() => filters.setSearch('')}>{tr('清空搜索')}</Button>
              )}
              {resolved.kind !== 'all' && (
                <Button variant="outline" onClick={() => selectScope({ kind: 'all' })}>{tr('查看全部节点')}</Button>
              )}
              {!hasActiveFilter && (
                <Button variant={nodes.length ? 'subtle' : 'default'} onClick={() => openNode()}>
                  <Plus />{tr("添加自定义节点")}
                </Button>
              )}
              {(hiddenSubscriptionCount ?? 0) > 0 && onShowAllSubscriptions && (
                <Button variant="outline" onClick={onShowAllSubscriptions}>
                  {tr('显示全部订阅')}
                </Button>
              )}
            </>
          )}
        </div>
      </Empty>
    )}
    <div className="item-stack" data-view={library.view} data-density={density}>
      {current.map(node => {
        const result = stats(library.probes[node.id])
        const chosen = node.id === selected?.id
        const chosenForGroup = validChecked.includes(node.id)
        const toggleSelect = () =>
          setChecked(chosenForGroup ? validChecked.filter(id => id !== node.id) : [...validChecked, node.id])
        return <article
          key={node.id}
          className="panel node-card"
          data-selected={selecting ? chosenForGroup : chosen}
          data-selecting={selecting || undefined}
          onContextMenu={event => {
            event.preventDefault()
            if (Date.now() - longPressTriggeredAtRef.current < 650) return
            openNode(node)
          }}
          onTouchStart={event => {
            if (selecting || event.touches.length !== 1) return
            if (event.target instanceof Element && event.target.closest('.node-metrics button, input[type="checkbox"]')) return
            clearLongPress()
            const touch = event.touches[0]
            longPressOriginRef.current = { x: touch.clientX, y: touch.clientY }
            longPressTimerRef.current = window.setTimeout(() => {
              longPressTimerRef.current = null
              longPressOriginRef.current = null
              longPressTriggeredAtRef.current = Date.now()
              openNode(node)
            }, 480)
          }}
          onTouchMove={event => {
            const origin = longPressOriginRef.current
            if (!origin || event.touches.length !== 1) {
              clearLongPress()
              return
            }
            const touch = event.touches[0]
            if (Math.abs(touch.clientX - origin.x) > 10 || Math.abs(touch.clientY - origin.y) > 10) {
              clearLongPress()
            }
          }}
          onTouchEnd={clearLongPress}
          onTouchCancel={clearLongPress}
          onClick={() => {
            if (Date.now() - longPressTriggeredAtRef.current < 650) return
            if (busy) return
            if (selecting) toggleSelect()
            else choose({ type: 'node', id: node.id, groupId: activeGroup && !activeGroup.sourceId ? activeGroup.id : undefined })
          }}
        >
          <div className="node-heading">
            {selecting && (
              <input
                type="checkbox"
                aria-label={tr('选择 ') + node.config.name}
                checked={chosenForGroup}
                onClick={event => event.stopPropagation()}
                onChange={toggleSelect}
              />
            )}
            <button
              type="button"
              className="node-name"
              aria-label={(selecting ? tr('勾选或取消 ') : tr('设为当前节点 ')) + node.config.name}
              disabled={busy}
            >
              <strong>{node.config.name}</strong>
              <small className="node-source-meta truncate">{node.sourceId === 'custom' ? tr('自定义节点') : library.sources.find(s => s.id === node.sourceId)?.name}{' · '}{protocol(node)}</small>
            </button>
          </div>
          {chosen && !selecting && (
            <Pin data-slot="node-outbound-marker" aria-hidden="true" className="node-chosen-pin" />
          )}
          <div className="node-metrics">
            <span className="node-metric-availability">
              <small>{tr("24h 可用率")}</small>
              <b data-healthy={result.percent !== undefined && result.percent >= 98 ? 'true' : undefined}>
                {result.percent === undefined ? '—' : result.percent + '%'}
              </b>
            </span>
            <span className="node-metric-average"><small>{tr("24h 平均")}</small><b>{result.average === undefined ? '—' : result.average + ' ms'}</b></span>
            <NodeLatencyButton
              node={{ name: node.config.name, latestMs: result.latest && result.latest > 0 ? result.latest : null,
                status: result.latest === -1 ? 'timeout' : null }}
              className="self-end min-h-8"
              disabled={busy}
              testing={probing.includes(node.id)}
              onMeasure={() => probe([node.id])}
            />
          </div>
        </article>
      })}
    </div>
  </main>
  {selecting && (
    <footer className="page-action node-selection-bar">
      <span className="node-selection-count">{tr('已选 {0} 项', validChecked.length)}</span>
      <div className="node-selection-actions">
        <Button
          size="sm"
          variant="outline"
          disabled={busy || (!isProbing && !validChecked.length)}
          onClick={() => (isProbing ? onCancelProbe?.() : probe(validChecked))}
        >
          {isProbing ? (
            <RefreshCw data-icon="inline-start" className="motion-safe:animate-spin" />
          ) : (
            <Zap data-icon="inline-start" />
          )}
          {isProbing ? tr('停止测速') : tr('测速')}
        </Button>
        <Button size="sm" variant="default" disabled={busy || !validChecked.length} onClick={join}>
          {tr('加入分组')}
        </Button>
      </div>
    </footer>
  )}
  </>
}

const logPageSizes = [20, 50, 100] as const

function formatLogTime(start?: string, fallbackMs?: number) {
  const parsed = start ? Date.parse(start) : Number.NaN
  const ts = Number.isFinite(parsed) ? parsed : fallbackMs
  return formatDateTime(ts, { seconds: true })
}

export function Connections({
  running,
  rows,
  exit,
  labels,
  busy,
  measurement,
  filter: controlledFilter,
  setFilter: setControlledFilter,
  query: controlledQuery,
  setQuery: setControlledQuery,
  diagnose,
  onClearLogs,
  onSelect,
}: {
  running: boolean
  rows: Connection[]
  exit?: ExitInfo
  labels: Record<string, string>
  busy: boolean
  measurement?: ChainMeasurement
  filter?: 'all' | 'ok' | 'warn'
  setFilter?: (next: 'all' | 'ok' | 'warn') => void
  query?: string
  setQuery?: (next: string) => void
  diagnose: () => void
  onClearLogs?: () => void
  onSelect: (conn: Connection) => void
}) {
  const [localFilter, setLocalFilter] = useState<'all' | 'ok' | 'warn'>('all')
  const [localQuery, setLocalQuery] = useState('')
  const [requestedPage, setPage] = useState(1)
  const [pageSize, setPageSize] = useState<number>(() => {
    const saved = Number(preferences.getItem('air.mobile.connectionsPageSize'))
    return logPageSizes.includes(saved as (typeof logPageSizes)[number]) ? saved : 20
  })
  const filter = controlledFilter ?? localFilter
  const setFilter = setControlledFilter ?? setLocalFilter
  const query = controlledQuery ?? localQuery
  const setQuery = setControlledQuery ?? setLocalQuery
  useEffect(() => {
    setPage(1)
  }, [filter, query, pageSize])
  const destination = (c: Connection) => {
    const host = c.metadata.host || c.metadata.destinationIP || tr('未知目标')
    if (!c.metadata.destinationPort) return host
    return (host.includes(':') ? '[' + host + ']' : host) + ':' + c.metadata.destinationPort
  }
  const path = (c: Connection) => [...(c.chains ?? [])].reverse().map(name => labels[name] ?? name).join(' → ')
  const search = query.trim().toLowerCase()
  const visible = rows.filter(row => {
    const route = connectionRoute(row, labels)
    if (filter === 'warn' && route.kind !== 'reject') return false
    if (filter === 'ok' && route.kind === 'reject') return false
    if (!search) return true
    return [row.appName, row.metadata.process, destination(row), row.rule, path(row), route.fullLabel, route.shortLabel]
      .some(value => value?.toLowerCase().includes(search))
  })
  const maxPage = Math.max(1, Math.ceil(visible.length / pageSize))
  const page = Math.min(requestedPage, maxPage)
  const paged = visible.slice((page - 1) * pageSize, page * pageSize)
  const hasClosedLogs = rows.some(row => row.closed)
  const showProbe = measurement && (filter === 'all' || (filter === 'ok') === (measurement.delay > 0)) &&
    (!search || [measurement.name, ...measurement.hops].some(value => value.toLowerCase().includes(search)))
  return <main className="page-scroll">
    <div className="conn-log-toolbar">
      <Segmented ariaLabel={tr("连接状态筛选")} layoutId="android-connection-filter" value={filter} onChange={next => { setFilter(next); setPage(1) }}
        options={[{ value: 'all', label: tr('全部') }, { value: 'ok', label: tr('已连通') }, { value: 'warn', label: tr('异常') }]} />
      <div className="conn-log-toolbar-right">
        <Tag tone={running ? 'green' : 'gray'}>{running ? tr('记录中') : tr('代理已停止')}</Tag>
        {onClearLogs && (
          <Button
            size="icon-sm"
            variant="outline"
            disabled={!hasClosedLogs}
            aria-label={tr('清空已结束记录')}
            onClick={onClearLogs}
          >
            <Trash2 />
          </Button>
        )}
      </div>
    </div>
    <input aria-label={tr("搜索连接")} placeholder={tr("搜索应用、目标或链路")} value={query} onChange={event => { setQuery(event.target.value); setPage(1) }} />
    {!visible.length && !showProbe && (
      <Empty
        icon={Activity}
        title={query || filter !== 'all' ? tr('没有匹配的连接记录') : running ? tr('等待应用发起连接') : tr('暂无整链探测与连接记录')}
      >
        {(query || filter !== 'all') && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setQuery('')
              setFilter('all')
            }}
          >
            {tr('重置筛选')}
          </Button>
        )}
      </Empty>
    )}
    {showProbe && <section className="panel diagnostic">
      <div className="section-title"><strong>{tr("整链探测")}</strong><Tag tone={measurement.delay > 0 ? 'green' : 'red'}>{measurement.delay > 0 ? measurement.delay + ' ms' : tr('探测失败')}</Tag></div>
      <strong className="break-words">{measurement.name}</strong><small className="fine-print break-words">{measurement.hops.join(' → ')}</small>
    </section>}
    <div className="item-stack">
      {paged.map(c => {
        const route = connectionRoute(c, labels)
        const routeSummary = path(c) || [c.rule, c.rulePayload].filter(Boolean).join(' · ') || tr('默认路由')
        const statusTone = route.kind === 'reject' ? 'red' : c.closed ? 'gray' : 'green'
        const statusLabel = route.kind === 'reject' ? tr('已拒绝') : c.closed ? tr('已结束') : tr('活跃')
        return <button type="button" key={c.id} className="panel connection-row" onClick={() => onSelect(c)}>
          <div className="connection-row-head">
            <div className="connection-row-app">
              <ConnectionApp name={c.appName || c.metadata.process || tr('未知应用')} executable={c.appName ? c.metadata.process : undefined} icon={c.appIcon} />
            </div>
            <div className="connection-row-tags">
              <Tag tone={statusTone} className="connection-row-status">
                {!c.closed && route.kind !== 'reject' && <span className="connection-row-dot" aria-hidden="true" />}
                {statusLabel}
              </Tag>
            </div>
          </div>
          <div className="connection-row-route-line">
            <Tag tone={route.tone} className="connection-row-route">{route.fullLabel}</Tag>
          </div>
          <div className="connection-row-target">{destination(c)}</div>
          <div className="connection-row-foot">
            <span className="connection-row-meta" title={routeSummary}>
              <span className="conn-log-time">{formatLogTime(c.start, c.firstSeenAt)}</span>
              {routeSummary}
            </span>
            <span className="connection-row-traffic">
              <span className="connection-row-dl"><ArrowDown size={11} aria-hidden="true" />{bytes(c.download)}</span>
              <span className="connection-row-ul"><ArrowUp size={11} aria-hidden="true" />{bytes(c.upload)}</span>
            </span>
          </div>
        </button>
      })}
    </div>
    {visible.length > 0 && (
      <div className="conn-log-pager">
        <span>{tr('共 {0} 条 · 第 {1}/{2} 页', visible.length, page, maxPage)}</span>
        <div className="conn-log-pager-actions">
          <Button
            size="sm"
            variant="outline"
            aria-label={tr('切换每页显示条数')}
            onClick={() => {
              const idx = logPageSizes.indexOf(pageSize as (typeof logPageSizes)[number])
              const next = logPageSizes[(idx + 1) % logPageSizes.length]
              setPageSize(next)
              preferences.setItem('air.mobile.connectionsPageSize', String(next))
              setPage(1)
            }}
          >
            {tr('{0} 条/页', pageSize)}
          </Button>
          <Button
            size="icon-sm"
            variant="outline"
            disabled={page <= 1}
            aria-label={tr('上一页')}
            onClick={() => setPage(Math.max(1, page - 1))}
          >
            <ChevronLeft />
          </Button>
          <Button
            size="icon-sm"
            variant="outline"
            disabled={page >= maxPage}
            aria-label={tr('下一页')}
            onClick={() => setPage(Math.min(maxPage, page + 1))}
          >
            <ChevronRight />
          </Button>
        </div>
      </div>
    )}
    <section className="panel diagnostic">
      <div className="flex min-w-0 items-center justify-between gap-2">
        <div className="min-w-0">
          <strong className="block text-sm">{tr("出口验证")}</strong>
          <span className="block break-all text-xs text-muted-foreground">{exit ? tr('已验证出口 · ') + exit.ip : tr('启动代理后可核对出口 IP')}</span>
        </div>
        <Button size="sm" variant="default" className="shrink-0" disabled={!running || busy} onClick={diagnose}><Activity />{tr("验证出口")}</Button>
      </div>
    </section>
  </main>
}
