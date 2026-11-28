import { formatLocale, tr } from '@/shared/i18n/messages'
import { isTauri } from '@tauri-apps/api/core'
import {
  Activity,
  ArrowDown,
  ArrowUp,
  Check,
  ChevronRight,
  CloudDownload,
  Copy,
  Globe,
  Layers,
  Network,
  Plug,
  RefreshCw,
  Route,
  Waypoints,
} from 'lucide-react'
import { motion } from 'motion/react'
import { useMemo, useState } from 'react'
import { cn, formatBytes, formatDateTime, formatProtocol, formatRate } from '@/shared/lib/utils'
import { Badge } from '@/shared/ui/badge'
import { Button } from '@/shared/ui/button'
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '@/shared/ui/card'
import { FlagText } from '@/shared/ui/FlagText'
import { showMessage } from '@/shared/ui/message'
import { Segmented } from '@/shared/ui/segmented'
import { Separator } from '@/shared/ui/separator'
import { Switch } from '@/shared/ui/switch'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/shared/ui/table'
import { TraceLines } from '@/shared/ui/TraceLines'
import { PageHeaderIcon } from '@/shared/ui/PageHeaderIcon'
import { DashboardPowerButton } from '@/shared/ui/DashboardPowerButton'
import { SpinningGlobeIcon } from '@/shared/ui/SpinningGlobeIcon'
import { idleHeights, TrafficBars, trafficHeights } from '@/shared/ui/TrafficBars'
import type { ExitVerification, ProxyConnection, ProxyModeAction, ProxyHop, ProxyStatus } from '@/platform/desktop/air'
import type { Nodes } from '../nodes/useNodes'
import { ConnectionApp } from '@/shared/ui/ConnectionApp'
import type { ConnectivityLookup, ExitLookup, TelemetryHistory } from '../proxy/useProxy'
import { captureModeLabel, proxyModes } from '@/shared/proxy/modes'
import { TunServiceButton } from '../proxy/TunServiceButton'
import { ServiceConnectivityCard } from './ServiceConnectivityCard'

const exitKinds = {
  datacenter: { get label() { return tr('机房') }, variant: 'accent' },
  residential: { get label() { return tr('住宅') }, variant: 'success' },
  mobile: { get label() { return tr('移动网络') }, variant: 'warning' },
  gateway: { get label() { return tr('网关') }, variant: 'outline' },
} as const
const exitQuality = {
  noEvidence: { get label() { return tr('未见风险') }, variant: 'outline' },
  lowRisk: { get label() { return tr('低风险') }, variant: 'success' },
  mediumRisk: { get label() { return tr('中风险') }, variant: 'warning' },
  highRisk: { get label() { return tr('高风险') }, variant: 'danger' },
} as const

function ExitSummary({ exit, verification, checking, failed, copied, onCopy, onRefresh }: ExitLookup & {
  verification?: ExitVerification
  copied: boolean
  onCopy: (ip: string) => void
}) {
  const regionNames = useMemo(() => new Intl.DisplayNames(formatLocale, { type: 'region', fallback: 'none' }), [formatLocale])
  const ip = exit?.ip ?? verification?.ip
  const code = exit?.countryCode?.toUpperCase()
  const country = code && /^[A-Z]{2}$/.test(code) && code !== 'ZZ' ? regionNames.of(code) : undefined
  const flag = country && code
    ? String.fromCodePoint(...Array.from(code, char => char.charCodeAt(0) + 0x1f1a5))
    : undefined
  const fullLocation = [...new Set([country, exit?.region, exit?.city].filter(Boolean))].join(' · ')
  const kind = exit?.kind && exitKinds[exit.kind]
  const quality = exit?.quality && exitQuality[exit.quality]
  const flagIcon = checking
    ? <SpinningGlobeIcon spinning className="size-4 text-primary" />
    : flag ?? <SpinningGlobeIcon className="size-4 text-muted-foreground" />
  const flagClass = 'grid h-7 w-6 shrink-0 place-items-center rounded text-xl leading-none'
  const retryLabel = fullLocation ? tr("{0}出口，点击重新检测", fullLocation) : tr('重新检测出口 IP')

  return (
    <CardFooter className="relative col-start-1 row-start-3 min-w-0 flex-wrap justify-start gap-x-1.5 gap-y-1 @[26rem]:gap-x-1.5">
      {onRefresh ? (
        <button
          type="button"
          className={cn(flagClass, 'cursor-pointer outline-none transition-colors hover:bg-card focus-visible:ring-2 focus-visible:ring-ring/60 disabled:cursor-wait')}
          aria-label={retryLabel}
          aria-busy={checking || undefined}
          title={retryLabel}
          disabled={checking}
          onClick={onRefresh}
        >
          <span className="grid place-items-center" aria-hidden="true">{flagIcon}</span>
        </button>
      ) : (
        <span className={flagClass} title={fullLocation || undefined} aria-hidden="true">{flagIcon}</span>
      )}
      {ip ? (
        <>
          <Button
            variant="ghost"
            size="sm"
            aria-label={tr("复制出口 IP")}
            title={tr("复制出口 IP · {0}", ip)}
            onClick={() => onCopy(ip)}
            className="min-w-0 shrink gap-1 border-0 px-0.5 text-foreground"
          >
            <span className="mono truncate text-sm font-semibold">{ip}</span>
            {copied ? <Check className="size-3 text-success" /> : <Copy className="size-3 text-muted-foreground" />}
          </Button>
          {kind && <Badge variant={kind.variant} className="rounded-md">{kind.label}</Badge>}
          {quality && (
            <Badge
              variant={quality.variant}
              className={cn('rounded-md', quality.variant === 'outline' && 'border-muted-foreground/40 bg-card/65 text-secondary-foreground')}
              title={tr("根据出口 IP 的信誉数据评估")}
            >
              {quality.label}
            </Badge>
          )}
          {verification && !onRefresh && <Badge variant="success" className="mono">{verification.latencyMs} ms</Badge>}
        </>
      ) : (
        <p className="truncate text-xs text-secondary-foreground">{tr("出口 IP · ")}{checking ? tr('正在检测…') : failed ? tr('暂时无法检测') : tr('启动后检测')}
        </p>
      )}
    </CardFooter>
  )
}

