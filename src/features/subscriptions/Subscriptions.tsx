import { useDesktopBinding } from '@/features/settings/useDesktopBinding'
import { formatLocale, diagnostic, tr } from '@/shared/i18n/messages'
import {
  Check, ArrowDown, ArrowUp, CloudDownload, CalendarClock, ChevronRight, Download, Eye, Loader2, Puzzle, QrCode,
  FileCode2,
  Layers,
  Link,
  MoreHorizontal,
  Pencil,
  Plus,
  RefreshCw,
  Server,
  Trash2,
} from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { useMemo, useRef, useState, type Dispatch, type FormEvent, type SetStateAction } from 'react'
import { cn, formatDateTime, formatProtocol } from '@/shared/lib/utils'
import { Badge } from '@/shared/ui/badge'
import { Button } from '@/shared/ui/button'
import { Card } from '@/shared/ui/card'
import { FlagText } from '@/shared/ui/FlagText'
import { ResizableSidePanel } from '@/shared/ui/ResizableSidePanel'
import { showMessage } from '@/shared/ui/message'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/shared/ui/context-menu'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/shared/ui/dropdown-menu'
import { Input } from '@/shared/ui/input'
import { Menu } from '@base-ui/react/menu'
import { SubscriptionTool, type SubscriptionToolData } from '@/shared/ui/SubscriptionTool'
import { useSubscriptionOrder } from '@/shared/proxy/useSubscriptionOrder'
import { downloadSubscription } from '@/shared/proxy/subscription-extension'
import { Label } from '@/shared/ui/label'
import { Separator } from '@/shared/ui/separator'
import { Textarea } from '@/shared/ui/textarea'
import { TraceLines } from '@/shared/ui/TraceLines'
import { PageHeaderIcon } from '@/shared/ui/PageHeaderIcon'
import {
  air,
  type NodeRecord,
  type SubscriptionGroup,
  type SubscriptionSource,
} from '@/platform/desktop/air'
import { AirCheckbox } from '../../shared/ui/AirCheckbox'
import { AirSelect } from '../../shared/ui/AirSelect'
import type { Nodes } from '../nodes/useNodes'
import { SubscriptionDialog } from './SubscriptionDialog'
import { CopySubscriptionLink, useCopyFeedback } from '@/shared/ui/CopySubscriptionLink'
import { SubscriptionImport } from './SubscriptionImport'
import { usePendingSubscriptionImports } from './importTasks'

interface Props {
  visitKey?: number
  store: Nodes
  selected: string[]
  onSelectedChange: Dispatch<SetStateAction<string[]>>
  onError: (error: unknown) => void
  onYaml: (id: string) => void
  onNode: (node: NodeRecord) => void
  onSourceDeleted: (id: string) => void
}

const strategyLabels: Record<string, string> = {
  get select() { return tr('手动选择') },
  get 'url-test'() { return tr('自动测速') },
  get fallback() { return tr('故障转移') },
  get 'load-balance'() { return tr('负载均衡') },
}

const sourceKinds: Record<string, string> = {
  get url() { return tr('URL 链接') },
  get qr() { return tr('二维码') },
  get file() { return tr('本地文件') },
  get custom() { return tr('自定义') },
}
const formatGb = (bytes: number) =>
  (bytes / 1024 ** 3).toLocaleString(formatLocale, { maximumFractionDigits: 1 })

type DialogState =
  | { kind: 'source'; source: SubscriptionSource; url: string }
  | { kind: 'group'; group: SubscriptionGroup }
  | { kind: 'delete'; source: SubscriptionSource; item?: SubscriptionGroup | NodeRecord }

