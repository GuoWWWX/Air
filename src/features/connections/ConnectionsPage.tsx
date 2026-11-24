import { tr } from '@/shared/i18n/messages'
import { preferences } from '@/shared/lib/preferences'
import {
  Activity,
  AlertCircle,
  AppWindow,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Copy,
  Globe,
  Layers,
  MinusCircle,
  Search,
  Shield,
  Trash2,
  Waypoints,
  X,
} from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { cn, formatBytes, formatDateTime, formatProtocol } from '@/shared/lib/utils'
import { AirSelect } from '@/shared/ui/AirSelect'
import { Badge } from '@/shared/ui/badge'
import { Button } from '@/shared/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/shared/ui/card'
import { FlagText } from '@/shared/ui/FlagText'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/shared/ui/context-menu'
import { Input } from '@/shared/ui/input'
import { showMessage } from '@/shared/ui/message'
import { Segmented } from '@/shared/ui/segmented'
import { Separator } from '@/shared/ui/separator'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/shared/ui/table'
import { TraceLines } from '@/shared/ui/TraceLines'
import { PageHeaderIcon } from '@/shared/ui/PageHeaderIcon'
import type { ChainProbeResult, NodeRecord, ProxyConnection, ProxyStatus, ProxyTelemetry } from '@/platform/desktop/air'
import { hopRoleLabel } from '../chains/ChainInspector'
import { ConnectionApp } from '@/shared/ui/ConnectionApp'

interface ConnectionsPageProps {
  visitKey?: number
  proxy: ProxyStatus
  telemetry?: ProxyTelemetry
  probe?: ChainProbeResult
  hops: string[]
  chainName: string
  nodes: NodeRecord[]
  onOpenChain: () => void
  onConfigureConnection?: (connection: ProxyConnection) => void
  onClearLogs?: () => void
}

const filterOptions = [
  { value: 'all', get label() { return tr('全部') } },
  { value: 'ok', get label() { return tr('已连通') } },
  { value: 'warn', get label() { return tr('异常') } },
] as const

const defaultLogPageSize = 20
const logPageSizes = [20, 50, 100].map(size => ({
  value: String(size),
  get label() { return tr('每页 {0} 条', size) },
}))

type ColumnKey = 'app' | 'target' | 'chain' | 'time' | 'status' | 'traffic'

const connectionColumns: readonly {
  key: ColumnKey
  get label(): string
  defaultWidth: number
  minWidth: number
  maxWidth: number
}[] = [
  { key: 'app', get label() { return tr('来源 / 应用') }, defaultWidth: 118, minWidth: 88, maxWidth: 360 },
  { key: 'target', get label() { return tr('出口目标') }, defaultWidth: 134, minWidth: 100, maxWidth: 480 },
  { key: 'chain', get label() { return tr('链路路径') }, defaultWidth: 102, minWidth: 80, maxWidth: 360 },
  { key: 'time', get label() { return tr('时间') }, defaultWidth: 144, minWidth: 130, maxWidth: 220 },
  { key: 'status', get label() { return tr('状态') }, defaultWidth: 68, minWidth: 64, maxWidth: 130 },
  { key: 'traffic', get label() { return tr('累计流量') }, defaultWidth: 74, minWidth: 70, maxWidth: 160 },
]

function clampColumnWidth(key: ColumnKey, value: number) {
  const col = connectionColumns.find(item => item.key === key)!
  return Math.round(Math.min(col.maxWidth, Math.max(col.minWidth, value)))
}

function loadColumnWidths(): Record<ColumnKey, number> {
  const defaults: Record<ColumnKey, number> = {
    app: 118,
    target: 134,
    chain: 102,
    time: 144,
    status: 68,
    traffic: 74,
  }
  try {
    const raw = preferences.getItem('air.connectionsColumnWidths')
    if (!raw) return defaults
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return defaults
    for (const col of connectionColumns) {
      const value = Reflect.get(parsed, col.key)
      if (typeof value === 'number' && Number.isFinite(value)) {
        defaults[col.key] = clampColumnWidth(col.key, value)
      }
    }
  } catch { /* Ignore invalid saved column widths. */ }
  return defaults
}

function DetailItem({
  label,
  copyValue,
  copyLabel,
  onCopy,
  children,
}: {
  label: string
  copyValue?: string
  copyLabel?: string
  onCopy?: (value: string, label: string) => void
  children: ReactNode
}) {
  return (
    <div className="flex flex-col gap-0.5 py-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] font-medium text-muted-foreground">{label}</span>
        {copyValue && copyLabel && onCopy && (
          <button
            type="button"
            aria-label={copyLabel}
            title={copyLabel}
            onClick={() => onCopy(copyValue, label)}
            className="grid size-5 shrink-0 place-items-center rounded-[5px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
          >
            <Copy className="size-3" />
          </button>
        )}
      </div>
      <div className="min-w-0 font-medium text-foreground select-text break-all [overflow-wrap:anywhere]">
        {children}
      </div>
    </div>
  )
}