function subscriptionQuotaState(
  source?: {
    details?: {
      usage?: { upload: number; download: number; total: number; expire: number | null } | null
    } | null
  },
) {
  const usage = source?.details?.usage
  if (!usage) return undefined
  const used = usage.upload + usage.download
  const hasTotal = usage.total > 0
  const remaining = hasTotal ? Math.max(0, usage.total - used) : 0
  const expiresAt = usage.expire && usage.expire > 0 ? new Date(usage.expire * 1000) : undefined
  const validExpiry = expiresAt && Number.isFinite(expiresAt.getTime()) ? expiresAt : undefined
  const expired = Boolean(validExpiry && validExpiry.getTime() <= Date.now())
  const exhausted = hasTotal && used >= usage.total
  const low =
    (hasTotal && !exhausted && remaining / usage.total <= 0.15) ||
    Boolean(validExpiry && !expired && validExpiry.getTime() - Date.now() <= 3 * 86_400_000)
  const expiryLabel = validExpiry ? tr('{0} 到期', formatDateTime(validExpiry)) : undefined
  if (!hasTotal && !validExpiry && used <= 0) return undefined
  return {
    used,
    total: usage.total,
    remaining,
    hasTotal,
    expired,
    exhausted,
    low,
    expiryLabel,
  }
}