export function Subscriptions({
  visitKey,
  store,
  selected,
  onSelectedChange,
  onError,
  onYaml,
  onNode,
  onSourceDeleted,
}: Props) {
  const [showImport, setShowImport] = useState(false)
  const [dialog, setDialog] = useState<DialogState>()
  const [refreshing, setRefreshing] = useState<string[]>([])
  const refreshingSet = useRef(new Set<string>())
  const [hoveredTool, setHoveredTool] = useState<'refresh' | 'import' | 'source-import' | null>(null)
  const [tool, setTool] = useState<{ name: string; data: SubscriptionToolData }>()
  const pendingImports = usePendingSubscriptionImports()
  async function openTool(source: SubscriptionSource, kind: SubscriptionToolData['kind'] | 'export') {
    const id = source.id
    try {
      let data: SubscriptionToolData
      if (kind === 'qr') {
        const url = await air.subscriptionUrl(id)
        if (!url) throw new Error(tr('此来源没有订阅链接'))
        data = { kind, url }
      } else if (kind === 'export') {
        downloadSubscription(source.name, await air.subscriptionYaml(id, false))
        showMessage({ type: 'success', title: tr('订阅文件已导出') })
        return
      } else if (kind === 'runtime') {
        data = { kind, yaml: await air.subscriptionYaml(id, true) }
      } else if (kind === 'extension') {
        data = { kind, extension: await air.subscriptionExtension(id), save: async ext => {
          await air.saveSubscriptionExtension(id, ext)
          await store.refresh()
        } }
      } else {
        data = { kind, enabled: source.details?.autoUpdate ?? true, hours: source.details?.customHours,
          provider: source.details?.intervalHours, save: async (enabled, hours) => {
            await air.subscriptionPolicy(id, enabled, hours)
            await store.refresh()
          } }
      }
      setTool({ name: source.name, data })
    } catch (error) { onError(error) }
  }

  const [allNodes, setAllNodes] = useState(false)
  const [allGroups, setAllGroups] = useState(false)

  const sourceList = useMemo(
    () =>
      store.library.sources.filter(
        source => source.id !== 'custom' && source.details?.kind !== 'custom',
      ),
    [store.library.sources],
  )
  const { sorted: sources, move } = useSubscriptionOrder(sourceList)
  const libraryGroups = useMemo(
    () => store.library.groups.filter(group => group.sourceId !== 'custom'),
    [store.library.groups],
  )
  const libraryNodes = useMemo(
    () => store.library.nodes.filter(node => node.sourceId !== 'custom'),
    [store.library.nodes],
  )
  const sourceById = new Map(sources.map(source => [source.id, source]))
  const chosen = sources.filter(source => selected.includes(source.id))
  const nodes = libraryNodes.filter(node => selected.includes(node.sourceId))
  const groups = libraryGroups.filter(group => selected.includes(group.sourceId))
  const remote = sources.filter(source => source.details && source.details.kind !== 'file')

  function refresh(items: SubscriptionSource[]) {
    const targets = items.filter(
      source => source.details && source.details.kind !== 'file' && !refreshingSet.current.has(source.id),
    )
    if (!targets.length) return

    for (const source of targets) refreshingSet.current.add(source.id)
    setRefreshing([...refreshingSet.current])

    const single = items.length === 1 && targets.length === 1
    let succeeded = 0
    const errors: string[] = []

    const jobs = targets.map(async source => {
      try {
        await air.refreshSubscription(source.id)
        succeeded++
        await store.refresh()
        if (single) {
          showMessage({ type: 'success', title: tr('已同步「{0}」', source.name) })
        }
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        errors.push(`${source.name}：${reason}`)
        await store.refresh().catch(() => undefined)
        if (single) {
          onError(`${source.name}：${reason}`)
        }
      } finally {
        refreshingSet.current.delete(source.id)
        setRefreshing([...refreshingSet.current])
      }
    })

    if (!single) {
      void Promise.allSettled(jobs).then(() => {
        if (errors.length) onError(errors.join('；'))
        else if (succeeded) showMessage({ type: 'success', title: tr('全部订阅已同步') })
      })
    }
  }

  async function editSource(source: SubscriptionSource) {
    try {
      setDialog({ kind: 'source', source, url: (await air.subscriptionUrl(source.id)) ?? '' })
    } catch (error) {
      onError(error)
    }
  }

  const { copied, copy } = useCopyFeedback()
  async function copySubscriptionUrl(source: SubscriptionSource) {
    try {
      const url = await air.subscriptionUrl(source.id)
      if (!url) {
        onError(tr('该来源没有可复制的订阅链接'))
        return
      }
      await copy(source.id, url)
      showMessage({ type: 'success', title: tr('订阅链接已复制') })
    } catch (error) {
      onError(error)
    }
  }

  function deleteItem(item: SubscriptionGroup | NodeRecord) {
    const source = sourceById.get(item.sourceId)
    if (source) setDialog({ kind: 'delete', source, item })
  }

  const canRefreshAll = remote.some(source => !refreshing.includes(source.id))
  const toolButtonClass =
    'relative grid size-7 place-items-center rounded-[6px] outline-none transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-ring/60 [&_svg]:size-[15px] [&_svg]:stroke-[1.9]'

  return (
    <section className="flex h-full min-h-0 flex-col gap-3 px-5 py-4">
      <header className="flex min-h-11 shrink-0 items-center justify-between gap-3">
        <div className="flex items-center gap-4 whitespace-nowrap">
          <div className="flex items-center gap-2.5">
            <PageHeaderIcon kind="subscriptions" animateKey={visitKey} />
            <h1 className="text-[26px] font-bold leading-tight tracking-tight text-foreground">{tr("订阅")}</h1>
          </div>
          <TraceLines variant="subscriptions" />
        </div>
        <div
          role="group"
          aria-label={tr('订阅常用操作')}
          className="inline-flex h-8.5 items-center gap-0.5 rounded-[8px] border border-border bg-secondary p-0.5 shadow-xs"
        >
          <motion.button
            type="button"
            disabled={!canRefreshAll}
            aria-busy={Boolean(refreshing.length)}
            aria-label={refreshing.length ? tr('正在同步订阅') : tr('刷新全部')}
            title={refreshing.length ? tr('正在同步订阅…') : tr('刷新全部订阅')}
            whileHover={!canRefreshAll ? undefined : { scale: 1.05 }}
            whileTap={!canRefreshAll ? undefined : { scale: 0.92 }}
            transition={{ type: 'spring', stiffness: 520, damping: 28 }}
            onMouseEnter={() => setHoveredTool('refresh')}
            onMouseLeave={() => setHoveredTool(prev => (prev === 'refresh' ? null : prev))}
            onClick={() => void refresh(remote)}
            className={cn(
              toolButtonClass,
              'text-secondary-foreground hover:bg-accent-soft/80 hover:text-primary disabled:pointer-events-none disabled:opacity-40',
            )}
          >
            {refreshing.length ? (
              <RefreshCw className="animate-spin text-primary" />
            ) : (
              <motion.span
                className="grid place-items-center"
                animate={hoveredTool === 'refresh' && canRefreshAll ? { rotate: 180, scale: 1.06 } : { rotate: 0, scale: 1 }}
                transition={{ type: 'spring', stiffness: 360, damping: 24 }}
              >
                <RefreshCw />
              </motion.span>
            )}
          </motion.button>

          <Separator orientation="vertical" className="mx-0.5 h-4 bg-border" />

          <motion.button
            type="button"
            aria-label={tr('导入订阅')}
            title={tr('导入订阅')}
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.92 }}
            transition={{ type: 'spring', stiffness: 520, damping: 28 }}
            onMouseEnter={() => setHoveredTool('import')}
            onMouseLeave={() => setHoveredTool(prev => (prev === 'import' ? null : prev))}
            onClick={() => setShowImport(true)}
            className={cn(
              toolButtonClass,
              'bg-accent-soft/80 text-primary hover:bg-primary hover:text-primary-foreground',
            )}
          >
            <motion.span
              className="grid place-items-center"
              animate={hoveredTool === 'import' ? { rotate: 90, scale: 1.08 } : { rotate: 0, scale: 1 }}
              transition={{ type: 'spring', stiffness: 460, damping: 24 }}
            >
              <Plus />
            </motion.span>
          </motion.button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1 flex-col gap-3 lg:flex-row">
        <ResizableSidePanel
          storageKey="air.subscriptionListWidth"
          defaultWidth={276}
          minWidth={228}
          maxWidth={460}
          reservedRightWidth={340}
          ariaLabel={tr('调整订阅来源栏宽度')}
          animated={false}
          responsiveDesktopOnly
          className="max-lg:max-h-[min(18rem,38dvh)]"
        >
        <Card className="h-full min-h-0 min-w-0 gap-2.5 p-3">
          <header className="flex items-center justify-between gap-2">
            <div className="flex min-w-0 items-baseline gap-2">
              <h2 className="truncate text-base font-semibold text-foreground">{tr("订阅来源")}</h2>
              <span className="shrink-0 text-xs text-muted-foreground">{sources.length}{tr(" 个")}</span>
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              <motion.button
                type="button"
                aria-label={tr('导入订阅')}
                title={tr('导入订阅')}
                whileHover={{ scale: 1.06 }}
                whileTap={{ scale: 0.92 }}
                transition={{ type: 'spring', stiffness: 520, damping: 28 }}
                onMouseEnter={() => setHoveredTool('source-import')}
                onMouseLeave={() => setHoveredTool(prev => (prev === 'source-import' ? null : prev))}
                onClick={() => setShowImport(true)}
                className="grid size-6 shrink-0 place-items-center rounded-[6px] text-muted-foreground outline-none transition-colors duration-150 hover:bg-accent-soft/85 hover:text-primary focus-visible:ring-2 focus-visible:ring-ring/60 [&_svg]:size-3.5 [&_svg]:stroke-[2]"
              >
                <motion.span
                  className="grid place-items-center"
                  animate={hoveredTool === 'source-import' ? { rotate: 90 } : { rotate: 0 }}
                  transition={{ type: 'spring', stiffness: 460, damping: 24 }}
                >
                  <Plus />
                </motion.span>
              </motion.button>
              <AirCheckbox
                label={tr("切换全部订阅")}
                checked={chosen.length > 0 && (chosen.length === sources.length ? true : 'indeterminate')}
                disabled={!sources.length}
                onChange={active => onSelectedChange(active ? sources.map(source => source.id) : [])}
                className="shrink-0"
              >
                <span className="text-xs font-medium text-foreground">
                  {chosen.length ? tr("已选 {0}", chosen.length) : tr('全选')}
                </span>
              </AirCheckbox>
            </div>
          </header>

          <ContextMenu>
            <ContextMenuTrigger
              render={
                <div className="air-scroll flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-0.5 pr-1" />
              }
            >
              {pendingImports.map(task => (
                <div
                  key={task.id}
                  role="status"
                  aria-live="polite"
                  className="flex shrink-0 flex-col gap-2 rounded-[9px] border border-accent-border/80 bg-accent-soft/45 px-2.5 py-2.5"
                >
                  <div className="flex min-w-0 items-center justify-between gap-2">
                    <div className="flex min-w-0 items-center gap-2">
                      <Loader2 className="size-3.5 shrink-0 animate-spin text-primary" aria-hidden="true" />
                      <strong className="min-w-0 truncate text-sm font-semibold text-foreground" title={task.label}>
                        {task.label}
                      </strong>
                    </div>
                    <Badge variant="accent" className="shrink-0">{tr("导入中")}</Badge>
                  </div>
                  <div className="flex items-center justify-between gap-2 text-[12px] text-muted-foreground">
                    <span className="min-w-0 truncate mono">{task.sourceHost}</span>
                    <span className="shrink-0">{tr("后台加载中…")}</span>
                  </div>
                  <div className="air-import-bar" aria-hidden="true" />
                </div>
              ))}

              {sources.map(source => {
                const checked = selected.includes(source.id)
                const details = source.details
                const canRefresh = details && details.kind !== 'file'
                const isRefreshing = refreshing.includes(source.id)
                const usage = details?.usage
                const usedBytes = usage ? usage.upload + usage.download : 0
                const usageRatio =
                  usage && usage.total > 0 ? Math.min(100, Math.round((usedBytes / usage.total) * 100)) : 0
                const expireMs = usage?.expire && usage.expire > 0 ? usage.expire * 1000 : 0
                const expired = Boolean(expireMs && expireMs < Date.now())
                const expireLabel = expireMs
                  ? tr("{0} 到期", formatDateTime(expireMs))
                  : undefined

                const sourceCard = (
                  <div
                    data-slot="subscription-source"
                    data-refreshing={isRefreshing || undefined}
                    className={cn(
                      'air-sub-card flex shrink-0 flex-col gap-1 rounded-[9px] border px-2.5 py-2 transition-[border-color,background-color,box-shadow] duration-150',
                      checked
                        ? 'border-primary/65 bg-accent-soft/50'
                        : 'border-border bg-muted/55 hover:border-accent-border hover:shadow-2xs dark:bg-background/60',
                    )}
                  >
                    {isRefreshing && <span aria-hidden="true" className="air-sub-card-glow" />}
                    <div className="flex min-w-0 items-center justify-between gap-1">
                      <AirCheckbox
                        label={source.name}
                        checked={checked}
                        onChange={active =>
                          onSelectedChange(previous =>
                            active
                              ? previous.includes(source.id)
                                ? previous
                                : [...previous, source.id]
                              : previous.filter(id => id !== source.id),
                          )
                        }
                        className="flex-1"
                      >
                        <strong className="min-w-0 truncate text-base font-semibold text-foreground" title={source.name}>
                          {source.name}
                        </strong>
                      </AirCheckbox>

                      <div className="flex shrink-0 items-center">
                        {canRefresh && (
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            disabled={isRefreshing}
                            aria-label={tr("刷新 {0}", source.name)}
                            title={tr("刷新 {0}", source.name)}
                            onClick={() => refresh([source])}
                          >
                            <RefreshCw className={isRefreshing ? 'animate-spin text-primary' : undefined} />
                          </Button>
                        )}
                        <DropdownMenu>
                          <DropdownMenuTrigger
                            render={
                              <Button
                                variant="ghost"
                                size="icon-sm"
                                aria-label={tr("管理 {0}", source.name)}
                              />
                            }
                          >
                            <MoreHorizontal />
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuGroup>
                              <DropdownMenuItem onClick={() => void editSource(source)}>
                                <Pencil />{tr("编辑订阅")}</DropdownMenuItem>
                              <DropdownMenuItem onClick={() => onYaml(source.id)}>
                                <FileCode2 />{tr("编辑 YAML")}</DropdownMenuItem>
                              <DropdownMenuItem onClick={() => void openTool(source, 'extension')}><Puzzle />{tr("扩展")}</DropdownMenuItem>
                              {details?.kind !== 'file' && <>
                                <DropdownMenuItem disabled={isRefreshing} onClick={() => refresh([source])}><RefreshCw />{tr("同步")}</DropdownMenuItem>
                                <DropdownMenuItem onClick={() => void openTool(source, 'policy')}><CalendarClock />{tr("自动更新")}{details?.autoUpdate === false ? tr('（已暂停）') : ''}</DropdownMenuItem>
                              </>}
                              <Menu.SubmenuRoot>
                                <Menu.SubmenuTrigger className="flex min-h-7.5 w-full cursor-pointer items-center gap-2 rounded-[6px] px-2 py-1 text-xs text-popover-foreground outline-none select-none transition-colors data-highlighted:bg-muted data-popup-open:bg-muted [&_svg]:size-3.5 [&_svg]:shrink-0 [&_svg]:text-muted-foreground"><MoreHorizontal />{tr("更多")}<ChevronRight className="ml-auto" /></Menu.SubmenuTrigger>
                                <DropdownMenuContent side="right" align="start">
                                  <DropdownMenuItem onClick={() => void openTool(source, 'runtime')}><Eye />{tr("运行时配置")}</DropdownMenuItem>
                                  {details?.kind !== 'file' && <>
                                    <DropdownMenuItem closeOnClick={false} onClick={() => void copySubscriptionUrl(source)}>
                                      {copied === source.id ? <Check /> : <Link />}
                                      {copied === source.id ? tr('复制成功') : tr('复制链接')}
                                    </DropdownMenuItem>
                                    <DropdownMenuItem onClick={() => void openTool(source, 'qr')}><QrCode />{tr("二维码")}</DropdownMenuItem>
                                  </>}
                                  <DropdownMenuItem onClick={() => void openTool(source, 'export')}><Download />{tr("导出文件")}</DropdownMenuItem>
                                  {sources.length > 1 && <>
                                    <DropdownMenuItem disabled={sources[0].id === source.id} onClick={() => move(source.id, -1)}><ArrowUp />{tr("上移订阅")}</DropdownMenuItem>
                                    <DropdownMenuItem disabled={sources.at(-1)?.id === source.id} onClick={() => move(source.id, 1)}><ArrowDown />{tr("下移订阅")}</DropdownMenuItem>
                                  </>}
                                </DropdownMenuContent>
                              </Menu.SubmenuRoot>
                            </DropdownMenuGroup>
                            <DropdownMenuSeparator />
                            <DropdownMenuGroup>
                              <DropdownMenuItem
                                variant="destructive"
                                onClick={() => setDialog({ kind: 'delete', source })}
                              >
                                <Trash2 />{tr("删除订阅")}</DropdownMenuItem>
                            </DropdownMenuGroup>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-0.5 text-xs">
                      <span className="shrink-0 tabular-nums text-muted-foreground">
                        {tr('{0} 个节点 · {1} 个分组', source.nodes, source.groups)}</span>
                      <div className="flex shrink-0 items-center gap-1.5">
                        <span
                          title={details?.refreshError ? diagnostic(details.refreshError) : undefined}
                          className={cn(
                            'inline-flex items-center gap-1.5 font-medium',
                            isRefreshing
                              ? 'text-primary'
                              : details?.refreshError || expired
                                ? 'text-destructive'
                                : 'text-success',
                          )}
                        >
                          <span aria-hidden="true" className="size-1.5 rounded-full bg-current" />
                          {isRefreshing
                            ? tr('刷新中')
                            : details?.refreshError
                              ? tr('刷新失败')
                              : expired
                                ? tr('已过期')
                                : tr('可用')}
                        </span>
                        <span className="text-[12px] text-muted-foreground">
                          {details ? sourceKinds[details.kind] : tr('已有订阅')}
                        </span>
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-0.5 tabular-nums">
                      {usage && usage.total > 0 ? (
                        <div className="flex items-center gap-1.5 text-xs text-foreground">
                          <div
                            role="progressbar"
                            aria-label={tr("订阅流量用量")}
                            aria-valuenow={usageRatio}
                            className="h-1.5 w-7 shrink-0 overflow-hidden rounded-full bg-muted"
                          >
                            <div
                              className={cn(
                                'h-full rounded-full transition-[width]',
                                usageRatio > 85 ? 'bg-warning' : 'bg-primary',
                              )}
                              style={{ width: `${usageRatio}%` }}
                            />
                          </div>
                          <span>{formatGb(usedBytes)} / {formatGb(usage.total)} GB</span>
                        </div>
                      ) : (
                        <span className="text-[12px] text-muted-foreground">{tr('用量未提供')}</span>
                      )}
                      {expireLabel && (
                        <span
                          className={cn('text-[12px]', expired ? 'font-medium text-destructive' : 'text-muted-foreground')}
                          title={expireLabel}
                        >
                          {expireLabel}
                        </span>
                      )}
                    </div>
                    {details?.refreshError && (
                      <p
                        className="truncate text-[12px] text-destructive"
                        title={diagnostic(details.refreshError)}
                      >
                        {diagnostic(details.refreshError)}
                      </p>
                    )}
                  </div>
                )

                return (
                  <ContextMenu key={source.id}>
                    <ContextMenuTrigger render={sourceCard} />
                    <ContextMenuContent>
                      <ContextMenuItem
                        disabled={!canRefresh || isRefreshing}
                        onClick={() => refresh([source])}
                      >
                        <RefreshCw />
                        {isRefreshing ? tr('刷新中...') : tr('刷新订阅')}
                      </ContextMenuItem>
                      <ContextMenuItem onClick={() => void editSource(source)}>
                        <Pencil />{tr("编辑订阅")}</ContextMenuItem>
                      <ContextMenuItem onClick={() => onYaml(source.id)}>
                        <FileCode2 />{tr("编辑 YAML")}</ContextMenuItem>
                      <ContextMenuItem
                        disabled={details?.kind === 'file'}
                        closeOnClick={false}
                        onClick={() => void copySubscriptionUrl(source)}
                      >
                        {copied === source.id ? <Check /> : <Link />}
                        {copied === source.id ? tr('复制成功') : tr('复制订阅链接')}
                      </ContextMenuItem>
                      <ContextMenuItem onClick={() => void openTool(source, 'extension')}><Puzzle />{tr("扩展")}</ContextMenuItem>
                      {details?.kind !== 'file' && <>
                        <ContextMenuItem onClick={() => void openTool(source, 'policy')}><CalendarClock />{tr("自动更新")}</ContextMenuItem>
                        <ContextMenuItem onClick={() => void openTool(source, 'qr')}><QrCode />{tr("二维码")}</ContextMenuItem>
                      </>}
                      <ContextMenuItem onClick={() => void openTool(source, 'runtime')}><Eye />{tr("运行时配置")}</ContextMenuItem>
                      <ContextMenuItem onClick={() => void openTool(source, 'export')}><Download />{tr("导出文件")}</ContextMenuItem>
                      <ContextMenuSeparator />
                      <ContextMenuItem
                        variant="destructive"
                        onClick={() => setDialog({ kind: 'delete', source })}
                      >
                        <Trash2 />{tr("删除订阅")}</ContextMenuItem>
                    </ContextMenuContent>
                  </ContextMenu>
                )
              })}

              {!sources.length && !pendingImports.length && (
                <div className="flex flex-1 flex-col items-center justify-center gap-2.5 rounded-[9px] border border-dashed border-border bg-muted/20 p-6 text-center">
                  <CloudDownload className="size-6 text-primary" />
                  <strong className="text-sm font-semibold text-foreground">{tr("还没有订阅")}</strong>
                  <span className="text-xs text-muted-foreground">{tr("用 URL、本地 YAML 或二维码导入")}</span>
                  <Button variant="default" size="sm" onClick={() => setShowImport(true)}>
                    <Plus data-icon="inline-start" />{tr("导入订阅")}</Button>
                </div>
              )}
            </ContextMenuTrigger>

            <ContextMenuContent>
              <ContextMenuItem onClick={() => setShowImport(true)}>
                <Plus />{tr("导入订阅")}</ContextMenuItem>
              <ContextMenuItem
                disabled={!canRefreshAll}
                onClick={() => refresh(remote)}
              >
                <RefreshCw />{tr("刷新全部订阅")}</ContextMenuItem>
              {sources.length > 0 && (
                <>
                  <ContextMenuSeparator />
                  <ContextMenuItem onClick={() => onSelectedChange(sources.map(source => source.id))}>
                    <Layers />{tr("全选来源")}</ContextMenuItem>
                  <ContextMenuItem
                    disabled={!chosen.length}
                    onClick={() => onSelectedChange([])}
                  >
                    <Trash2 />{tr("清空选择")}</ContextMenuItem>
                </>
              )}
            </ContextMenuContent>
          </ContextMenu>

        </Card>
        </ResizableSidePanel>

        <Card className="min-h-0 min-w-0 flex-1 gap-3 p-4">
          <header className="flex items-center justify-between gap-2">
            <div className="flex items-baseline gap-2">
              <h2 className="text-base font-semibold text-foreground">{tr("订阅内容")}</h2>
              <small className="text-xs text-muted-foreground">{tr('已选 {0} 个来源 · 同步至节点库', chosen.length)}</small>
            </div>
            <Button
              variant="secondary"
              size="sm"
              disabled={!chosen.length}
              onClick={() => onSelectedChange([])}
            >{tr("清空选择")}</Button>
          </header>

          {chosen.length > 0 && (
            <div className="flex flex-wrap gap-1.5 border-b border-border-subtle pb-2.5">
              <AnimatePresence initial={false}>
                {chosen.map(source => (
                  <motion.span
                    key={source.id}
                    layout
                    initial={{ opacity: 0, scale: 0.85 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.85 }}
                    transition={{ duration: 0.14 }}
                    className="inline-flex"
                  >
                    <Badge variant="accent" className="max-w-36 overflow-hidden" title={source.name}>
                      <span className="min-w-0 truncate">{source.name}</span>
                    </Badge>
                  </motion.span>
                ))}
              </AnimatePresence>
            </div>
          )}

          <ContextMenu>
            <ContextMenuTrigger
              render={
                <div className="air-scroll flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto pr-0.5" />
              }
            >
            {!chosen.length ? (
              <div className="flex flex-1 flex-col items-center justify-center gap-2 rounded-[9px] border border-dashed border-border bg-muted/20 p-8 text-center">
                <Layers className="size-6 text-primary" />
                <strong className="text-sm font-semibold text-foreground">{tr("选择订阅来源")}</strong>
                <span className="text-xs text-muted-foreground">{tr("勾选左侧订阅后，将同步显示在「节点库」与此处汇总")}</span>
              </div>
            ) : (
              <>
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-baseline gap-2">
                    <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{tr("分组")}</h3>
                    <small className="mono text-xs text-muted-foreground">{groups.length}{tr(" 个")}</small>
                  </div>
                  {groups.length > 2 && (
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-expanded={allGroups}
                      onClick={() => setAllGroups(value => !value)}
                    >
                      {allGroups ? tr('收起') : tr('查看全部')}
                    </Button>
                  )}
                </div>

                <div className="flex flex-col gap-1.5">
                  {groups.slice(0, allGroups ? undefined : 2).map(group => (
                    <div
                      key={`${group.sourceId}:${group.name}`}
                      className="flex items-center gap-2.5 rounded-[8px] border border-border bg-muted/55 px-3 py-2 transition-colors duration-150 hover:border-accent-border hover:bg-muted/75 dark:bg-background/60"
                    >
                      <Layers className="size-3.5 shrink-0 text-primary" />
                      <strong className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground" title={group.name}>
                        {group.name}
                      </strong>
                      {(() => {
                        const sourceName = sourceById.get(group.sourceId)?.name
                        return (
                          <Badge variant="accent" className="max-w-28 overflow-hidden" title={sourceName}>
                            <span className="min-w-0 truncate">{sourceName}</span>
                          </Badge>
                        )
                      })()}
                      <span className="hidden shrink-0 whitespace-nowrap text-[12px] text-muted-foreground sm:inline">
                        {strategyLabels[group.strategy ?? 'select'] ?? group.strategy} ·{' '}
                        {(group.memberNames ?? group.members).length}{tr(" 个成员")}</span>
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => setDialog({ kind: 'group', group })}
                      >
                        <Pencil data-icon="inline-start" />{tr("编辑")}</Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={tr("删除分组 {0}", group.name)}
                        onClick={() => deleteItem(group)}
                        className="text-destructive hover:bg-danger-soft hover:text-destructive"
                      >
                        <Trash2 />
                      </Button>
                    </div>
                  ))}
                  {!groups.length && (
                    <p className="text-xs text-muted-foreground">{tr("所选订阅没有分组")}</p>
                  )}
                </div>

                <Separator />

                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-baseline gap-2">
                    <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{tr("节点")}</h3>
                    <small className="mono text-xs text-muted-foreground">{nodes.length}{tr(" 个")}</small>
                  </div>
                  {nodes.length > 4 && (
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-expanded={allNodes}
                      onClick={() => setAllNodes(value => !value)}
                    >
                      {allNodes ? tr('收起') : tr('查看全部')}
                    </Button>
                  )}
                </div>

                <div className="flex flex-col gap-1.5">
                  {nodes.slice(0, allNodes ? undefined : 4).map(node => (
                    <div
                      key={node.id}
                      className="flex items-center gap-2.5 rounded-[8px] border border-border bg-muted/55 px-3 py-2 transition-colors duration-150 hover:border-accent-border hover:bg-muted/75 dark:bg-background/60"
                    >
                      <Server className="size-3.5 shrink-0 text-primary" />
                      <strong className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground" title={node.name}>
                        <FlagText text={node.name} />
                      </strong>
                      <Badge variant="accent" className="max-w-28 overflow-hidden" title={node.source}>
                        <span className="min-w-0 truncate">
                          <FlagText text={node.source} />
                        </span>
                      </Badge>
                      <Badge variant="mono" className="hidden sm:inline-flex">
                        {formatProtocol(node.protocol)}
                      </Badge>
                      <span
                        className={cn(
                          'mono w-[4.25rem] shrink-0 text-right text-xs font-medium',
                          node.latestMs !== null
                            ? node.latestMs <= 500
                              ? 'text-success'
                              : node.latestMs < 1000
                                ? 'text-warning'
                                : 'text-destructive'
                            : node.status === 'timeout' || node.status === 'unreachable'
                              ? 'text-destructive'
                              : 'text-muted-foreground',
                        )}
                      >
                        {node.latestMs !== null
                          ? `${node.latestMs} ms`
                          : node.status === 'timeout'
                            ? tr('超时')
                            : node.status === 'unreachable'
                              ? tr('失败')
                              : tr('待测试')}
                      </span>
                      <Button variant="secondary" size="sm" onClick={() => onNode(node)}>
                        <Pencil data-icon="inline-start" />{tr("编辑")}</Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={tr("删除节点 {0}", node.name)}
                        onClick={() => deleteItem(node)}
                        className="text-destructive hover:bg-danger-soft hover:text-destructive"
                      >
                        <Trash2 />
                      </Button>
                    </div>
                  ))}
                </div>
              </>
            )}
            </ContextMenuTrigger>

            <ContextMenuContent>
              <ContextMenuItem onClick={() => setShowImport(true)}>
                <Plus />{tr("导入订阅")}</ContextMenuItem>
              <ContextMenuItem
                disabled={!canRefreshAll}
                onClick={() => refresh(remote)}
              >
                <RefreshCw />{tr("刷新全部订阅")}</ContextMenuItem>
              {sources.length > 0 && (
                <>
                  <ContextMenuSeparator />
                  <ContextMenuItem onClick={() => onSelectedChange(sources.map(source => source.id))}>
                    <Layers />{tr("全选全部来源")}</ContextMenuItem>
                  <ContextMenuItem
                    disabled={!chosen.length}
                    onClick={() => onSelectedChange([])}
                  >
                    <Trash2 />{tr("清空来源选择")}</ContextMenuItem>
                </>
              )}
            </ContextMenuContent>
          </ContextMenu>

          {chosen.length > 0 && (
            <footer className="border-t border-border-subtle pt-2.5 text-[12px] text-muted-foreground">{tr("已勾选的订阅会同步显示在「节点库」，同名分组按订阅来源区分")}</footer>
          )}
        </Card>
      </div>

      {tool && <SubscriptionTool data={tool.data} name={tool.name} close={() => setTool(undefined)} />}
      {showImport && (
        <SubscriptionImport onClose={() => setShowImport(false)} onImported={store.refresh} />
      )}
      {dialog && (
        <EditSubscription
          dialog={dialog}
          onYaml={id => {
            setDialog(undefined)
            onYaml(id)
          }}
          onClose={() => setDialog(undefined)}
          onSaved={store.refresh}
          onSourceDeleted={onSourceDeleted}
        />
      )}
    </section>
  )
}

