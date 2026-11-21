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
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { cn, formatProtocol } from '@/shared/lib/utils'
import { Badge } from '@/shared/ui/badge'
import { Button } from '@/shared/ui/button'
import { Card } from '@/shared/ui/card'
import { FlagText } from '@/shared/ui/FlagText'
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
  store: Nodes
  onError: (error: unknown) => void
  onYaml: (id: string) => void
  onNode: (node: NodeRecord) => void
  onSourceDeleted: (id: string) => void
}

const strategyLabels: Record<string, string> = {
  select: '手动选择',
  'url-test': '自动测速',
  fallback: '故障转移',
  'load-balance': '负载均衡',
}

const sourceKinds: Record<string, string> = {
  url: 'URL 链接',
  qr: '二维码',
  file: '本地文件',
  custom: '自定义',
}
const time = new Intl.DateTimeFormat('zh-CN', {
  month: 'numeric',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
})
const formatGb = (bytes: number) =>
  (bytes / 1024 ** 3).toLocaleString('zh-CN', { maximumFractionDigits: 1 })

type DialogState =
  | { kind: 'source'; source: SubscriptionSource; url: string }
  | { kind: 'group'; group: SubscriptionGroup }
  | { kind: 'delete'; source: SubscriptionSource; item?: SubscriptionGroup | NodeRecord }