function formatLogTime(start?: string) {
  return formatDateTime(start, { seconds: true })
}

export function ConnectionsPage({
  visitKey,
  proxy,
  telemetry,
  probe,
  hops,
  chainName,
  nodes,
  onOpenChain,
  onConfigureConnection,
  onClearLogs,
}: ConnectionsPageProps) {
  const [search, setSearch] = useState('')
  const [searchOpen, setSearchOpen] = useState(false)
  const [hoveredTool, setHoveredTool] = useState<'search' | 'clear' | 'chain' | null>(null)
  const searchInput = useRef<HTMLInputElement>(null)
  const searchButton = useRef<HTMLButtonElement>(null)
  const [filter, setFilter] = useState<'all' | 'ok' | 'warn'>(() => {
    const saved = preferences.getItem('air.connectionsFilter')
    return saved === 'ok' || saved === 'warn' ? saved : 'all'
  })
  const [requestedPage, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(() => {
    const saved = Number(preferences.getItem('air.connectionsPageSize'))
    return [20, 50, 100].includes(saved) ? saved : defaultLogPageSize
  })
  useEffect(() => {
    preferences.setItem('air.connectionsFilter', filter)
  }, [filter])
  useEffect(() => {
    preferences.setItem('air.connectionsPageSize', String(pageSize))
  }, [pageSize])
  const [selectedId, setSelectedId] = useState<string>('')
  const [colWidths, setColWidths] = useState<Record<ColumnKey, number>>(loadColumnWidths)
  const [resizingKey, setResizingKey] = useState<ColumnKey | null>(null)
  const colWidthsRef = useRef(colWidths)
  colWidthsRef.current = colWidths
  const dragCleanupRef = useRef<(() => void) | null>(null)
  useEffect(() => () => dragCleanupRef.current?.(), [])

  function startResize(key: ColumnKey, event: React.PointerEvent<HTMLDivElement>) {
    event.preventDefault()
    event.stopPropagation()
    dragCleanupRef.current?.()

    const header = event.currentTarget.closest('th')
    const tableRow = header?.parentElement
    const startX = event.clientX
    let baseWidths = colWidthsRef.current
    if (tableRow) {
      const cells = Array.from(tableRow.querySelectorAll<HTMLTableCellElement>('th[data-col]'))
      if (cells.length === connectionColumns.length) {
        const snapshot = { ...baseWidths }
        for (const cell of cells) {
          const cellKey = cell.dataset.col as ColumnKey | undefined
          if (cellKey) snapshot[cellKey] = clampColumnWidth(cellKey, cell.getBoundingClientRect().width)
        }
        baseWidths = snapshot
      }
    }
    const startWidth = header ? Math.round(header.getBoundingClientRect().width) : baseWidths[key]
    const prevCursor = document.body.style.cursor
    const prevSelect = document.body.style.userSelect
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    setResizingKey(key)

    const onMove = (moveEvent: PointerEvent) => {
      const delta = moveEvent.clientX - startX
      if (Math.abs(delta) < 1) return
      const nextWidth = clampColumnWidth(key, startWidth + delta)
      const next = { ...baseWidths, [key]: nextWidth }
      colWidthsRef.current = next
      setColWidths(next)
    }

    const cleanup = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', finish)
      window.removeEventListener('pointercancel', finish)
      document.body.style.cursor = prevCursor
      document.body.style.userSelect = prevSelect
      dragCleanupRef.current = null
    }

    const finish = () => {
      cleanup()
      setResizingKey(null)
      preferences.setItem('air.connectionsColumnWidths', JSON.stringify(colWidthsRef.current))
    }

    dragCleanupRef.current = cleanup
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', finish)
    window.addEventListener('pointercancel', finish)
  }

  function resetColumnWidth(key: ColumnKey) {
    const col = connectionColumns.find(item => item.key === key)
    if (!col) return
    setColWidths(current => {
      const next = { ...current, [key]: col.defaultWidth }
      colWidthsRef.current = next
      preferences.setItem('air.connectionsColumnWidths', JSON.stringify(next))
      return next
    })
  }
  function toggleSearch() {
    setSearchOpen(open => {
      if (open) {
        setSearch('')
        setPage(1)
        requestAnimationFrame(() => searchButton.current?.focus())
      } else {
        requestAnimationFrame(() => searchInput.current?.focus())
      }
      return !open
    })
  }
  const nodeById = new Map(nodes.map(node => [node.id, node]))
  const draftHops = hops.map(id => nodeById.get(id))
  const draftPath = draftHops.map((node, index) => node?.name ?? tr("第 {0} 跳待选", index + 1))
  const verified = probe && 'ip' in probe ? probe : undefined
  const probeError = probe && 'error' in probe ? probe.error : undefined
  const sourceLogs = telemetry?.connectionLogs ?? telemetry?.connections ?? []
  const records = [
    ...(probe
      ? [
          {
            id: 'verify-chain',
            kind: 'probe' as const,
            app: tr('出口探测'),
            appExecutable: undefined,
            appIcon: undefined,
            target: verified?.ip ?? tr('出口验证服务'),
            rule: chainName || tr("多跳链路（{0} 跳）", hops.length),
            chain: draftPath.join(' → '),
            path: draftPath,
            start: undefined,
            closed: false,
            rejected: false,
            ok: Boolean(verified),
            totalBytes: undefined,
            traffic: tr('整链探测不统计流量'),
            rawConnection: undefined,
          },
        ]
      : []),
    ...sourceLogs.map(conn => {
      const rejected =
        conn.rule.toUpperCase().includes('REJECT') || conn.path.at(-1)?.toUpperCase() === 'REJECT'
      return {
        id: conn.id,
        kind: 'live' as const,
        app: conn.app,
        appExecutable: conn.appExecutable,
        appIcon: conn.appIconKey ? telemetry?.appIcons?.[conn.appIconKey] : undefined,
        target: conn.target,
        rule: conn.rule,
        chain: conn.path.join(' → ') || '—',
        path: conn.path,
        start: conn.start,
        closed: Boolean(conn.closed),
        rejected,
        ok: !rejected,
        totalBytes: conn.downloadBytes + conn.uploadBytes,
        traffic: tr("下载 {0} / 上传 {1}", formatBytes(conn.downloadBytes), formatBytes(conn.uploadBytes)),
        rawConnection: conn,
      }
    }),
  ]

  const q = search.trim().toLowerCase()
  const visible = records.filter(row => {
    if (filter === 'ok' && !row.ok) return false
    if (filter === 'warn' && row.ok) return false
    return !q || [row.app, row.appExecutable, row.target, row.rule, row.chain].some(v => v?.toLowerCase().includes(q))
  })
  const maxPage = Math.max(1, Math.ceil(visible.length / pageSize))
  const page = Math.min(requestedPage, maxPage)
  const paged = visible.slice((page - 1) * pageSize, page * pageSize)
  const hasClosedLogs = records.some(row => row.kind === 'live' && row.closed)

  const active = visible.find(row => row.id === selectedId) ?? paged[0] ?? visible[0]
  const activeConnection = active?.kind === 'live' ? active : undefined
  const showingProbe = active?.kind === 'probe'
  const hopNodes = showingProbe || !proxy.running ? draftHops : proxy.mode === 'direct' ? [] : proxy.outbound?.hops ?? []
  const filledCount = hopNodes.filter(Boolean).length
  const exitNode = hopNodes.at(-1)
  const pathText = active?.chain ?? (filledCount
    ? hopNodes.map((node, index) => node?.name ?? tr("第 {0} 跳待选", index + 1)).join(' → ')
    : proxy.running ? proxy.mode === 'direct' ? tr('直连模式') : tr('按分流规则') : tr('尚未配置多跳链路'))

  const totalWidth = connectionColumns.reduce((sum, col) => sum + colWidths[col.key], 0)
  const rawConn = activeConnection?.rawConnection
  const processLabel = rawConn?.processName ?? activeConnection?.appExecutable
  const modeLabel = proxy.mode === 'rule' ? tr('规则') : proxy.mode === 'global' ? tr('全局') : tr('直连')
  const detailBadge: { variant: 'default' | 'success' | 'danger'; label: string } = activeConnection
    ? activeConnection.rejected
      ? { variant: 'danger', label: tr('已拒绝') }
      : activeConnection.closed
        ? { variant: 'default', label: tr('已结束') }
        : { variant: 'success', label: tr('活跃') }
    : showingProbe
      ? active?.ok
        ? { variant: 'success', label: tr('已连通') }
        : { variant: 'danger', label: tr('探测失败') }
      : verified
        ? { variant: 'success', label: tr('已验证') }
        : { variant: 'default', label: tr('待验证') }

  function copyText(text: string, label: string) {
    if (!navigator.clipboard) {
      showMessage({ type: 'error', title: tr('当前环境不支持剪贴板') })
      return
    }
    void navigator.clipboard.writeText(text)
      .then(() => showMessage({ type: 'success', title: tr("已复制{0}", label) }))
      .catch(() => showMessage({ type: 'error', title: tr("复制{0}失败", label) }))
  }

  const toolButtonClass =
    'relative grid size-7 place-items-center rounded-[6px] outline-none transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-ring/60 [&_svg]:size-[15px] [&_svg]:stroke-[1.9]'

  return (
    <section className="air-scroll flex h-full min-h-0 flex-col gap-3 overflow-y-auto px-5 py-4 lg:overflow-hidden">
      <header className="@container flex min-h-11 shrink-0 items-center justify-between gap-2.5">
        <div className="flex min-w-0 items-center gap-4 whitespace-nowrap">
          <div className="flex shrink-0 items-center gap-2.5">
            <PageHeaderIcon kind="connections" animateKey={visitKey} />
            <h1 className="shrink-0 whitespace-nowrap text-[26px] font-bold leading-tight tracking-tight text-foreground">{tr("连接日志")}</h1>
          </div>
          <TraceLines variant="connections" className="sm:hidden @[46rem]:block" />
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <AnimatePresence initial={false}>
            {searchOpen && (
              <motion.div
                key="conn-search-box"
                initial={{ opacity: 0, width: 0, x: 14, scale: 0.94 }}
                animate={{ opacity: 1, width: 'auto', x: 0, scale: 1 }}
                exit={{ opacity: 0, width: 0, x: 12, scale: 0.94 }}
                transition={{
                  width: { type: 'spring', stiffness: 420, damping: 32 },
                  x: { type: 'spring', stiffness: 420, damping: 30 },
                  scale: { type: 'spring', stiffness: 460, damping: 32 },
                  opacity: { duration: 0.16, ease: 'easeOut' },
                }}
                className="-m-0.5 overflow-hidden p-0.5"
              >
                <div className="relative w-[152px] @[36rem]:w-[196px]">
                  <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-primary/80" />
                  <Input
                    ref={searchInput}
                    value={search}
                    onChange={e => {
                      setSearch(e.target.value)
                      setPage(1)
                    }}
                    onKeyDown={event => {
                      if (event.key === 'Escape') toggleSearch()
                    }}
                    placeholder={tr("筛选目标或链路")}
                    aria-label={tr("筛选连接记录")}
                    className={cn(
                      'h-8.5 border-accent-border/80 bg-card pl-8 shadow-xs transition-[border-color,box-shadow]',
                      search ? 'pr-7' : 'pr-2.5',
                    )}
                  />
                  {search && (
                    <button
                      type="button"
                      aria-label={tr('清空搜索')}
                      onClick={() => {
                        setSearch('')
                        setPage(1)
                        searchInput.current?.focus()
                      }}
                      className="absolute top-1/2 right-1.5 grid size-5 -translate-y-1/2 place-items-center rounded-[4px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                    >
                      <X className="size-3" />
                    </button>
                  )}
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          <div
            role="group"
            aria-label={tr('连接常用操作')}
            className="inline-flex h-8.5 shrink-0 items-center gap-0.5 rounded-[8px] border border-border bg-secondary p-0.5 whitespace-nowrap shadow-xs"
          >
            <span
              title={proxy.running ? tr('内核运行中') : tr('内核未启动')}
              className="inline-flex h-7 shrink-0 items-center gap-1.5 px-2 text-xs font-medium whitespace-nowrap text-foreground"
            >
              <span
                className={cn(
                  'size-1.5 rounded-full',
                  proxy.running ? 'bg-success motion-safe:animate-pulse' : 'bg-icon-muted',
                )}
              />
              <span className="hidden @[30rem]:inline">{proxy.running ? tr('内核运行中') : tr('内核未启动')}</span>
            </span>

            <Separator orientation="vertical" className="mx-0.5 h-4 bg-border" />

            <motion.button
              ref={searchButton}
              type="button"
              aria-label={searchOpen ? tr('收起搜索') : tr('筛选连接')}
              title={searchOpen ? tr('收起搜索') : tr('筛选连接记录')}
              aria-pressed={searchOpen}
              whileHover={{ scale: 1.05 }}
              whileTap={{ scale: 0.92 }}
              transition={{ type: 'spring', stiffness: 520, damping: 28 }}
              onMouseEnter={() => setHoveredTool('search')}
              onMouseLeave={() => setHoveredTool(prev => (prev === 'search' ? null : prev))}
              onClick={toggleSearch}
              className={cn(
                toolButtonClass,
                searchOpen || search.trim()
                  ? 'bg-accent-soft text-primary'
                  : 'text-secondary-foreground hover:bg-accent-soft/80 hover:text-primary',
              )}
            >
              <motion.span
                className="grid place-items-center"
                animate={hoveredTool === 'search' ? { rotate: -12, scale: 1.08 } : { rotate: 0, scale: 1 }}
                transition={{ type: 'spring', stiffness: 460, damping: 24 }}
              >
                <Search />
              </motion.span>
              {!searchOpen && search.trim() && (
                <span aria-hidden="true" className="pointer-events-none absolute top-1 right-1 size-1.5 rounded-full bg-primary" />
              )}
            </motion.button>

            {onClearLogs && (
              <motion.button
                type="button"
                disabled={!hasClosedLogs}
                aria-label={tr('清空已结束记录')}
                title={tr('清空已结束的连接记录')}
                whileHover={hasClosedLogs ? { scale: 1.05 } : undefined}
                whileTap={hasClosedLogs ? { scale: 0.92 } : undefined}
                transition={{ type: 'spring', stiffness: 520, damping: 28 }}
                onMouseEnter={() => setHoveredTool('clear')}
                onMouseLeave={() => setHoveredTool(prev => (prev === 'clear' ? null : prev))}
                onClick={() => {
                  setPage(1)
                  onClearLogs()
                }}
                className={cn(
                  toolButtonClass,
                  hasClosedLogs
                    ? 'text-secondary-foreground hover:bg-destructive/10 hover:text-destructive'
                    : 'cursor-not-allowed text-muted-foreground/45',
                )}
              >
                <motion.span
                  className="grid place-items-center"
                  animate={hoveredTool === 'clear' && hasClosedLogs ? { scale: 1.08 } : { scale: 1 }}
                  transition={{ type: 'spring', stiffness: 460, damping: 24 }}
                >
                  <Trash2 />
                </motion.span>
              </motion.button>
            )}

            <Separator orientation="vertical" className="mx-0.5 h-4 bg-border" />

            <motion.button
              type="button"
              aria-label={tr('测整链')}
              title={tr('编排并测整链')}
              whileHover={{ scale: 1.05 }}
              whileTap={{ scale: 0.92 }}
              transition={{ type: 'spring', stiffness: 520, damping: 28 }}
              onMouseEnter={() => setHoveredTool('chain')}
              onMouseLeave={() => setHoveredTool(prev => (prev === 'chain' ? null : prev))}
              onClick={onOpenChain}
              className={cn(
                toolButtonClass,
                'bg-accent-soft/80 text-primary hover:bg-primary hover:text-primary-foreground',
              )}
            >
              <motion.span
                className="grid place-items-center"
                animate={hoveredTool === 'chain' ? { rotate: 18, scale: 1.08 } : { rotate: 0, scale: 1 }}
                transition={{ type: 'spring', stiffness: 400, damping: 22 }}
              >
                <Waypoints />
              </motion.span>
            </motion.button>
          </div>
        </div>
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-1 grid-rows-[auto_auto] gap-3 lg:grid-cols-[minmax(0,1fr)_336px] lg:grid-rows-1 xl:grid-cols-[minmax(0,1fr)_360px]">
        <Card className="min-h-[21rem] min-w-0 gap-3 p-4 lg:min-h-0">
          <CardHeader className="flex-wrap gap-2">
            <div className="flex min-w-0 items-center gap-2 whitespace-nowrap">
              <Activity className="size-4 shrink-0 text-primary" />
              <CardTitle className="truncate">{telemetry?.stale ? tr('探测与最近采样') : tr('探测与连接记录')}</CardTitle>
              <Badge variant="default" className="mono shrink-0">
                {visible.length}
              </Badge>
            </div>
            <Segmented
              layoutId="connections-filter"
              ariaLabel={tr("连接状态筛选")}
              className="shrink-0"
              value={filter}
              options={filterOptions}
              onChange={next => {
                setFilter(next)
                setPage(1)
              }}
            />
          </CardHeader>

          <ContextMenu>
            <ContextMenuTrigger render={<CardContent className="min-h-0 min-w-0 flex-1" />}>
              {paged.length > 0 ? (
                <Table
                  aria-label={tr("探测与连接记录")}
                  containerClassName="min-h-0 flex-1"
                  className="table-fixed"
                  style={{ width: totalWidth, minWidth: '100%' }}
                >
                  <colgroup>
                    {connectionColumns.map(col => (
                      <col key={col.key} style={{ width: colWidths[col.key] }} />
                    ))}
                  </colgroup>
                  <TableHeader>
                    <TableRow className="[&>th]:text-center">
                      {connectionColumns.map(col => (
                        <TableHead key={col.key} data-col={col.key} className="relative px-2.5">
                          <span className="block truncate">{col.label}</span>
                          <div
                            role="separator"
                            aria-orientation="vertical"
                            aria-label={tr('调整「{0}」列宽', col.label)}
                            title={tr('拖动调整列宽，双击重置')}
                            onPointerDown={event => startResize(col.key, event)}
                            onDoubleClick={event => {
                              event.stopPropagation()
                              resetColumnWidth(col.key)
                            }}
                            className="group/resize absolute top-0 -right-1.5 z-20 flex h-full w-3 cursor-col-resize items-center justify-center select-none touch-none"
                          >
                            <span
                              className={cn(
                                'h-4 w-px rounded-full bg-border/80 transition-[width,height,background-color] duration-150 group-hover/resize:h-5 group-hover/resize:w-[2px] group-hover/resize:bg-primary',
                                resizingKey === col.key && 'h-5 w-[2px] bg-primary',
                              )}
                            />
                          </div>
                        </TableHead>
                      ))}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {paged.map(row => {
                      const badgeVariant = row.kind === 'probe'
                        ? (row.ok ? 'success' : 'danger')
                        : row.rejected
                          ? 'danger'
                          : row.closed
                            ? 'default'
                            : 'success'
                      const badgeLabel = row.kind === 'probe'
                        ? (row.ok ? tr('已连通') : tr('探测失败'))
                        : row.rejected
                          ? tr('已拒绝')
                          : row.closed
                            ? tr('已结束')
                            : tr('活跃')
                      return (
                        <ContextMenu key={row.id}>
                          <ContextMenuTrigger
                            render={
                              <TableRow
                                data-selected={active?.id === row.id}
                                tabIndex={0}
                                onClick={() => setSelectedId(row.id)}
                                onKeyDown={event => {
                                  if (event.key === 'Enter' || event.key === ' ') {
                                    event.preventDefault()
                                    setSelectedId(row.id)
                                  }
                                }}
                                onDoubleClick={() => {
                                  if (row.rawConnection && onConfigureConnection) {
                                    onConfigureConnection(row.rawConnection)
                                  }
                                }}
                                className="cursor-pointer outline-none focus-visible:bg-primary/15 [&[data-selected=true]>td:first-child]:shadow-[inset_3px_0_0_var(--primary)] [&[data-selected=true]>td]:border-b-primary/20"
                              >
                                <TableCell className="px-2.5">
                                  <ConnectionApp name={row.app} executable={row.appExecutable} icon={row.appIcon} />
                                </TableCell>
                                <TableCell className="mono truncate px-2.5" title={row.target}>
                                  {row.target}
                                </TableCell>
                                <TableCell className="truncate px-2.5 text-center text-muted-foreground" title={row.chain}>
                                  <FlagText text={row.chain} />
                                </TableCell>
                                <TableCell className="mono overflow-hidden px-2 text-center text-[12px] text-muted-foreground">
                                  {formatLogTime(row.start)}
                                </TableCell>
                                <TableCell className="overflow-hidden px-2 text-center">
                                  <Badge variant={badgeVariant}>
                                    {badgeLabel}
                                  </Badge>
                                </TableCell>
                                <TableCell className="mono overflow-hidden px-2 text-center" title={row.traffic}>
                                  {row.totalBytes === undefined ? '—' : formatBytes(row.totalBytes)}
                                </TableCell>
                              </TableRow>
                            }
                          />
                          <ContextMenuContent>
                            <ContextMenuItem onClick={() => setSelectedId(row.id)}>
                              <Activity />{tr("查看连接诊断")}</ContextMenuItem>
                            {row.rawConnection && onConfigureConnection && (
                              <ContextMenuItem onClick={() => onConfigureConnection(row.rawConnection!)}>
                                <Shield />{tr("分流策略")}</ContextMenuItem>
                            )}
                            <ContextMenuSeparator />
                            <ContextMenuItem onClick={() => copyText(row.target, tr('目标地址'))}>
                              <Copy />{tr("复制目标地址")}</ContextMenuItem>
                            <ContextMenuItem onClick={() => copyText(row.chain, tr('链路路径'))}>
                              <Copy />{tr("复制链路路径")}</ContextMenuItem>
                            <ContextMenuSeparator />
                            <ContextMenuItem onClick={onOpenChain}>
                              <Waypoints />{tr("编辑当前链路")}</ContextMenuItem>
                          </ContextMenuContent>
                        </ContextMenu>
                      )
                    })}
                  </TableBody>
                </Table>
              ) : (
                <div className="flex min-h-[15rem] flex-1 flex-col items-center justify-center gap-3 rounded-[9px] border border-dashed border-border bg-muted/25 p-5 text-center sm:p-6">
                  <div className="grid size-11 place-items-center rounded-full bg-accent-soft text-primary">
                    <Waypoints className="size-5" />
                  </div>
                  <div className="flex flex-col gap-1">
                    <strong className="text-sm font-semibold text-foreground">
                      {records.length ? tr('没有匹配的连接记录') : tr('暂无整链探测与连接记录')}
                    </strong>
                    <p className="max-w-xs text-xs text-muted-foreground">
                      {records.length
                        ? tr('请尝试调整筛选条件或清除搜索关键字。')
                        : tr('在节点库打开「链路」并从左侧依次点选各跳节点后，点击「测整链」或开启代理即可在此核验路径与连接状态。')}
                    </p>
                  </div>
                  {!records.length && (
                    <Button variant="subtle" onClick={onOpenChain}>
                      <Waypoints data-icon="inline-start" />{tr("前往编排并测整链")}</Button>
                  )}
                </div>
              )}
            </ContextMenuTrigger>

            <ContextMenuContent>
              <ContextMenuItem onClick={onOpenChain}>
                <Waypoints />{tr("编辑当前链路")}</ContextMenuItem>
              {(search || filter !== 'all') && (
                <>
                  <ContextMenuSeparator />
                  <ContextMenuItem
                    onClick={() => {
                      setSearch('')
                      setFilter('all')
                      setPage(1)
                    }}
                  >
                    <Search />{tr("重置筛选条件")}</ContextMenuItem>
                </>
              )}
            </ContextMenuContent>
          </ContextMenu>

          {visible.length > 0 && (
            <footer className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-border-subtle pt-2.5 text-xs text-muted-foreground">
              <span className="tabular-nums">
                {tr('共 {0} 条 · 第 {1} / {2} 页', visible.length, page, maxPage)}
              </span>
              <div className="flex items-center gap-1.5">
                <AirSelect
                  label={tr('每页条数')}
                  value={String(pageSize)}
                  options={logPageSizes}
                  onChange={next => {
                    setPageSize(Number(next))
                    setPage(1)
                  }}
                  side="top"
                  align="end"
                  className="h-7 w-[116px] px-2 text-xs"
                />
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
            </footer>
          )}
        </Card>

        <Card className="min-h-0 gap-3.5 p-4">
          <CardHeader>
            <div className="flex items-center gap-2">
              <Globe className="size-4 text-primary" />
              <CardTitle>{activeConnection ? tr('连接详情') : tr('连接诊断')}</CardTitle>
            </div>
            <Badge variant={detailBadge.variant}>
              {detailBadge.label}
            </Badge>
          </CardHeader>

          <div className="flex items-center gap-3 rounded-[9px] border border-border bg-muted/55 p-3 dark:bg-[#252730]">
            {activeConnection ? (
              <div className="grid size-9 shrink-0 place-items-center rounded-[8px] border border-border/80 bg-background/85">
                {activeConnection.appIcon ? (
                  <img src={activeConnection.appIcon} alt="" draggable={false} className="size-6 object-contain" />
                ) : (
                  <AppWindow aria-hidden="true" className="size-4.5 text-muted-foreground" />
                )}
              </div>
            ) : (
              <div className="grid size-9 shrink-0 place-items-center rounded-[8px] bg-accent-soft text-primary">
                <Layers className="size-4" />
              </div>
            )}
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <strong
                className="truncate text-xs font-semibold text-foreground"
                title={activeConnection ? activeConnection.app : active ? `${active.app} · ${active.target}` : pathText}
              >
                {activeConnection ? activeConnection.app : active ? `${active.app} · ${active.target}` : pathText}
              </strong>
              <span
                className={cn(
                  'truncate text-xs text-muted-foreground',
                  activeConnection && 'mono',
                )}
                title={activeConnection ? activeConnection.target : (active?.rule || (proxy.running ? proxy.outbound?.name : chainName) || pathText)}
              >
                {activeConnection ? activeConnection.target : (active?.rule || (proxy.running ? proxy.outbound?.name : chainName) || pathText)}
              </span>
            </div>
          </div>

          <div className="air-scroll flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto pr-0.5">
            {activeConnection ? (
              <div className="flex flex-col divide-y divide-border-subtle rounded-[9px] border border-border bg-muted/25 px-3 py-0.5 text-xs dark:bg-muted/20">
                <DetailItem
                  label={tr('来源 / 应用')}
                  copyValue={processLabel && processLabel !== activeConnection.app ? processLabel : undefined}
                  copyLabel={tr('复制进程名')}
                  onCopy={copyText}
                >
                  <span>{activeConnection.app}</span>
                  {processLabel && processLabel !== activeConnection.app && (
                    <span className="mono mt-0.5 block text-[11px] font-normal text-muted-foreground">
                      {tr('进程文件')}：{processLabel}
                    </span>
                  )}
                </DetailItem>

                {rawConn?.processPath && (
                  <DetailItem
                    label={tr('程序路径')}
                    copyValue={rawConn.processPath}
                    copyLabel={tr('复制程序路径')}
                    onCopy={copyText}
                  >
                    <span className="mono text-[11px]">{rawConn.processPath}</span>
                  </DetailItem>
                )}

                <DetailItem
                  label={tr('出口目标')}
                  copyValue={activeConnection.target}
                  copyLabel={tr('复制目标地址')}
                  onCopy={copyText}
                >
                  <span className="mono">{activeConnection.target}</span>
                </DetailItem>

                {rawConn?.host && rawConn.host !== activeConnection.target && (
                  <DetailItem label={tr('目标主机')}>
                    <span className="mono">{rawConn.host}</span>
                  </DetailItem>
                )}

                {rawConn?.destinationIp &&
                  rawConn.destinationIp !== rawConn.host &&
                  rawConn.destinationIp !== activeConnection.target && (
                    <DetailItem label={tr('目标 IP')}>
                      <span className="mono">{rawConn.destinationIp}</span>
                    </DetailItem>
                  )}

                {rawConn?.network && (
                  <DetailItem label={tr('网络协议')}>
                    <span className="mono">{rawConn.network.toUpperCase()}</span>
                  </DetailItem>
                )}

                <DetailItem label={tr('状态')}>
                  <div className="flex flex-wrap items-center gap-2 pt-0.5">
                    <Badge variant={detailBadge.variant}>{detailBadge.label}</Badge>
                    <span className="text-muted-foreground">
                      {tr('当前模式')}：{modeLabel}
                    </span>
                  </div>
                </DetailItem>

                <DetailItem label={tr('命中规则')}>
                  <span>{activeConnection.rule || '—'}</span>
                </DetailItem>

                <DetailItem
                  label={tr('链路路径')}
                  copyValue={activeConnection.chain}
                  copyLabel={tr('复制链路路径')}
                  onCopy={copyText}
                >
                  <FlagText text={activeConnection.chain} />
                  <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] font-normal text-muted-foreground">
                    <span>{tr('路径节点')}：<b className="mono font-medium text-foreground">{activeConnection.path.length || '—'}</b></span>
                    <span className="min-w-0 truncate">
                      {tr('末跳出口')}：<FlagText text={activeConnection.path.at(-1) ?? '—'} />
                    </span>
                  </div>
                </DetailItem>

                <DetailItem label={tr('时间')}>
                  <span className="mono">{formatLogTime(activeConnection.start)}</span>
                </DetailItem>

                <DetailItem label={tr('累计流量')}>
                  <span className="mono font-semibold">{formatBytes(activeConnection.totalBytes ?? 0)}</span>
                  <span className="mono mt-0.5 block text-[11px] font-normal text-muted-foreground">
                    {activeConnection.traffic}
                  </span>
                </DetailItem>
              </div>
            ) : (
              <div className="flex flex-col divide-y divide-border-subtle rounded-[9px] border border-border bg-muted/25 px-3 py-0.5 text-xs dark:bg-muted/20">
                <DetailItem label={showingProbe ? tr('探测出口 IP') : tr('目标地址')}>
                  <span className="mono">{showingProbe && verified ? verified.ip : active?.target ?? '—'}</span>
                </DetailItem>
                <DetailItem label={tr('状态')}>
                  <div className="flex flex-wrap items-center gap-2 pt-0.5">
                    <Badge variant={detailBadge.variant}>{detailBadge.label}</Badge>
                    <span className="text-muted-foreground">{tr('当前模式')}：{modeLabel}</span>
                  </div>
                </DetailItem>
                <DetailItem label={tr('总跳数')}>
                  <span className="mono">{tr('{0} / {1} 跳', filledCount, hopNodes.length)}</span>
                </DetailItem>
                <DetailItem label={tr('末跳出口')}>
                  <FlagText text={exitNode ? `${exitNode.name} (${exitNode.source})` : tr('未选择')} />
                </DetailItem>
                <DetailItem label={tr('链路路径')}>
                  <FlagText text={pathText} />
                </DetailItem>
              </div>
            )}

            <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              {activeConnection ? tr('内核报告的出站路径') : tr('链路诊断阶段')}
            </span>

            {activeConnection ? activeConnection.path.map((name, index) => (
              <div key={`${index}:${name}`} className="flex items-center gap-2.5">
                <Waypoints className="size-4 shrink-0 text-primary" />
                <span className="truncate text-xs font-medium" title={name}>
                  <FlagText text={name} />
                </span>
              </div>
            )) : hopNodes.map((node, index) => {
              const role = hopRoleLabel(index, hopNodes.length)
              return (
                <div key={index} className="flex items-start gap-2.5">
                  {node ? (
                    <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" />
                  ) : (
                    <MinusCircle className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                  )}
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <strong className={cn('text-xs font-semibold', node ? 'text-success' : 'text-foreground')}>{tr('第 {0} 跳 · {1}', index + 1, role)}
                      {node ? tr('已就绪') : tr('待选择')}
                    </strong>
                    <span className="truncate text-xs text-muted-foreground">
                      <FlagText
                        text={
                          node
                            ? `${node.name} · ${formatProtocol(node.protocol)} (${node.source})`
                            : tr('请在节点库左侧点选填入该跳')
                        }
                      />
                    </span>
                  </div>
                </div>
              )
            })}

            {showingProbe && probeError && (
              <div className="flex items-start gap-2.5">
                <AlertCircle className="mt-0.5 size-4 shrink-0 text-destructive" />
                <span className="break-words text-xs text-destructive">{probeError}</span>
              </div>
            )}

            {showingProbe && verified && (
              <div className="flex items-start gap-2.5">
                <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" />
                <div className="flex min-w-0 flex-col gap-0.5">
                  <strong className="text-xs font-semibold text-success">{tr("整链出口连通正常")}</strong>
                  <span className="mono text-xs text-muted-foreground">{tr('出口 IP {0} · 耗时 {1} ms', verified.ip, verified.latencyMs)}
                  </span>
                </div>
              </div>
            )}
          </div>

          <Separator />

          <div className="grid auto-cols-fr grid-flow-col gap-2">
            {activeConnection?.rawConnection && onConfigureConnection && (
              <Button
                size="sm"
                variant="secondary"
                title={tr('分流策略')}
                className="h-8 w-full min-w-0 px-2 text-xs"
                onClick={() => onConfigureConnection(activeConnection.rawConnection!)}
              >
                <Shield data-icon="inline-start" />
                <span className="truncate">{tr('分流策略')}</span>
              </Button>
            )}
            <Button
              size="sm"
              variant="secondary"
              title={tr('编辑链路')}
              className="h-8 w-full min-w-0 px-2 text-xs"
              onClick={onOpenChain}
            >
              <Waypoints data-icon="inline-start" />
              <span className="truncate">{tr("编辑链路")}</span>
            </Button>
            <Button
              size="sm"
              variant="default"
              title={tr('重测整链')}
              className="h-8 w-full min-w-0 px-2 text-xs"
              onClick={onOpenChain}
            >
              <Activity data-icon="inline-start" />
              <span className="truncate">{tr("重测整链")}</span>
            </Button>
          </div>
        </Card>
      </div>
    </section>
  )
}