function EditSubscription({
  dialog,
  onClose,
  onSaved,
  onYaml,
  onSourceDeleted,
}: {
  dialog: DialogState
  onClose: () => void
  onSaved: () => Promise<void>
  onYaml: (id: string) => void
  onSourceDeleted: (id: string) => void
}) {
  const binding = useDesktopBinding('subscription', dialog.kind === 'source' ? dialog.source.id : undefined, dialog.kind === 'source')
  const [name, setName] = useState(dialog.kind === 'group' ? dialog.group.name : dialog.source.name)
  const [url, setUrl] = useState(dialog.kind === 'source' ? dialog.url : '')
  const [strategy, setStrategy] = useState(
    dialog.kind === 'group' ? dialog.group.strategy ?? 'select' : 'select',
  )
  const [members, setMembers] = useState(
    dialog.kind === 'group' ? (dialog.group.memberNames ?? []).join('\n') : '',
  )
  const [pending, setPending] = useState(false)

  async function submit(event: FormEvent) {
    event.preventDefault()
    setPending(true)
    try {
      if (dialog.kind === 'source') {
        if (name !== dialog.source.name || url !== dialog.url) await air.updateSubscription(dialog.source.id, name, url)
        await binding.save(dialog.source.id)
      } else if (dialog.kind === 'group') {
        await air.changeSubscriptionItem(dialog.group.sourceId, dialog.group.name, true, {
          name,
          strategy,
          members: [...new Set(members.split('\n').map(value => value.trim()).filter(Boolean))],
        })
      } else if (dialog.item) {
        const item = dialog.item
        await air.changeSubscriptionItem(
          dialog.source.id,
          'id' in item ? item.id : item.name,
          !('id' in item),
        )
      } else {
        await air.deleteSubscription(dialog.source.id)
        onSourceDeleted(dialog.source.id)
      }
      await onSaved()
      showMessage({
        type: 'success',
        title:
          dialog.kind === 'source'
            ? tr('订阅已保存')
            : dialog.kind === 'group'
              ? tr('分组已保存')
              : dialog.item
                ? tr('条目已删除')
                : tr('订阅已删除'),
      })
      onClose()
    } catch (failure) {
      showMessage({
        type: 'error',
        title: failure instanceof Error ? failure.message : String(failure),
      })
    } finally {
      setPending(false)
    }
  }

  const deleting = dialog.kind === 'delete'
  const title =
    dialog.kind === 'source'
      ? tr('编辑订阅')
      : dialog.kind === 'group'
        ? tr('编辑分组')
        : tr("删除「{0}」？", dialog.item?.name ?? dialog.source.name)
  const strategyOptions = Object.entries(strategyLabels).map(([value, label]) => ({ value, label }))
  if (!(strategy in strategyLabels)) strategyOptions.push({ value: strategy, label: strategy })

  return (
    <SubscriptionDialog
      title={title}
      onClose={onClose}
      pending={pending}
      onSubmit={event => void submit(event)}
      footer={
        <>
          <Button type="button" variant="secondary" disabled={pending} onClick={onClose}>{tr("取消")}</Button>
          <Button
            type="submit"
            variant={deleting ? 'destructive' : 'default'}
            disabled={pending || (!deleting && !name.trim())}
          >
            {pending ? tr('处理中…') : deleting ? tr('确认删除') : tr('保存')}
          </Button>
        </>
      }
    >
      {deleting ? (
        <p className="text-xs leading-relaxed text-muted-foreground">
          {dialog.item
            ? tr('从该来源的本地副本移除此条目。订阅刷新后仍沿用本地副本。')
            : tr('将删除订阅及其节点和分组，规则集绑定将跟随默认。指向已删除节点或分组的全局规则将拒绝连接。')}
        </p>
      ) : (
        <>
          <div className="flex flex-col gap-1.5">
            {dialog.kind === 'source' && binding.field}
            <Label htmlFor="edit-sub-name">{tr("名称")}</Label>
            <Input
              id="edit-sub-name"
              required
              maxLength={80}
              value={name}
              onChange={e => setName(e.target.value)}
            />
          </div>
          {dialog.kind === 'source' ? (
            <>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="edit-sub-url">{tr("订阅链接")}</Label>
                <div className="relative">
                  <Input
                    id="edit-sub-url"
                    placeholder="https://"
                    autoComplete="off"
                    spellCheck={false}
                    readOnly={dialog.source.details?.kind === 'file'}
                    value={url}
                    onChange={e => setUrl(e.target.value)}
                    className={cn('mono', (dialog.source.details?.kind !== 'file' || Boolean(url.trim())) && 'pr-9')}
                  />
                  {(dialog.source.details?.kind !== 'file' || Boolean(url.trim())) && (
                    <CopySubscriptionLink
                      url={url}
                      onError={message => showMessage({ type: 'error', title: message })}
                      className="absolute top-1/2 right-1 -translate-y-1/2"
                    />
                  )}
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => onYaml(dialog.source.id)}
                >
                  <FileCode2 data-icon="inline-start" />{tr("编辑 YAML")}</Button>

              </div>
            </>
          ) : (
            <>
              <div className="flex flex-col gap-1.5">
                <Label>{tr("选路策略")}</Label>
                <AirSelect
                  label={tr("选路策略")}
                  value={strategy}
                  options={strategyOptions}
                  onChange={setStrategy}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="subscription-members">{tr("成员，每行一项")}</Label>
                <Textarea
                  id="subscription-members"
                  value={members}
                  onChange={event => setMembers(event.target.value)}
                  rows={6}
                  spellCheck={false}
                  className="mono"
                />
              </div>
            </>
          )}
        </>
      )}
    </SubscriptionDialog>
  )
}