export function Subscriptions({ store, onError, onYaml, onNode, onSourceDeleted }: Props) {
  const [showImport, setShowImport] = useState(false)
  const [selected, setSelected] = useState<string[]>([])
  const [dialog, setDialog] = useState<DialogState>()
  const [refreshing, setRefreshing] = useState<string[]>([])
  const [tool, setTool] = useState<{ name: string; data: SubscriptionToolData }>()
  const pendingImports = usePendingSubscriptionImports()
  async function openTool(source: SubscriptionSource, kind: SubscriptionToolData['kind'] | 'export') {
    const id = source.id
    try {
      let data: SubscriptionToolData
      if (kind === 'qr') {
        const url = await air.subscriptionUrl(id)
        if (!url) throw new Error('此来源没有订阅链接')
        data = { kind, url }
      } else if (kind === 'export') {
        downloadSubscription(source.name, await air.subscriptionYaml(id, false))
        showMessage({ type: 'success', title: '订阅文件已导出' })
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
  const known = useRef(new Set<string>())

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

  useEffect(() => {
    const next = new Set(sources.map(source => source.id))
    const added = [...next].filter(id => !known.current.has(id))
    known.current = next
    setSelected(previous => {
      const updated = [...previous.filter(id => next.has(id)), ...added]
      if (
        updated.length === previous.length &&
        updated.every((id, index) => id === previous[index])
      ) {
        return previous
      }
      return updated
    })
  }, [sources])

  async function refresh(items: SubscriptionSource[]) {
    if (!items.length || refreshing.length) return
    setRefreshing(items.map(source => source.id))
    try {
      const results = await Promise.allSettled(
        items.map(source => air.refreshSubscription(source.id)),
      )
      await store.refresh()
      const errors = results.flatMap((result, index) =>
        result.status === 'rejected'
          ? [`${items[index]!.name}：${String(result.reason)}`]
          : [],
      )
      if (errors.length) onError(errors.join('；'))
      else {
        showMessage({
          type: 'success',
          title: items.length > 1 ? '全部订阅已同步' : `已同步「${items[0]!.name}」`,
        })
      }
    } catch (error) {
      onError(error)
    } finally {
      setRefreshing([])
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
        onError('该来源没有可复制的订阅链接')
        return
      }
      await copy(source.id, url)
      showMessage({ type: 'success', title: '订阅链接已复制' })
    } catch (error) {
      onError(error)
    }
  }

  function deleteItem(item: SubscriptionGroup | NodeRecord) {
    const source = sourceById.get(item.sourceId)
    if (source) setDialog({ kind: 'delete', source, item })
  }

  return (
    <section className="flex h-full min-h-0 flex-col gap-3 px-5 py-4">
      <header className="flex min-h-11 shrink-0 items-center justify-between gap-3">
        <div className="flex items-center gap-4 whitespace-nowrap">
          <h1 className="text-[26px] font-bold leading-tight tracking-tight text-foreground">
            订阅
          </h1>
          <TraceLines variant="subscriptions" />
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="secondary"
            disabled={!remote.length || Boolean(refreshing.length)}
            onClick={() => void refresh(remote)}
          >
            <RefreshCw data-icon="inline-start" className={refreshing.length ? 'animate-spin' : undefined} />
            刷新全部
          </Button>
          <Button variant="default" onClick={() => setShowImport(true)}>
            <Plus data-icon="inline-start" />
            导入订阅
          </Button>
        </div>
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-1 grid-rows-[auto_minmax(0,1fr)] gap-3 lg:grid-cols-[276px_minmax(0,1fr)] lg:grid-rows-[minmax(0,1fr)]">
        <Card className="min-h-0 min-w-0 gap-2.5 p-3 max-lg:max-h-[min(18rem,38dvh)]">
          <header className="flex items-center justify-between gap-2">
            <div className="flex min-w-0 items-baseline gap-2">
              <h2 className="text-base font-semibold text-foreground">订阅来源</h2>
              <span className="shrink-0 text-xs text-muted-foreground">{sources.length} 个</span>
            </div>
            <AirCheckbox
              label="切换全部订阅"
              checked={chosen.length > 0 && (chosen.length === sources.length ? true : 'indeterminate')}
              disabled={!sources.length}
              onChange={active => setSelected(active ? sources.map(source => source.id) : [])}
              className="shrink-0"
            >
              <span className="text-xs font-medium text-foreground">
                {chosen.length ? `已选 ${chosen.length}` : '全选'}
              </span>
            </AirCheckbox>
          </header>

          <ContextMenu>
            <ContextMenuTrigger
              render={
                <div className="air-scroll flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto pr-0.5" />
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
                    <Badge variant="accent" className="shrink-0">导入中</Badge>
                  </div>
                  <div className="flex items-center justify-between gap-2 text-[12px] text-muted-foreground">
                    <span className="min-w-0 truncate mono">{task.sourceHost}</span>
                    <span className="shrink-0">后台加载中…</span>
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
                const updated = details?.updatedAt ? time.format(details.updatedAt) : undefined

                const sourceCard = (
                  <div
                    data-slot="subscription-source"
                    className={cn(
                      'flex shrink-0 flex-col gap-1 rounded-[9px] border px-2.5 py-2 transition-colors',
                      checked
                        ? 'border-primary/65 bg-accent-soft/50'
                        : 'border-border bg-muted/35 hover:border-accent-border',
                    )}
                  >
                    <div className="flex min-w-0 items-center justify-between gap-1">
                      <AirCheckbox
                        label={source.name}
                        checked={checked}
                        onChange={active =>
                          setSelected(previous =>
                            active ? [...previous, source.id] : previous.filter(id => id !== source.id),
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
                            disabled={Boolean(refreshing.length)}
                            aria-label={`刷新 ${source.name}`}
                            title={`刷新 ${source.name}`}
                            onClick={() => void refresh([source])}
                          >
                            <RefreshCw className={isRefreshing ? 'animate-spin' : undefined} />
                          </Button>
                        )}
                        <DropdownMenu>
                          <DropdownMenuTrigger
                            render={
                              <Button
                                variant="ghost"
                                size="icon-sm"
                                aria-label={`管理 ${source.name}`}
                              />
                            }
                          >
                            <MoreHorizontal />
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuGroup>
                              <DropdownMenuItem onClick={() => void editSource(source)}>
                                <Pencil />
                                编辑订阅
                              </DropdownMenuItem>
                              <DropdownMenuItem onClick={() => onYaml(source.id)}>
                                <FileCode2 />
                                编辑 YAML
                              </DropdownMenuItem>
                              <DropdownMenuItem onClick={() => void openTool(source, 'extension')}><Puzzle />扩展</DropdownMenuItem>
                              {details?.kind !== 'file' && <>
                                <DropdownMenuItem disabled={isRefreshing} onClick={() => void refresh([source])}><RefreshCw />同步</DropdownMenuItem>
                                <DropdownMenuItem onClick={() => void openTool(source, 'policy')}><CalendarClock />自动更新{details?.autoUpdate === false ? '（已暂停）' : ''}</DropdownMenuItem>
                              </>}
                              <Menu.SubmenuRoot>
                                <Menu.SubmenuTrigger className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-xs data-highlighted:bg-muted"><MoreHorizontal size={14} />更多<ChevronRight size={14} className="ml-auto" /></Menu.SubmenuTrigger>
                                <DropdownMenuContent side="right" align="start">
                                  <DropdownMenuItem onClick={() => void openTool(source, 'runtime')}><Eye />运行时配置</DropdownMenuItem>
                                  {details?.kind !== 'file' && <>
                                    <DropdownMenuItem closeOnClick={false} onClick={() => void copySubscriptionUrl(source)}>
                                      {copied === source.id ? <Check /> : <Link />}
                                      {copied === source.id ? '复制成功' : '复制链接'}
                                    </DropdownMenuItem>
                                    <DropdownMenuItem onClick={() => void openTool(source, 'qr')}><QrCode />二维码</DropdownMenuItem>
                                  </>}
                                  <DropdownMenuItem onClick={() => void openTool(source, 'export')}><Download />导出文件</DropdownMenuItem>
                                  {sources.length > 1 && <>
                                    <DropdownMenuItem disabled={sources[0].id === source.id} onClick={() => move(source.id, -1)}><ArrowUp />上移订阅</DropdownMenuItem>
                                    <DropdownMenuItem disabled={sources.at(-1)?.id === source.id} onClick={() => move(source.id, 1)}><ArrowDown />下移订阅</DropdownMenuItem>
                                  </>}
                                </DropdownMenuContent>
                              </Menu.SubmenuRoot>
                            </DropdownMenuGroup>
                            <DropdownMenuGroup>
                              <DropdownMenuItem
                                variant="destructive"
                                onClick={() => setDialog({ kind: 'delete', source })}
                              >
                                <Trash2 />
                                删除订阅
                              </DropdownMenuItem>
                            </DropdownMenuGroup>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-0.5 text-xs">
                      <span className="shrink-0 tabular-nums text-muted-foreground">
                        {source.nodes} 节点 · {source.groups} 分组
                      </span>
                      <div className="flex shrink-0 items-center gap-1.5">
                        <span
                          title={details?.refreshError ?? undefined}
                          className={cn(
                            'inline-flex items-center gap-1.5 font-medium',
                            isRefreshing ? 'text-primary' : details?.refreshError ? 'text-destructive' : 'text-success',
                          )}
                        >
                          <span aria-hidden="true" className="size-1.5 rounded-full bg-current" />
                          {isRefreshing ? '刷新中' : details?.refreshError ? '刷新失败' : '可用'}
                        </span>
                        <span className="text-[12px] text-muted-foreground">
                          {details ? sourceKinds[details.kind] : '已有订阅'}
                        </span>
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-0.5 tabular-nums">
                      {usage && usage.total > 0 && (
                        <div className="flex items-center gap-1.5 text-xs text-foreground">
                          <div
                            role="progressbar"
                            aria-label="订阅流量用量"
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
                      )}
                      <span className="text-[12px] text-muted-foreground" title={updated ? `上次更新 ${updated}` : undefined}>
                        {updated ?? '更新时间未记录'}
                        {details?.refreshError && ' · 沿用上次配置'}
                      </span>
                    </div>
                  </div>
                )

                return (
                  <ContextMenu key={source.id}>
                    <ContextMenuTrigger render={sourceCard} />
                    <ContextMenuContent>
                      <ContextMenuItem
                        disabled={!canRefresh || Boolean(refreshing.length)}
                        onClick={() => void refresh([source])}
                      >
                        <RefreshCw />
                        {isRefreshing ? '刷新中...' : '刷新订阅'}
                      </ContextMenuItem>
                      <ContextMenuItem onClick={() => void editSource(source)}>
                        <Pencil />
                        编辑订阅
                      </ContextMenuItem>
                      <ContextMenuItem onClick={() => onYaml(source.id)}>
                        <FileCode2 />
                        编辑 YAML
                      </ContextMenuItem>
                      <ContextMenuItem
                        disabled={details?.kind === 'file'}
                        closeOnClick={false}
                        onClick={() => void copySubscriptionUrl(source)}
                      >
                        {copied === source.id ? <Check /> : <Link />}
                        {copied === source.id ? '复制成功' : '复制订阅链接'}
                      </ContextMenuItem>
                      <ContextMenuItem onClick={() => void openTool(source, 'extension')}><Puzzle />扩展</ContextMenuItem>
                      {details?.kind !== 'file' && <>
                        <ContextMenuItem onClick={() => void openTool(source, 'policy')}><CalendarClock />自动更新</ContextMenuItem>
                        <ContextMenuItem onClick={() => void openTool(source, 'qr')}><QrCode />二维码</ContextMenuItem>
                      </>}
                      <ContextMenuItem onClick={() => void openTool(source, 'runtime')}><Eye />运行时配置</ContextMenuItem>
                      <ContextMenuItem onClick={() => void openTool(source, 'export')}><Download />导出文件</ContextMenuItem>
                      <ContextMenuSeparator />
                      <ContextMenuItem
                        variant="destructive"
                        onClick={() => setDialog({ kind: 'delete', source })}
                      >
                        <Trash2 />
                        删除订阅
                      </ContextMenuItem>
                    </ContextMenuContent>
                  </ContextMenu>
                )
              })}

              {!sources.length && !pendingImports.length && (
                <div className="flex flex-1 flex-col items-center justify-center gap-2.5 rounded-[9px] border border-dashed border-border bg-muted/20 p-6 text-center">
                  <CloudDownload className="size-6 text-primary" />
                  <strong className="text-sm font-semibold text-foreground">还没有订阅</strong>
                  <span className="text-xs text-muted-foreground">
                    用 URL、本地 YAML 或二维码导入
                  </span>
                  <Button variant="secondary" size="sm" onClick={() => setShowImport(true)}>
                    <Plus data-icon="inline-start" />
                    导入订阅
                  </Button>
                </div>
              )}
            </ContextMenuTrigger>

            <ContextMenuContent>
              <ContextMenuItem onClick={() => setShowImport(true)}>
                <Plus />
                导入订阅
              </ContextMenuItem>
              <ContextMenuItem
                disabled={!remote.length || Boolean(refreshing.length)}
                onClick={() => void refresh(remote)}
              >
                <RefreshCw />
                刷新全部订阅
              </ContextMenuItem>
              {sources.length > 0 && (
                <>
                  <ContextMenuSeparator />
                  <ContextMenuItem onClick={() => setSelected(sources.map(source => source.id))}>
                    <Layers />
                    全选来源
                  </ContextMenuItem>
                  <ContextMenuItem
                    disabled={!chosen.length}
                    onClick={() => setSelected([])}
                  >
                    <Trash2 />
                    清空选择
                  </ContextMenuItem>
                </>
              )}
            </ContextMenuContent>
          </ContextMenu>

        </Card>

        <Card className="min-h-0 min-w-0 gap-3 p-4">
          <header className="flex items-center justify-between gap-2">
            <div className="flex items-baseline gap-2">
              <h2 className="text-base font-semibold text-foreground">订阅内容</h2>
              <small className="text-xs text-muted-foreground">已选 {chosen.length} 个来源</small>
            </div>
            <Button
              variant="secondary"
              size="sm"
              disabled={!chosen.length}
              onClick={() => setSelected([])}
            >
              清空选择
            </Button>
          </header>

          {chosen.length > 0 && (
            <div className="flex flex-wrap gap-1.5 border-b border-border-subtle pb-2.5">
              {chosen.map(source => (
                <Badge key={source.id} variant="accent" className="max-w-36 truncate">
                  {source.name}
                </Badge>
              ))}
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
                <strong className="text-sm font-semibold text-foreground">选择订阅来源</strong>
                <span className="text-xs text-muted-foreground">
                  勾选左侧来源即可汇总查看它的分组和节点
                </span>
              </div>
            ) : (
              <>
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-baseline gap-2">
                    <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                      分组
                    </h3>
                    <small className="mono text-xs text-muted-foreground">{groups.length} 个</small>
                  </div>
                  {groups.length > 2 && (
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-expanded={allGroups}
                      onClick={() => setAllGroups(value => !value)}
                    >
                      {allGroups ? '收起' : '查看全部'}
                    </Button>
                  )}
                </div>

                <div className="flex flex-col gap-1.5">
                  {groups.slice(0, allGroups ? undefined : 2).map(group => (
                    <div
                      key={`${group.sourceId}:${group.name}`}
                      className="flex items-center gap-2.5 rounded-[8px] border border-border-subtle bg-muted/35 px-3 py-2"
                    >
                      <Layers className="size-3.5 shrink-0 text-primary" />
                      <strong className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground" title={group.name}>
                        {group.name}
                      </strong>
                      <Badge variant="accent" className="max-w-28 truncate">
                        {sourceById.get(group.sourceId)?.name}
                      </Badge>
                      <span className="hidden text-[12px] text-muted-foreground sm:inline">
                        {strategyLabels[group.strategy ?? 'select'] ?? group.strategy} ·{' '}
                        {(group.memberNames ?? group.members).length} 个成员
                      </span>
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => setDialog({ kind: 'group', group })}
                      >
                        <Pencil data-icon="inline-start" />
                        编辑
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`删除分组 ${group.name}`}
                        onClick={() => deleteItem(group)}
                        className="text-destructive hover:bg-danger-soft hover:text-destructive"
                      >
                        <Trash2 />
                      </Button>
                    </div>
                  ))}
                  {!groups.length && (
                    <p className="text-xs text-muted-foreground">所选订阅没有分组</p>
                  )}
                </div>

                <Separator />

                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-baseline gap-2">
                    <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                      节点
                    </h3>
                    <small className="mono text-xs text-muted-foreground">{nodes.length} 个</small>
                  </div>
                  {nodes.length > 4 && (
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-expanded={allNodes}
                      onClick={() => setAllNodes(value => !value)}
                    >
                      {allNodes ? '收起' : '查看全部'}
                    </Button>
                  )}
                </div>

                <div className="flex flex-col gap-1.5">
                  {nodes.slice(0, allNodes ? undefined : 4).map(node => (
                    <div
                      key={node.id}
                      className="flex items-center gap-2.5 rounded-[8px] border border-border-subtle bg-muted/35 px-3 py-2"
                    >
                      <Server className="size-3.5 shrink-0 text-primary" />
                      <strong className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground" title={node.name}>
                        <FlagText text={node.name} />
                      </strong>
                      <Badge variant="accent" className="max-w-28 truncate">
                        <FlagText text={node.source} />
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
                            ? '超时'
                            : node.status === 'unreachable'
                              ? '失败'
                              : '待测试'}
                      </span>
                      <Button variant="secondary" size="sm" onClick={() => onNode(node)}>
                        <Pencil data-icon="inline-start" />
                        编辑
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`删除节点 ${node.name}`}
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
                <Plus />
                导入订阅
              </ContextMenuItem>
              <ContextMenuItem
                disabled={!remote.length || Boolean(refreshing.length)}
                onClick={() => void refresh(remote)}
              >
                <RefreshCw />
                刷新全部订阅
              </ContextMenuItem>
              {sources.length > 0 && (
                <>
                  <ContextMenuSeparator />
                  <ContextMenuItem onClick={() => setSelected(sources.map(source => source.id))}>
                    <Layers />
                    全选全部来源
                  </ContextMenuItem>
                  <ContextMenuItem
                    disabled={!chosen.length}
                    onClick={() => setSelected([])}
                  >
                    <Trash2 />
                    清空来源选择
                  </ContextMenuItem>
                </>
              )}
            </ContextMenuContent>
          </ContextMenu>

          {chosen.length > 0 && (
            <footer className="border-t border-border-subtle pt-2.5 text-[12px] text-muted-foreground">
              同名分组按订阅来源分别区分显示
            </footer>
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
        await air.updateSubscription(dialog.source.id, name, url)
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
            ? '订阅已保存'
            : dialog.kind === 'group'
              ? '分组已保存'
              : dialog.item
                ? '条目已删除'
                : '订阅已删除',
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
      ? '编辑订阅'
      : dialog.kind === 'group'
        ? '编辑分组'
        : `删除「${dialog.item?.name ?? dialog.source.name}」？`
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
          <Button type="button" variant="secondary" disabled={pending} onClick={onClose}>
            取消
          </Button>
          <Button
            type="submit"
            variant={deleting ? 'destructive' : 'default'}
            disabled={pending || (!deleting && !name.trim())}
          >
            {pending ? '处理中…' : deleting ? '确认删除' : '保存'}
          </Button>
        </>
      }
    >
      {deleting ? (
        <p className="text-xs leading-relaxed text-muted-foreground">
          {dialog.item
            ? '从该来源的本地副本移除此条目。订阅刷新后仍沿用本地副本。'
            : '此订阅及其节点和分组将从 Air 移除。引用它的分流出口将改为拒绝连接。'}
        </p>
      ) : (
        <>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="edit-sub-name">名称</Label>
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
                <Label htmlFor="edit-sub-url">订阅链接</Label>
                <div className="flex items-center gap-2">
                  <Input
                    id="edit-sub-url"
                    placeholder="https://"
                    autoComplete="off"
                    spellCheck={false}
                    readOnly={dialog.source.details?.kind === 'file'}
                    value={url}
                    onChange={e => setUrl(e.target.value)}
                    className="mono"
                  />
                  <CopySubscriptionLink
                    url={url}
                    onError={message => showMessage({ type: 'error', title: message })}
                  />
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => onYaml(dialog.source.id)}
                >
                  <FileCode2 data-icon="inline-start" />
                  编辑 YAML
                </Button>

              </div>
            </>
          ) : (
            <>
              <div className="flex flex-col gap-1.5">
                <Label>选路策略</Label>
                <AirSelect
                  label="选路策略"
                  value={strategy}
                  options={strategyOptions}
                  onChange={setStrategy}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="subscription-members">成员，每行一项</Label>
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