export function Dashboard({
  visitKey,
  store,
  proxy,
  exitLookup,
  connectivityLookup,
  telemetry,
  preferredNode,
  outboundGroupName,
  verified: draftVerification,
  hops,
  chainName: draftName,
  onChain,
  onSubscriptions,
  onConnections,
  onConfigureConnection,
  onRouting,
  onNodes,
  onOpenGroup,
  pending,
  onToggle,
  onControl,
  onTunSetup,
  onError,
}: {
  visitKey?: number
  store: Nodes
  proxy: ProxyStatus
  exitLookup: ExitLookup
  connectivityLookup: ConnectivityLookup
  telemetry?: TelemetryHistory
  preferredNode?: ProxyHop
  outboundGroupName?: string
  verified?: ExitVerification
  hops: string[]
  chainName: string
  onChain: () => void
  onSubscriptions: () => void
  onConnections: () => void
  onConfigureConnection: (connection: ProxyConnection) => void
  onRouting: () => void
  onNodes: () => void
  onOpenGroup?: (sourceId: string, name: string) => void
  pending: 'start' | 'stop' | undefined
  onToggle: () => void
  onControl: (action: ProxyModeAction) => void
  onTunSetup: () => void
  onError: (error: unknown) => void
}) {
  const { sources, nodes, groups } = store.library
  const nodeById = useMemo(() => new Map(nodes.map(node => [node.id, node])), [nodes])
  const draftHops = hops.map(id => nodeById.get(id))
  const runningHops = proxy.mode === 'direct' ? [] : proxy.outbound?.hops ?? []
  const hopNodes = proxy.running ? runningHops : preferredNode ? [preferredNode] : outboundGroupName ? [] : draftHops
  const singleNode = hopNodes.length === 1 ? hopNodes[0] : undefined
  const activeGroupName = proxy.running
    ? (proxy.mode !== 'direct' && proxy.target?.kind === 'group' ? (proxy.outbound?.name || proxy.target.name) : undefined)
    : (!singleNode ? outboundGroupName : undefined)
  const sourceId = singleNode && nodeById.get(singleNode.id)?.sourceId
  const selectedSource = sources.find(source => source.id === sourceId)
  const selectedQuota = subscriptionQuotaState(selectedSource)
  const expiryLabel = selectedQuota?.expiryLabel
  const subscriptionStatus = selectedQuota?.expired
    ? tr('已过期')
    : selectedQuota?.exhausted
      ? tr('流量用尽')
      : undefined
  const sourceName = selectedSource?.name ?? singleNode?.source
  const chainName = proxy.running ? (runningHops.length > 1 ? proxy.outbound?.name : '') : singleNode ? '' : draftName
  const filledCount = hopNodes.filter((item): item is ProxyHop => Boolean(item)).length
  const verified = !singleNode && (!proxy.running || (runningHops.length === hops.length && runningHops.every((hop, index) => hop.id === hops[index])))
    ? draftVerification : undefined
  const pathText =
    filledCount > 0
      ? hopNodes.map((node, index) => node?.name ?? tr("第 {0} 跳待选", index + 1)).join(' → ')
      : proxy.running
        ? proxy.mode === 'direct' ? tr('直连模式') : tr('按分流规则')
        : tr('前置节点 → 出口（至少 2 跳）')
  const subscriptionSources = sources.filter(
    source => source.id !== 'custom' && source.details?.kind !== 'custom',
  )
  const realNodes = nodes.filter(node => !node.subscriptionNotice)
  const availableNodes = realNodes.filter(node => node.status === 'available')
  const measuredMs = availableNodes.map(node => node.latestMs).filter((ms): ms is number => ms !== null)
  const averagePoolMs = measuredMs.length
    ? Math.round(measuredMs.reduce((sum, ms) => sum + ms, 0) / measuredMs.length)
    : null
  const activeNodeRecord = singleNode ? nodeById.get(singleNode.id) : undefined
  const quotaSource = selectedQuota
    ? selectedSource
    : subscriptionSources.find(source => Boolean(subscriptionQuotaState(source)))
  const quotaState = quotaSource ? subscriptionQuotaState(quotaSource) : undefined
  const errorSource = subscriptionSources.find(source => Boolean(source.details?.refreshError))
  const latestUpdatedAt = subscriptionSources.reduce(
    (latest, source) => Math.max(latest, source.details?.updatedAt ?? 0),
    0,
  )
  const [copiedKey, setCopiedKey] = useState<'ip' | 'proxy' | null>(null)

  function copyText(text: string, key: 'ip' | 'proxy') {
    void navigator.clipboard
      .writeText(text)
      .then(() => {
        setCopiedKey(key)
        showMessage({
          type: 'success',
          title: key === 'ip' ? tr('出口 IP 已复制') : tr('本地代理地址已复制'),
        })
        window.setTimeout(() => setCopiedKey(current => (current === key ? null : current)), 1500)
      })
      .catch(onError)
  }

  const trafficCards = [
    {
      icon: ArrowUp,
      label: tr('上传'),
      rate: telemetry && !telemetry.stale ? formatRate(telemetry.uploadRate) : '—',
      peak: telemetry ? formatRate(telemetry.uploadPeak) : '—',
      total: telemetry ? tr("累计 {0}", formatBytes(telemetry.uploadTotal)) : tr('累计 —'),
      heights: telemetry ? trafficHeights(telemetry.uploadHistory) : idleHeights,
    },
    {
      icon: ArrowDown,
      label: tr('下载'),
      rate: telemetry && !telemetry.stale ? formatRate(telemetry.downloadRate) : '—',
      peak: telemetry ? formatRate(telemetry.downloadPeak) : '—',
      total: telemetry ? tr("累计 {0}", formatBytes(telemetry.downloadTotal)) : tr('累计 —'),
      heights: telemetry ? trafficHeights(telemetry.downloadHistory) : idleHeights,
    },
  ] as const

  const liveConnections = telemetry?.connections ?? []
  const { proxyConnectionCount, directConnectionCount, rejectConnectionCount } = liveConnections.reduce(
    (acc, conn) => {
      const target = conn.path.at(-1)?.toUpperCase()
      if (target === 'DIRECT') acc.directConnectionCount++
      else if (target === 'REJECT' || conn.rule.toUpperCase().includes('REJECT')) acc.rejectConnectionCount++
      else acc.proxyConnectionCount++
      return acc
    },
    { proxyConnectionCount: 0, directConnectionCount: 0, rejectConnectionCount: 0 },
  )
  const nodeHealthState = (() => {
    const progressSub = store.progress?.running
      ? tr('正在测速 {0}/{1}', store.progress.completed, store.progress.total)
      : null
    if (activeNodeRecord) {
      if (activeNodeRecord.status === 'available' && activeNodeRecord.latestMs !== null) {
        const dot = activeNodeRecord.latestMs <= 500
          ? 'bg-success'
          : activeNodeRecord.latestMs < 1000
            ? 'bg-warning'
            : 'bg-destructive'
        const parts = [
          activeNodeRecord.availability !== null
            ? tr('可用率 {0}%', Math.round(activeNodeRecord.availability * 100))
            : null,
          realNodes.length ? tr('可用 {0}/{1}', availableNodes.length, realNodes.length) : null,
        ].filter(Boolean)
        return {
          dot,
          value: `${activeNodeRecord.latestMs} ms`,
          sub: progressSub ?? (parts.join(' · ') || tr('前往节点库测速')),
          tone: 'text-foreground mono',
        }
      }
      if (activeNodeRecord.status === 'timeout') {
        return {
          dot: 'bg-warning',
          value: tr('测速超时'),
          sub: progressSub ?? (realNodes.length ? tr('可用 {0}/{1}', availableNodes.length, realNodes.length) : tr('前往节点库测速')),
          tone: 'text-warning',
        }
      }
      if (activeNodeRecord.status === 'unreachable') {
        return {
          dot: 'bg-destructive',
          value: tr('不可达'),
          sub: progressSub ?? (realNodes.length ? tr('可用 {0}/{1}', availableNodes.length, realNodes.length) : tr('前往节点库测速')),
          tone: 'text-destructive',
        }
      }
    }
    return {
      dot: store.progress?.running ? 'bg-primary motion-safe:animate-pulse' : availableNodes.length ? 'bg-success' : 'bg-icon-muted',
      value: !realNodes.length
        ? tr('暂无节点')
        : (availableNodes.length || store.progress?.running)
          ? tr('{0} / {1} 可用', availableNodes.length, realNodes.length)
          : tr('待测速'),
      sub: progressSub ?? (averagePoolMs !== null ? tr('平均延迟 {0} ms', averagePoolMs) : tr('前往节点库测速')),
      tone: 'text-foreground',
    }
  })()
  const networkModes = [
    {
      id: 'systemProxy' as const,
      label: tr('系统代理'),
      checked: proxy.systemProxy,
      tone: 'primary' as const,
      icon: Plug,
      activeCardClass:
        'border-[#2f63e8]/45 bg-[#2f63e8]/[0.055] shadow-[0_2px_10px_-4px_rgba(47,99,232,0.22)] dark:border-[#608eff]/40 dark:bg-[#3b6ae8]/[0.11]',
      activeIconClass:
        'bg-[#2f63e8]/15 text-[#214ecc] dark:bg-[#3b6ae8]/25 dark:text-[#a3b8ff]',
    },
    {
      id: 'tun' as const,
      label: tr('虚拟网卡'),
      checked: proxy.tun,
      tone: 'success' as const,
      icon: Network,
      activeCardClass:
        'border-[#008b78]/45 bg-[#008b78]/[0.055] shadow-[0_2px_10px_-4px_rgba(0,139,120,0.22)] dark:border-[#34d399]/35 dark:bg-[#0ea58a]/[0.11]',
      activeIconClass:
        'bg-[#008b78]/15 text-[#007363] dark:bg-[#0ea58a]/25 dark:text-[#6ee7b7]',
    },
  ] as const

  return (
    <section className="air-scroll flex h-full flex-col gap-3.5 overflow-y-auto px-5 py-4">
      <header className="@container flex min-h-11 shrink-0 items-center justify-between gap-2.5">
        <div className="flex min-w-0 items-center gap-4 whitespace-nowrap">
          <div className="flex shrink-0 items-center gap-2.5">
            <PageHeaderIcon kind="home" animateKey={visitKey} />
            <h1 className="shrink-0 whitespace-nowrap text-[26px] font-bold leading-tight tracking-tight text-foreground">{tr("仪表盘")}</h1>
          </div>
          <TraceLines variant="dashboard" className="sm:hidden @[46rem]:block" />
        </div>

        <div
          role="group"
          aria-label={tr('运行概况与快捷跳转')}
          className="inline-flex h-8.5 shrink-0 items-center gap-0.5 rounded-[8px] border border-border bg-secondary p-0.5 whitespace-nowrap shadow-xs"
        >
          <span
            title={proxy.running ? tr('代理运行中') : store.kernelPath ? tr('内核已就绪') : tr('未配置内核')}
            className="inline-flex h-7 shrink-0 items-center gap-1.5 px-2 text-xs font-medium whitespace-nowrap text-foreground"
          >
            <span
              className={cn(
                'size-1.5 rounded-full',
                proxy.running
                  ? 'bg-success motion-safe:animate-pulse'
                  : store.kernelPath
                    ? 'bg-primary'
                    : 'bg-icon-muted',
              )}
            />
            <span className="hidden @[34rem]:inline">{proxy.running ? tr('代理运行中') : store.kernelPath ? tr('内核已就绪') : tr('未配置内核')}</span>
          </span>

          <Separator orientation="vertical" className="mx-0.5 h-4 bg-border" />

          <motion.button
            type="button"
            onClick={onNodes}
            title={tr("前往节点库")}
            whileHover={{ scale: 1.03 }}
            whileTap={{ scale: 0.94 }}
            transition={{ type: 'spring', stiffness: 520, damping: 28 }}
            className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-[6px] px-2 text-xs font-medium whitespace-nowrap text-muted-foreground outline-none transition-colors hover:bg-accent-soft/80 hover:text-primary focus-visible:ring-2 focus-visible:ring-ring/60"
          >
            <Network className="size-3.5 text-primary" />
            <span className="mono font-semibold text-foreground">{nodes.length}</span>
            <span className="hidden @[24rem]:inline">{tr("节点")}</span>
          </motion.button>

          <Separator orientation="vertical" className="mx-0.5 h-4 bg-border" />

          <motion.button
            type="button"
            onClick={onSubscriptions}
            title={tr("前往订阅管理")}
            whileHover={{ scale: 1.03 }}
            whileTap={{ scale: 0.94 }}
            transition={{ type: 'spring', stiffness: 520, damping: 28 }}
            className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-[6px] px-2 text-xs font-medium whitespace-nowrap text-muted-foreground outline-none transition-colors hover:bg-accent-soft/80 hover:text-primary focus-visible:ring-2 focus-visible:ring-ring/60"
          >
            <CloudDownload className="size-3.5 text-primary" />
            <span className="mono font-semibold text-foreground">{subscriptionSources.length}</span>
            <span className="hidden @[24rem]:inline">{tr("订阅")}</span>
          </motion.button>
        </div>
      </header>

      <div className="grid shrink-0 grid-cols-2 gap-3 lg:grid-cols-[minmax(340px,1.55fr)_repeat(2,minmax(0,1fr))] xl:grid-cols-[minmax(420px,1.9fr)_repeat(2,minmax(0,1fr))]">
        <Card className="air-exit-surface @container relative col-span-2 grid min-h-[144px] min-w-0 grid-cols-[minmax(0,1fr)_6.5rem] content-center gap-x-2 gap-y-2 overflow-hidden px-4 py-3.5 lg:col-span-1">
          <CardHeader className="relative z-10 col-start-1 row-start-1 mb-1 min-w-0 justify-start gap-2">
            <div className="flex shrink-0 items-center gap-1.5">
              <Globe className="size-4 shrink-0 text-primary" />
              <CardTitle>{singleNode ? tr('当前节点') : activeGroupName ? tr('自动分组') : proxy.running && proxy.mode === 'direct' ? tr('直连出口') : tr('链路出口')}</CardTitle>
              {!singleNode && !activeGroupName && (
                <Badge
                  variant={verified ? 'success' : 'default'}
                  className={!verified ? 'border-(--exit-border) bg-(--exit-chip-bg)' : undefined}
                >
                  {verified ? tr('整链探测') : tr('待探测')}
                </Badge>
              )}
            </div>
            {singleNode && (
              <div className="flex min-w-0 items-center gap-1.5">
                {sourceName && (
                  <Badge variant="default" className="min-w-0 shrink border-(--exit-border) bg-(--exit-chip-bg)" title={[sourceName, subscriptionStatus, expiryLabel].filter(Boolean).join(' · ')}>
                    <span className="min-w-0 truncate"><FlagText text={sourceName} /></span>
                  </Badge>
                )}
                <Badge variant="mono" className="border-(--exit-border) bg-(--exit-chip-bg)">{formatProtocol(singleNode.protocol)}</Badge>
              </div>
            )}
          </CardHeader>

          <button
            type="button"
            onClick={singleNode || activeGroupName ? onNodes : onChain}
            title={singleNode ? singleNode.name : activeGroupName ?? pathText}
            className="group relative z-10 col-start-1 row-start-2 flex min-w-0 max-w-full items-center gap-1.5 justify-self-start rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
          >
            <strong className="min-w-0 truncate text-lg leading-7 font-bold tracking-tight text-foreground transition-colors group-hover:text-primary @[26rem]:text-[21px]">
              <FlagText text={singleNode?.name ?? activeGroupName ?? (chainName || (proxy.running ? pathText : tr('尚未配置')))} />
            </strong>
            {!singleNode && !activeGroupName && hopNodes.length > 1 && (
              <Badge variant="accent" className="mono">{filledCount}/{hopNodes.length}{tr(" 跳")}</Badge>
            )}
            <ChevronRight className="size-3.5 shrink-0 text-muted-foreground/70 transition-[transform,color] duration-150 group-hover:translate-x-0.5 group-hover:text-primary" />
          </button>

          <div className="absolute inset-y-0 right-5 flex items-center">
            <DashboardPowerButton
              status={proxy}
              pending={pending}
              telemetry={telemetry}
              onToggle={onToggle}
            />
          </div>
          <ExitSummary
            {...exitLookup}
            verification={proxy.running ? undefined : verified}
            copied={copiedKey === 'ip'}
            onCopy={ip => copyText(ip, 'ip')}
          />
        </Card>

        {trafficCards.map(({ icon: Icon, label, rate, peak, total, heights }) => (
          <Card key={label} className="@container min-h-[144px] min-w-0 justify-between gap-2 px-4 py-3.5">
            <CardHeader className="gap-1.5">
              <div className="flex shrink-0 items-center gap-1.5 whitespace-nowrap">
                <Icon className="size-4 text-primary" />
                <CardTitle>{label}</CardTitle>
              </div>
              <span className="mono truncate text-xs text-muted-foreground" title={tr("峰值 {0}", peak)}>
                <span className="sr-only @[11rem]:not-sr-only">{tr("峰值")}</span>{peak}
              </span>
            </CardHeader>

            <CardContent className="justify-end gap-1.5">
              <strong className="mono truncate text-[26px] font-bold leading-none tracking-tight text-foreground">
                {rate}
              </strong>
              <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                <span className="mono shrink-0">{total}</span>
                <span className="truncate">{telemetry?.stale ? tr('采样暂未更新') : telemetry ? tr('最近采样') : proxy.running ? tr('等待采样') : tr('未启动')}</span>
              </div>
              <TrafficBars running={Boolean(telemetry && !telemetry.stale)} heights={heights} />
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="grid shrink-0 grid-cols-2 gap-3 lg:grid-cols-[minmax(340px,1.55fr)_repeat(2,minmax(0,1fr))] xl:grid-cols-[minmax(420px,1.9fr)_repeat(2,minmax(0,1fr))]">
        <Card className="col-span-2 flex-row items-center justify-between gap-2 px-3.5 py-2 lg:col-span-1">
          <CardTitle className="flex shrink-0 items-center gap-2 text-xs">
            <Route className="size-4 text-primary" />{tr("出站模式")}</CardTitle>
          <Segmented
            layoutId="dashboard-proxy-mode"
            ariaLabel={tr("仪表盘出站模式")}
            size="xs"
            value={proxy.mode}
            options={proxyModes}
            disabled={Boolean(pending)}
            onChange={mode => onControl({ action: 'mode', mode })}
          />
        </Card>
        {networkModes.map(({ id, label, checked, tone, icon: Icon, activeCardClass, activeIconClass }) => (
          <Card
            key={id}
            className={cn(
              'min-w-0 flex-row items-center gap-2 px-3.5 py-2.5 transition-[border-color,background-color,box-shadow] duration-200',
              checked && activeCardClass,
            )}
          >
            <span
              className={cn(
                'grid size-7 shrink-0 place-items-center rounded-[7px] transition-colors duration-200',
                checked ? activeIconClass : 'bg-muted text-muted-foreground',
              )}
            >
              <Icon className="size-3.5" />
            </span>
            <div className="flex min-w-0 flex-1 flex-col">
              <CardTitle className="truncate text-xs" title={label}>{label}</CardTitle>
              <span className="truncate text-[12px] text-muted-foreground">
                {id === 'systemProxy' && proxy.port
                  ? `${captureModeLabel(proxy.running, checked)} · 127.0.0.1:${proxy.port}`
                  : captureModeLabel(proxy.running, checked)}
              </span>
            </div>
            {id === 'systemProxy' && proxy.port && (
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={tr("复制本地代理地址")}
                title={tr("复制本地代理地址 · {0}", `127.0.0.1:${proxy.port}`)}
                onClick={() => copyText(`127.0.0.1:${proxy.port}`, 'proxy')}
              >
                {copiedKey === 'proxy' ? <Check className="text-success" /> : <Copy />}
              </Button>
            )}
            {id === 'tun' && proxy.tunServiceReady === false && (
              <TunServiceButton onClick={onTunSetup} disabled={Boolean(pending)} />
            )}
            <Switch
              checked={checked}
              tone={tone}
              aria-label={label}
              disabled={Boolean(pending)}
              onCheckedChange={enabled => onControl({ action: id, enabled })}
            />
          </Card>
        ))}
      </div>

      <div className="grid shrink-0 grid-cols-2 gap-3 lg:grid-cols-4">
        <ServiceConnectivityCard {...connectivityLookup} />

        <Card className="gap-2 p-3.5">
          <CardHeader className="min-h-7">
            <span className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
              <Activity className="size-3.5 text-muted-foreground" />{tr("节点健康")}</span>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={tr("前往节点库")}
              onClick={onNodes}
            >
              <ChevronRight />
            </Button>
          </CardHeader>
          <div className="flex items-center gap-2">
            <span className={cn('size-2 shrink-0 rounded-full', nodeHealthState.dot)} />
            <strong className={cn('truncate text-[15px] font-semibold', nodeHealthState.tone)}>
              {nodeHealthState.value}
            </strong>
          </div>
          <small className="truncate text-[12px] text-muted-foreground">
            {nodeHealthState.sub}
          </small>
        </Card>

        <Card className="gap-2 p-3.5">
          <CardHeader className="min-h-7">
            <span className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
              <CloudDownload className="size-3.5 text-muted-foreground" />{tr("套餐余量")}</span>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={tr("管理订阅")}
              onClick={onSubscriptions}
            >
              <ChevronRight />
            </Button>
          </CardHeader>
          <strong
            className={cn(
              'truncate text-[15px] font-semibold',
              quotaState?.expired || quotaState?.exhausted
                ? 'text-destructive'
                : quotaState?.low || (!quotaState && errorSource)
                  ? 'text-warning'
                  : 'text-foreground',
            )}
            title={quotaSource?.name ?? errorSource?.name}
          >
            {quotaState
              ? quotaState.exhausted
                ? tr('流量用尽')
                : quotaState.expired
                  ? tr('套餐已到期')
                  : quotaState.hasTotal
                    ? tr('剩余 {0}', formatBytes(quotaState.remaining))
                    : quotaState.expiryLabel
                      ? quotaState.expiryLabel
                      : tr('已用 {0}', formatBytes(quotaState.used))
              : errorSource
                ? tr('同步异常')
                : subscriptionSources.length
                  ? tr('{0} 个订阅正常', subscriptionSources.length)
                  : tr('暂无订阅')}
          </strong>
          <small className="truncate text-[12px] text-muted-foreground">
            {quotaSource && quotaState
              ? [
                  quotaSource.name,
                  quotaState.hasTotal ? tr('共 {0}', formatBytes(quotaState.total)) : null,
                  quotaState.hasTotal ? quotaState.expiryLabel : null,
                ].filter(Boolean).join(' · ')
              : errorSource
                ? errorSource.name
                : latestUpdatedAt > 0
                  ? tr('最近同步 {0}', formatDateTime(new Date(latestUpdatedAt)))
                  : tr('导入订阅查看节点')}
          </small>
        </Card>

        <Card className="gap-2 p-3.5">
          <CardHeader className="min-h-7">
            <span className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
              <Waypoints className="size-3.5 text-muted-foreground" />{tr("实时分流")}</span>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={tr("配置分流规则")}
              onClick={onRouting}
            >
              <ChevronRight />
            </Button>
          </CardHeader>
          <strong className="truncate text-[15px] font-semibold text-foreground">
            {proxy.running && liveConnections.length > 0
              ? tr('{0} 代理 · {1} 直连', proxyConnectionCount, directConnectionCount)
              : proxy.running
                ? proxy.mode === 'global'
                  ? tr('全局代理')
                  : proxy.mode === 'direct'
                    ? tr('全直连')
                    : tr('等待流量')
                : tr('分流待命')}
          </strong>
          <small className="truncate text-[12px] text-muted-foreground">
            {proxy.running && rejectConnectionCount > 0
              ? tr('已拦截 {0} 条请求 · 点击设置规则', rejectConnectionCount)
              : proxy.running
                ? tr('{0} · 点击配置分流规则', proxyModes.find(item => item.value === proxy.mode)?.label ?? tr('规则'))
                : tr('点击查看或编辑分流规则')}
          </small>
        </Card>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-1 grid-rows-[minmax(16rem,1fr)_auto] gap-3 lg:grid-cols-[minmax(0,2.1fr)_minmax(0,1fr)] lg:grid-rows-[minmax(16rem,1fr)]">
        <Card className="min-h-0 min-w-0 gap-3 p-4">
          <CardHeader className="shrink-0">
            <div className="flex items-center gap-2">
              <Activity className="size-4 text-primary" />
              <CardTitle>{tr("实时连接")}</CardTitle>
              <Badge variant="accent" className="mono">
                {liveConnections.length}
              </Badge>
            </div>
            <Button variant="secondary" size="sm" onClick={onConnections}>{tr("查看连接")}<ChevronRight data-icon="inline-end" />
            </Button>
          </CardHeader>

          <CardContent className="min-h-0 min-w-0">
            {liveConnections.length > 0 ? (
              <Table aria-label={tr("实时连接")} containerClassName="min-h-0 flex-1 shadow-none" className="min-w-[30rem] table-fixed">
                <TableHeader>
                  <TableRow className="[&>th]:text-center">
                    <TableHead className="w-1/4">{tr("应用")}</TableHead>
                    <TableHead className="w-[29%]">{tr("目标")}</TableHead>
                    <TableHead>{tr("出口")}</TableHead>
                    <TableHead className="w-[5.25rem]">{tr("下载")}</TableHead>
                    <TableHead className="w-[5.25rem]">{tr("上传")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {liveConnections.map(conn => (
                    <TableRow
                      key={conn.id}
                      onClick={() => onConfigureConnection(conn)}
                      title={tr('点击修改此连接的直连/代理分流策略')}
                      className="cursor-pointer"
                    >
                      <TableCell>
                        <button
                          type="button"
                          onClick={event => {
                            event.stopPropagation()
                            onConfigureConnection(conn)
                          }}
                          className="block w-full rounded-sm text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
                        >
                          <ConnectionApp
                            name={conn.app}
                            executable={conn.appExecutable}
                            icon={conn.appIconKey ? telemetry?.appIcons?.[conn.appIconKey] : undefined}
                          />
                        </button>
                      </TableCell>
                      <TableCell className="mono truncate text-muted-foreground" title={conn.target}>{conn.target}</TableCell>
                      <TableCell className="truncate text-center text-primary" title={conn.path.join(' → ')}>
                        <FlagText text={conn.path.at(-1) ?? '—'} />
                      </TableCell>
                      <TableCell className="mono text-center">{formatBytes(conn.downloadBytes)}</TableCell>
                      <TableCell className="mono text-center text-muted-foreground">{formatBytes(conn.uploadBytes)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ) : (
              <div className="flex flex-1 flex-col items-center justify-center gap-1.5 rounded-[8px] border border-dashed border-border-subtle bg-muted/20 p-4 text-center">
                <span className="text-xs font-medium text-foreground">{tr("暂无实时连接")}</span>
                <span className="text-xs text-muted-foreground">{tr("启动代理后可在此及「连接日志」查看实况路由")}</span>
              </div>
            )}
          </CardContent>
          {telemetry?.stale && <CardFooter className="text-xs text-muted-foreground">{tr("显示最近一次采样")}</CardFooter>}
        </Card>

        <Card className="min-h-0 min-w-0 gap-3 p-4 max-lg:max-h-[24rem]">
          <CardHeader className="shrink-0">
            <div className="flex items-center gap-2">
              <Layers className="size-4 text-primary" />
              <CardTitle>{tr("分组")}</CardTitle>
              <Badge variant="default" className="mono">
                {groups.length}
              </Badge>
            </div>
            <Button variant="secondary" size="sm" onClick={onNodes}>{tr("查看分组")}<ChevronRight data-icon="inline-end" />
            </Button>
          </CardHeader>

          {groups.length > 0 ? (
            <div className="air-scroll flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto pr-0.5">
              {groups.map(group => {
                const sourceName = sources.find(source => source.id === group.sourceId)?.name
                const memberCount = (group.memberNames ?? group.members).length
                const isSelected = Boolean(outboundGroupName && group.name === outboundGroupName)
                return (
                  <button
                    key={group.sourceId + ':' + group.name}
                    type="button"
                    onClick={() => (onOpenGroup ? onOpenGroup(group.sourceId, group.name) : onNodes())}
                    className={cn(
                      'group flex w-full shrink-0 cursor-pointer flex-col gap-1 rounded-[8px] border px-3 py-2.5 text-left outline-none transition-[transform,color,background-color,border-color,box-shadow] duration-150 focus-visible:ring-2 focus-visible:ring-ring/60 active:scale-[0.985]',
                      isSelected
                        ? 'border-accent-border/45 bg-accent-soft/65 hover:border-primary/50 hover:bg-accent-soft'
                        : 'border-border bg-muted/55 hover:border-accent-border hover:bg-accent-soft/45 dark:bg-[#252730]',
                    )}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <strong
                        className={cn(
                          'truncate text-xs font-semibold transition-colors group-hover:text-primary',
                          isSelected ? 'text-primary' : 'text-foreground',
                        )}
                        title={group.name}
                      >
                        {group.name}
                      </strong>
                      <div className="flex shrink-0 items-center gap-1">
                        {group.strategy && (
                          <Badge variant={isSelected ? 'accent' : 'default'}>
                            {group.strategy}
                          </Badge>
                        )}
                        <ChevronRight className="size-3.5 text-muted-foreground/70 transition-transform duration-150 group-hover:translate-x-0.5 group-hover:text-primary" />
                      </div>
                    </div>
                    <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                      <span className="truncate">{sourceName ?? tr('订阅分组')}</span>
                      <span className="mono shrink-0">{memberCount}{tr(" 个成员")}</span>
                    </div>
                  </button>
                )
              })}
            </div>
          ) : (
            <div className="flex flex-1 flex-col items-center justify-center gap-1 rounded-[8px] border border-dashed border-border-subtle bg-muted/20 py-6 text-center">
              <span className="text-xs font-medium text-foreground">{tr("暂无订阅分组")}</span>
              <span className="text-[12px] text-muted-foreground">{tr("导入订阅后显示可用策略组")}</span>
            </div>
          )}
        </Card>
      </div>
    </section>
  )
}
