import {
  Activity,
  ArrowDownUp,
  Bookmark,
  Check,
  CheckSquare,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ClipboardPaste,
  CloudDownload,
  Copy,
  FolderMinus,
  LayoutGrid,
  Layers,
  List,
  MoreHorizontal,
  PanelLeftOpen,
  Pencil,
  Pin,
  Plus,
  RefreshCw,
  Search,
  Server,
  Trash2,
  Waypoints,
  X,
} from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useMemo, useRef, useState, type DragEvent, type ReactElement, type ReactNode } from 'react'
import { cn, formatProtocol } from '@/shared/lib/utils'
import { Badge } from '@/shared/ui/badge'
import { Button } from '@/shared/ui/button'
import { Card } from '@/shared/ui/card'
import { FlagText } from '@/shared/ui/FlagText'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from '@/shared/ui/context-menu'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/shared/ui/dropdown-menu'
import { Input } from '@/shared/ui/input'
import { Segmented } from '@/shared/ui/segmented'
import { Separator } from '@/shared/ui/separator'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/shared/ui/table'
import { showMessage } from '@/shared/ui/message'
import type { CustomGroup, NodeRecord, ProxyStatus } from '@/platform/desktop/air'
import { AirCheckbox } from '../../shared/ui/AirCheckbox'
import { AirSelect } from '../../shared/ui/AirSelect'
import { Checkbox } from '../../shared/ui/checkbox'
import { TraceLines } from '../../shared/ui/TraceLines'
import { hopRoleLabel } from '../chains/ChainInspector'
import { CustomGroupDialog, type GroupDialogState } from './CustomGroupDialog'
import { NodeLatencyButton } from '@/shared/ui/NodeLatencyButton'
import { isCustomSource, nodeDragType, NodeSourceTree, type NodeScope } from './NodeSourceTree'
import { NodeTreePanel } from './NodeTreePanel'
import type { Nodes } from './useNodes'

export interface ChainSelection {
  activeHopIndex: number | null
  hops: string[]
  onSelectHopIndex: (index: number) => void
  onAssignNode: (nodeId: string) => void
}

interface Props {
  store: Nodes
  proxy: ProxyStatus
  preferredNodeId: string
  selectingNodeId?: string
  powerPending: boolean
  onChooseNode: (id: string) => void
  onEdit: (node: NodeRecord) => void
  onAdd: () => void
  onAddToGroup: (groupId: string) => void
  onChain: () => void
  onSettings: () => void
  onImport: () => void
  onError: (error: unknown) => void
  onAssignChainRole?: (nodeId: string, role: 'front' | 'transit' | 'exit') => void
  onDeleteCustom?: (node: NodeRecord) => void
  onRefreshSource?: (sourceId: string) => void
  onEditYaml?: (sourceId: string) => void
  customOpen?: boolean
  chainOpen?: boolean
  chainSelection?: ChainSelection
  children?: ReactNode
}

const sortOptions = [
  { value: 'default', label: '默认顺序' },
  { value: 'latestMs', label: '最近延迟' },
  { value: 'averageMs', label: '平均延迟' },
  { value: 'availability', label: '可用率' },
  { value: 'name', label: '名称' },
] as const
const subscriptionNoticeName = /^[^\p{L}\p{N}]*(?:剩余流量|套餐到期)(?=[:：\s]|$)/u

const defaultPageSize = 64
const pageSizes = [defaultPageSize, 96, 128, 192, 256, 384, 512].map(size => ({
  value: String(size),
  label: `每页 ${size} 条`,
}))

const viewModes = [
  { value: 'cards', label: '卡片', icon: <LayoutGrid /> },
  { value: 'table', label: '列表', icon: <List /> },
] as const

type CardDensity = 'compact' | 'normal' | 'detailed'

const densityOptions = [
  { value: 'compact', label: '简洁' },
  { value: 'normal', label: '标准' },
  { value: 'detailed', label: '详细' },
] as const satisfies readonly { value: CardDensity; label: string }[]

function nodeStatusLabel(status: NodeRecord['status']) {
  if (status === 'available') return '可用'
  if (status === 'timeout') return '超时'
  if (status === 'unreachable') return '不可达'
  return '待测速'
}

function delay(ms: number | null) {
  return ms === null ? '—' : `${ms} ms`
}

function ratio(value: number | null) {
  return value === null ? '—' : `${Number((value * 100).toFixed(1))}%`
}

function span(ms: number | null) {
  if (ms === null) return '—'
  const minutes = Math.floor(ms / 60_000)
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor(minutes / 60) % 24
  if (days) return `${days} 天 ${hours} 时`
  return hours ? `${hours} 小时` : `${minutes} 分钟`
}

export function NodeLibrary({
  store,
  proxy,
  preferredNodeId,
  selectingNodeId,
  powerPending,
  onChooseNode,
  onEdit,
  onAdd,
  onAddToGroup,
  onChain,
  onSettings,
  onImport,
  onError,
  onAssignChainRole,
  onDeleteCustom,
  onRefreshSource,
  onEditYaml,
  customOpen,
  chainOpen,
  chainSelection,
  children,
}: Props) {
  const outbound = proxy.running && proxy.mode !== 'direct' ? proxy.outbound : null
  const currentNode = outbound?.hops.length === 1 ? outbound.hops[0] : undefined
  const selectedOutboundId = currentNode?.id ?? preferredNodeId
  const nodeActionDisabled = powerPending || Boolean(selectingNodeId)
  const [mode, setMode] = useState<'cards' | 'table'>('cards')
  const [density, setDensity] = useState<CardDensity>(() => {
    const saved = localStorage.getItem('air.nodeCardDensity')
    return saved === 'compact' || saved === 'detailed' ? saved : 'normal'
  })
  const [groupDialog, setGroupDialog] = useState<GroupDialogState>({ kind: 'none' })
  const [copiedIds, setCopiedIds] = useState<string[]>([])
  const [draggedIds, setDraggedIds] = useState<string[]>([])
  const [scope, setScope] = useState<NodeScope>({ kind: 'all' })
  const [treeOpen, setTreeOpen] = useState(
    () => localStorage.getItem('air.nodeTreeCollapsed') !== '1',
  )
  const [search, setSearch] = useState('')
  const [searchOpen, setSearchOpen] = useState(false)
  const [hoveredTool, setHoveredTool] = useState<'search' | 'measure' | 'add' | 'chain' | 'expandTree' | null>(null)
  const [addMenuOpen, setAddMenuOpen] = useState(false)
  const searchInput = useRef<HTMLInputElement>(null)
  const searchButton = useRef<HTMLButtonElement>(null)
  const [sort, setSort] = useState<(typeof sortOptions)[number]['value']>('default')
  const [selecting, setSelecting] = useState(false)
  const [requestedPage, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(defaultPageSize)

  const activeSource =
    scope.kind === 'source' || scope.kind === 'group'
      ? store.library.sources.find(item => item.id === scope.sourceId)
      : undefined
  const activeGroup =
    scope.kind === 'group'
      ? store.library.groups.find(
          item => item.sourceId === scope.sourceId && item.name === scope.name,
        )
      : undefined
  const activeCustomGroup =
    scope.kind === 'customGroup'
      ? store.customGroups.find(item => item.id === scope.groupId)
      : undefined

  useEffect(() => {
    localStorage.setItem('air.nodeTreeCollapsed', treeOpen ? '0' : '1')
  }, [treeOpen])

  useEffect(() => {
    localStorage.setItem('air.nodeCardDensity', density)
  }, [density])


  useEffect(() => {
    if (scope.kind === 'source' && scope.sourceId !== 'custom' && !activeSource) {
      setScope({ kind: 'all' })
    } else if (scope.kind === 'group' && !activeGroup) {
      setScope({ kind: 'all' })
    } else if (scope.kind === 'customGroup' && !activeCustomGroup) {
      setScope({ kind: 'all' })
    }
  }, [scope, activeSource, activeGroup, activeCustomGroup])

  const query = search.trim().toLocaleLowerCase()
  const customSourceIds = useMemo(
    () => new Set(store.library.sources.filter(isCustomSource).map(source => source.id)),
    [store.library.sources],
  )
  const filtered = useMemo(() => {
    const members = activeGroup?.members ?? activeCustomGroup?.members
    if ((scope.kind === 'group' || scope.kind === 'customGroup') && !members) return []

    const sourceId = scope.kind === 'source' ? scope.sourceId : activeGroup?.sourceId
    let ordered = sourceId === undefined
      ? store.library.nodes
      : store.library.nodes.filter(node => node.sourceId === sourceId)
    if (members) {
      const nodesById = new Map(ordered.map(node => [node.id, node]))
      ordered = [...new Set(members)]
        .map(id => nodesById.get(id))
        .filter(node => node !== undefined)
    }

    const result = ordered.filter(node =>
      !query || [node.name, node.protocol, node.source, node.server].some(field =>
        field.toLocaleLowerCase().includes(query),
      ),
    )
    if (sort === 'default' && scope.kind !== 'customGroup') {
      const notices: NodeRecord[] = []
      const nodes: NodeRecord[] = []
      for (const node of result) {
        if (node.sourceId !== 'custom' && !customSourceIds.has(node.sourceId) && subscriptionNoticeName.test(node.name)) {
          notices.push(node)
        } else {
          nodes.push(node)
        }
      }
      return [...notices, ...nodes]
    }

    if (sort === 'name') result.sort((a, b) => a.name.localeCompare(b.name))
    else if (sort !== 'default') {
      result.sort((a, b) => {
        const left = a[sort]
        const right = b[sort]
        if (left === null) return right === null ? 0 : 1
        if (right === null) return -1
        return sort === 'availability' ? right - left : left - right
      })
    }
    return result
  }, [activeCustomGroup, activeGroup, customSourceIds, query, scope, sort, store.library.nodes])

  const selectedIds = useMemo(() => new Set(store.selected), [store.selected])
  const activeSelected = selecting ? store.selected : []
  const validNodeIds = useMemo(() => new Set(store.library.nodes.map(node => node.id)), [store.library.nodes])
  const clipboardIds = copiedIds.filter(id => validNodeIds.has(id))
  const maxPage = Math.max(1, Math.ceil(filtered.length / pageSize))
  const page = Math.min(requestedPage, maxPage)
  const visible = filtered.slice((page - 1) * pageSize, page * pageSize)
  const checked = selecting ? visible.filter(node => selectedIds.has(node.id)).length : 0
  const batchTesting = Boolean(store.batchPending || store.progress?.running)
  const hasInspector = Boolean(children)
  const dualSidebars = treeOpen && hasInspector
  const scopeTitle =
    scope.kind === 'customGroup'
      ? activeCustomGroup?.name ?? '自定义分组'
      : scope.kind === 'group'
        ? activeGroup?.name ?? scope.name
        : scope.kind === 'source'
          ? activeSource?.name ?? (scope.sourceId === 'custom' ? '自定义节点' : '全部节点')
          : '全部节点'
  const scopeSubtitle =
    scope.kind === 'customGroup'
      ? '本地自定义'
      : scope.kind === 'group'
        ? activeSource?.name
        : undefined

  useEffect(() => {
    if (!searchOpen) return
    const timer = window.setTimeout(() => {
      searchInput.current?.focus()
    }, 60)
    return () => window.clearTimeout(timer)
  }, [searchOpen])

  function exitSelection() {
    setSelecting(false)
    store.setSelected([])
  }

  function selectPage(next: boolean) {
    const ids = new Set(visible.map(node => node.id))
    store.setSelected(previous =>
      next ? [...new Set([...previous, ...ids])] : previous.filter(id => !ids.has(id)),
    )
  }

  function selectNode(id: string, next: boolean) {
    store.setSelected(previous =>
      next ? [...new Set([...previous, id])] : previous.filter(item => item !== id),
    )
  }

  function selectGroup(groupId: string) {
    setScope({ kind: 'customGroup', groupId })
    setPage(1)
  }

  function createGroupNode(groupId: string) {
    selectGroup(groupId)
    setSearch('')
    onAddToGroup(groupId)
  }

  function addNode() {
    if (activeCustomGroup) createGroupNode(activeCustomGroup.id)
    else onAdd()
  }

  function copyNodes(ids: string[]) {
    const valid = ids.filter(id => validNodeIds.has(id))
    if (!valid.length) return
    setCopiedIds(valid)
    showMessage({ title: `已复制 ${valid.length} 个节点`, description: '可在自定义分组右键粘贴', type: 'success' })
  }

  function startNodeDrag(event: DragEvent, ids: string[]) {
    const valid = ids.filter(id => validNodeIds.has(id))
    if (!valid.length) {
      event.preventDefault()
      return
    }
    event.dataTransfer.effectAllowed = 'copy'
    event.dataTransfer.setData(nodeDragType, 'nodes')
    setDraggedIds(valid)
  }

  function endNodeDrag() {
    setDraggedIds([])
  }

  function nodeDragProps(id: string) {
    return {
      draggable: true,
      onDragStart: (event: DragEvent) => startNodeDrag(event, selecting && selectedIds.has(id) ? activeSelected : [id]),
      onDragEnd: endNodeDrag,
    }
  }

  function addToGroup(group: CustomGroup, ids: string[]) {
    const valid = ids.filter(id => validNodeIds.has(id))
    if (!valid.length) return
    void store.addNodesToCustomGroup(group.id, valid).then(
      () => showMessage({ title: `已加入「${group.name}」`, type: 'success' }),
      onError,
    )
  }

  function toggleSearch() {
    setSearchOpen(open => {
      if (open) {
        setSearch('')
        setPage(1)
        requestAnimationFrame(() => searchButton.current?.focus())
      }
      return !open
    })
  }

  function run(action: () => Promise<unknown>) {
    if (!store.kernelPath) {
      onError('测速需要 Mihomo 诊断内核。请在下方设置内核路径，保存后再测速。')
      onSettings()
      return
    }
    void action().catch(onError)
  }

  const pickingForChain = Boolean(chainOpen && chainSelection && chainSelection.activeHopIndex !== null)

  useEffect(() => {
    if (pickingForChain && selecting) {
      setSelecting(false)
    }
  }, [pickingForChain, selecting])

  useEffect(() => {
    if (!selecting) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && groupDialog.kind === 'none') {
        exitSelection()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [selecting, groupDialog.kind])

  function nodeName(node: NodeRecord, multiline = false) {
    const labelElement = (
      <strong
        className={cn(
          'min-w-0 flex-1 text-sm font-semibold text-foreground',
          multiline
            ? 'line-clamp-2 [overflow-wrap:anywhere] leading-[1.35]'
            : 'truncate',
        )}
      >
        <FlagText text={node.name} />
      </strong>
    )

    const checked = selectedIds.has(node.id)
    const chosen = selectedOutboundId === node.id

    if (selecting) {
      return (
        <div
          className={cn(
            'flex w-full min-w-0 gap-2',
            multiline ? 'items-start' : 'items-center',
          )}
        >
          <span
            className={cn('flex shrink-0 items-center', multiline && 'mt-[1px]')}
            onClick={event => event.stopPropagation()}
          >
            <Checkbox
              aria-label={`选中 ${node.name}`}
              checked={checked}
              onCheckedChange={next => selectNode(node.id, next)}
            />
          </span>
          {labelElement}
        </div>
      )
    }

    if (multiline) {
      return (
        <button
          type="button"
          aria-label={pickingForChain ? `将 ${node.name} 加入链路` : `选择 ${node.name} 为出口`}
          aria-pressed={pickingForChain ? undefined : chosen}
          aria-disabled={node.subscriptionNotice || (!pickingForChain && (nodeActionDisabled || chosen))}
          aria-busy={selectingNodeId === node.id || undefined}
          className="flex w-full min-w-0 rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/60 aria-disabled:cursor-default"
        >
          {labelElement}
        </button>
      )
    }

    return labelElement
  }

  function latest(node: NodeRecord, compact = false) {
    return (
      <NodeLatencyButton
        node={node}
        compact={compact}
        testing={store.isMeasuring(node.id)}
        onMeasure={() => run(() => store.measure(node.id))}
      />
    )
  }

  function nodeChoiceLabel(node: NodeRecord) {
    if (selectingNodeId === node.id) return '切换中'
    if (currentNode?.id === node.id) return '使用中'
    if (selectedOutboundId === node.id) return '已选'
    return undefined
  }

  function nodeChoice(node: NodeRecord) {
    if (node.subscriptionNotice) {
      return <Badge variant="default" className="h-5.5 shrink-0">订阅提示</Badge>
    }
    const label = nodeChoiceLabel(node)
    if (label) {
      return <Badge variant={label === '使用中' ? 'success' : 'accent'} className="h-5.5 shrink-0">{label}</Badge>
    }
    return (
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-5.5 px-1.5"
        aria-label={`将 ${node.name} 设为当前节点`}
        disabled={nodeActionDisabled}
        onClick={event => {
          event.stopPropagation()
          onChooseNode(node.id)
        }}
      >
        设为当前
      </Button>
    )
  }

  function edit(node: NodeRecord) {
    return (
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={`编辑 ${node.name}`}
        onClick={event => {
          event.stopPropagation()
          onEdit(node)
        }}
        className="size-6 text-muted-foreground hover:text-foreground"
      >
        <MoreHorizontal className="size-3.5" />
      </Button>
    )
  }

  function copyText(text: string, label: string) {
    if (!navigator.clipboard) {
      onError(`当前环境不支持剪贴板，无法复制${label}`)
      return
    }
    void navigator.clipboard.writeText(text).catch(onError)
  }

  function renderNodeContextMenu(node: NodeRecord, trigger: ReactElement) {
    const testing = store.isMeasuring(node.id)
    const isSelected = selectedIds.has(node.id)
    const isCustom = node.sourceId === 'custom' || customSourceIds.has(node.sourceId)

    return (
      <ContextMenu key={node.id}>
        <ContextMenuTrigger render={trigger} />
        <ContextMenuContent>
          <ContextMenuItem
            disabled={nodeActionDisabled || node.subscriptionNotice || Boolean(nodeChoiceLabel(node))}
            onClick={() => onChooseNode(node.id)}
          >
            <Check />
            {nodeChoiceLabel(node) ?? '设为当前节点'}
          </ContextMenuItem>
          <ContextMenuItem
            disabled={testing}
            onClick={() => run(() => store.measure(node.id))}
          >
            <Activity />
            {testing ? '测速中...' : '立即测速'}
          </ContextMenuItem>
          <ContextMenuItem onClick={() => {
            if (!selecting) {
              setSelecting(true)
              store.setSelected([node.id])
            } else {
              selectNode(node.id, !isSelected)
            }
          }}>
            <CheckSquare />
            {selecting && isSelected ? '取消勾选' : '勾选节点'}
          </ContextMenuItem>
          <ContextMenuSub>
            <ContextMenuSubTrigger>
              <Layers />
              加入分组
            </ContextMenuSubTrigger>
            <ContextMenuSubContent>
              {store.customGroups.map(group => {
                const inGroup = group.members.includes(node.id)
                return (
                  <ContextMenuItem
                    key={group.id}
                    onClick={() =>
                      void (
                        inGroup
                          ? store.removeNodeFromCustomGroup(group.id, node.id)
                          : store.addNodesToCustomGroup(group.id, [node.id])
                      ).catch(onError)
                    }
                  >
                    {inGroup ? <Check className="text-primary" /> : <Bookmark />}
                    <span className="min-w-0 flex-1 truncate">
                      <FlagText text={group.name} />
                    </span>
                  </ContextMenuItem>
                )
              })}
              {store.customGroups.length > 0 && <ContextMenuSeparator />}
              <ContextMenuItem
                onClick={() => setGroupDialog({ kind: 'create', initialMembers: [node.id] })}
              >
                <Plus />
                新建并加入分组…
              </ContextMenuItem>
            </ContextMenuSubContent>
          </ContextMenuSub>
          {activeCustomGroup && (
            <ContextMenuItem
              onClick={() =>
                void store.removeNodeFromCustomGroup(activeCustomGroup.id, node.id).catch(onError)
              }
            >
              <FolderMinus />
              <span>
                从「<FlagText text={activeCustomGroup.name} />」移除
              </span>
            </ContextMenuItem>
          )}
          {onAssignChainRole && (
            <ContextMenuSub>
              <ContextMenuSubTrigger>
                <Waypoints />
                加入链路
              </ContextMenuSubTrigger>
              <ContextMenuSubContent>
                <ContextMenuItem onClick={() => onAssignChainRole(node.id, 'front')}>
                  设为第 1 跳（前置）
                </ContextMenuItem>
                <ContextMenuItem onClick={() => onAssignChainRole(node.id, 'transit')}>
                  插入为中转跳
                </ContextMenuItem>
                <ContextMenuItem onClick={() => onAssignChainRole(node.id, 'exit')}>
                  设为最后一跳（出口）
                </ContextMenuItem>
              </ContextMenuSubContent>
            </ContextMenuSub>
          )}
          <ContextMenuSeparator />
          <ContextMenuItem onClick={() => copyNodes(selecting && isSelected ? activeSelected : [node.id])}>
            <Copy />
            {selecting && isSelected && activeSelected.length > 1 ? `复制已勾选节点（${activeSelected.length}）` : '复制节点'}
          </ContextMenuItem>
          <ContextMenuItem onClick={() => copyText(node.name, '节点名称')}>
            <Copy />
            复制节点名称
          </ContextMenuItem>
          <ContextMenuItem onClick={() => copyText(`${node.server}:${node.port}`, '服务器地址')}>
            <Copy />
            复制 server:port
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onClick={() => onEdit(node)}>
            <Pencil />
            编辑节点
          </ContextMenuItem>
          {isCustom && onDeleteCustom && (
            <ContextMenuItem
              variant="destructive"
              onClick={() => onDeleteCustom(node)}
            >
              <Trash2 />
              删除自定义节点
            </ContextMenuItem>
          )}
        </ContextMenuContent>
      </ContextMenu>
    )
  }

  function sortHead(field: Exclude<(typeof sortOptions)[number]['value'], 'default'>, text: string, right = false) {
    const active = sort === field
    return (
      <button
        type="button"
        onClick={() => {
          setSort(prev => (prev === field ? 'default' : field))
          setPage(1)
        }}
        className={cn(
          'inline-flex items-center gap-1 transition-colors hover:text-foreground',
          right && 'justify-end',
          active && 'text-primary',
        )}
      >
        <span>{text}</span>
        {active && <ArrowDownUp className="size-3" />}
      </button>
    )
  }

  const toolButtonClass =
    'relative grid size-7 place-items-center rounded-[6px] outline-none transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-ring/60 [&_svg]:size-[15px] [&_svg]:stroke-[1.9]'

  return (
    <section className="relative flex h-full min-h-0 min-w-0 flex-col gap-3 px-5 py-4">
      <header className="flex min-h-11 shrink-0 items-center justify-between gap-3">
        <div className="flex items-center gap-4 whitespace-nowrap">
          <h1 className="text-[26px] font-bold leading-tight tracking-tight text-foreground">
            节点库
          </h1>
          <TraceLines />
        </div>

        <div className="flex items-center gap-2">
          <AnimatePresence initial={false}>
            {searchOpen && (
              <motion.div
                key="node-search-box"
                initial={{ opacity: 0, width: 0, x: 14, scale: 0.94 }}
                animate={{ opacity: 1, width: 204, x: 0, scale: 1 }}
                exit={{ opacity: 0, width: 0, x: 12, scale: 0.94 }}
                transition={{
                  width: { type: 'spring', stiffness: 420, damping: 32 },
                  x: { type: 'spring', stiffness: 420, damping: 30 },
                  scale: { type: 'spring', stiffness: 460, damping: 32 },
                  opacity: { duration: 0.16, ease: 'easeOut' },
                }}
                className="-m-0.5 overflow-hidden p-0.5"
              >
                <div className="relative w-[196px]">
                  <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-primary/80" />
                  <Input
                    ref={searchInput}
                    value={search}
                    placeholder="搜索名称、来源或协议"
                    aria-label="搜索节点"
                    className={cn(
                      'h-8.5 border-accent-border/80 bg-card pl-8 shadow-xs transition-[border-color,box-shadow]',
                      search ? 'pr-7' : 'pr-2.5',
                    )}
                    onChange={event => {
                      setSearch(event.target.value)
                      setPage(1)
                    }}
                    onKeyDown={event => {
                      if (event.key === 'Escape') toggleSearch()
                    }}
                  />
                  {search && (
                    <button
                      type="button"
                      aria-label="清空搜索"
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
            aria-label="节点常用操作"
            className="inline-flex h-8.5 items-center gap-0.5 rounded-[8px] border border-border bg-secondary p-0.5 shadow-xs"
          >
            <motion.button
              ref={searchButton}
              type="button"
              aria-label={searchOpen ? '收起搜索' : '搜索节点'}
              title={searchOpen ? '收起搜索' : '搜索节点'}
              aria-pressed={searchOpen}
              whileHover={{ scale: 1.05 }}
              whileTap={{ scale: 0.92 }}
              transition={{ type: 'spring', stiffness: 520, damping: 28 }}
              onMouseEnter={() => setHoveredTool('search')}
              onMouseLeave={() => setHoveredTool(prev => (prev === 'search' ? null : prev))}
              onClick={toggleSearch}
              className={cn(
                toolButtonClass,
                searchOpen
                  ? 'bg-accent-soft text-primary'
                  : 'text-secondary-foreground hover:bg-accent-soft/80 hover:text-primary',
              )}
            >
              <motion.span
                className="grid place-items-center"
                animate={
                  hoveredTool === 'search'
                    ? { rotate: -12, scale: 1.08 }
                    : { rotate: 0, scale: 1 }
                }
                transition={{ type: 'spring', stiffness: 460, damping: 24 }}
              >
                <Search />
              </motion.span>
            </motion.button>

            <Separator orientation="vertical" className="mx-0.5 h-4 bg-border" />

            <motion.button
              type="button"
              disabled={!filtered.length || batchTesting}
              aria-busy={batchTesting}
              aria-label={
                batchTesting
                  ? '正在刷新测速结果'
                  : activeSelected.length
                    ? `批量测速（已选 ${activeSelected.length} 个）`
                    : '刷新测速结果'
              }
              title={
                batchTesting
                  ? '正在刷新测速结果…'
                  : activeSelected.length
                    ? `批量测速（已选 ${activeSelected.length} 个）`
                    : '刷新测速结果'
              }
              whileHover={!filtered.length || batchTesting ? undefined : { scale: 1.05 }}
              whileTap={!filtered.length || batchTesting ? undefined : { scale: 0.92 }}
              transition={{ type: 'spring', stiffness: 520, damping: 28 }}
              onMouseEnter={() => setHoveredTool('measure')}
              onMouseLeave={() => setHoveredTool(prev => (prev === 'measure' ? null : prev))}
              onClick={() =>
                run(() =>
                  store.batch(
                    activeSelected.length ? activeSelected : filtered.map(node => node.id),
                  ),
                )
              }
              className={cn(
                toolButtonClass,
                'text-secondary-foreground hover:bg-accent-soft/80 hover:text-primary disabled:pointer-events-none disabled:opacity-40',
              )}
            >
              {batchTesting ? (
                <RefreshCw className="animate-spin text-primary" />
              ) : (
                <motion.span
                  className="grid place-items-center"
                  animate={
                    hoveredTool === 'measure'
                      ? { scale: [1, 1.2, 1.06] }
                      : { scale: 1 }
                  }
                  transition={{ duration: 0.34, ease: 'easeOut' }}
                >
                  <RefreshCw />
                </motion.span>
              )}
            </motion.button>

            <Separator orientation="vertical" className="mx-0.5 h-4 bg-border" />

            <DropdownMenu open={addMenuOpen} onOpenChange={setAddMenuOpen}>
              <DropdownMenuTrigger
                render={
                  <motion.button
                    type="button"
                    aria-label="新建节点或分组"
                    title="新建节点、分组或导入订阅"
                    whileHover={{ scale: 1.05 }}
                    whileTap={{ scale: 0.92 }}
                    transition={{ type: 'spring', stiffness: 520, damping: 28 }}
                    onMouseEnter={() => setHoveredTool('add')}
                    onMouseLeave={() => setHoveredTool(prev => (prev === 'add' ? null : prev))}
                    className={cn(
                      toolButtonClass,
                      customOpen || addMenuOpen
                        ? 'bg-accent-soft text-primary'
                        : 'text-secondary-foreground hover:bg-accent-soft/80 hover:text-primary',
                    )}
                  />
                }
              >
                <motion.span
                  className="grid place-items-center"
                  animate={
                    hoveredTool === 'add' || addMenuOpen
                      ? { rotate: 90, scale: 1.08 }
                      : { rotate: 0, scale: 1 }
                  }
                  transition={{ type: 'spring', stiffness: 460, damping: 24 }}
                >
                  <Plus />
                </motion.span>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={addNode}>
                  <Server />
                  {activeCustomGroup ? '在此分组新建节点' : '添加自定义节点'}
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => setGroupDialog({ kind: 'create', initialMembers: activeSelected })}
                >
                  <Layers />
                  新建自定义分组
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={onImport}>
                  <CloudDownload />
                  导入订阅
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>

            <Separator orientation="vertical" className="mx-0.5 h-4 bg-border" />

            <motion.button
              type="button"
              aria-label={chainOpen ? '收起链路配置' : '链路配置'}
              title={chainOpen ? '收起链路配置' : '配置多跳链路'}
              aria-pressed={Boolean(chainOpen)}
              whileHover={{ scale: 1.05 }}
              whileTap={{ scale: 0.92 }}
              transition={{ type: 'spring', stiffness: 520, damping: 28 }}
              onMouseEnter={() => setHoveredTool('chain')}
              onMouseLeave={() => setHoveredTool(prev => (prev === 'chain' ? null : prev))}
              onClick={onChain}
              className={cn(
                toolButtonClass,
                chainOpen
                  ? 'bg-accent-soft text-primary'
                  : 'text-secondary-foreground hover:bg-accent-soft/80 hover:text-primary',
              )}
            >
              <motion.span
                className="grid place-items-center"
                animate={
                  chainOpen
                    ? { rotate: 90, scale: hoveredTool === 'chain' ? 1.12 : 1.04 }
                    : hoveredTool === 'chain'
                      ? { rotate: 18, scale: 1.08 }
                      : { rotate: 0, scale: 1 }
                }
                transition={{ type: 'spring', stiffness: 400, damping: 22 }}
              >
                <Waypoints />
              </motion.span>
              <AnimatePresence>
                {chainOpen && (
                  <motion.span
                    key="chain-open-dot"
                    aria-hidden="true"
                    initial={{ scale: 0, opacity: 0 }}
                    animate={{ scale: 1, opacity: 1 }}
                    exit={{ scale: 0, opacity: 0 }}
                    transition={{ type: 'spring', stiffness: 540, damping: 26 }}
                    className="pointer-events-none absolute top-1 right-1 size-1.5 rounded-full bg-primary"
                  />
                )}
              </AnimatePresence>
            </motion.button>
          </div>
        </div>
      </header>

      <div className="flex min-h-0 flex-1 gap-3">
        <AnimatePresence initial={false}>
          {treeOpen && (
            <NodeTreePanel key="node-source-tree" hasInspector={hasInspector}>
              <NodeSourceTree
                library={store.library}
                customGroups={store.customGroups}
                scope={scope}
                onSelectScope={next => {
                  setScope(next)
                  setPage(1)
                }}
                onCollapse={() => setTreeOpen(false)}
                onRefreshSource={onRefreshSource}
                onEditYaml={onEditYaml}
                onAddCustom={onAdd}
                onSelectGroupNodes={memberIds => {
                  const wasSelecting = selecting
                  setSelecting(true)
                  store.setSelected(previous =>
                    wasSelecting ? [...new Set([...previous, ...memberIds])] : [...new Set(memberIds)],
                  )
                }}
                onCreateCustomGroup={parent =>
                  setGroupDialog({ kind: 'create', initialMembers: [], parent })
                }
                onRenameCustomGroup={group => setGroupDialog({ kind: 'rename', group })}
                onDeleteCustomGroup={group => setGroupDialog({ kind: 'delete', group })}
                onCreateGroupNode={createGroupNode}
                onCopyNodes={copyNodes}
                onPasteNodes={group => addToGroup(group, clipboardIds)}
                onDragNodes={startNodeDrag}
                onDragEnd={endNodeDrag}
                onDropNodes={group => {
                  addToGroup(group, draggedIds)
                  endNodeDrag()
                }}
                draggingNodes={draggedIds.length > 0}
                clipboardSize={clipboardIds.length}
                onImport={onImport}
              />
            </NodeTreePanel>
          )}
        </AnimatePresence>

        <div className="@container flex min-h-0 min-w-0 flex-1 flex-col gap-2.5">
          <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2.5">
            <div className="flex min-h-9 shrink-0 flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
              <div className="flex min-w-0 flex-wrap items-center gap-2.5">
                {!treeOpen && (
                  <motion.button
                    type="button"
                    aria-label="展开分组树"
                    title="展开订阅与分组"
                    whileHover={{ scale: 1.05 }}
                    whileTap={{ scale: 0.92 }}
                    transition={{ type: 'spring', stiffness: 520, damping: 28 }}
                    onMouseEnter={() => setHoveredTool('expandTree')}
                    onMouseLeave={() => setHoveredTool(prev => (prev === 'expandTree' ? null : prev))}
                    onClick={() => {
                      setHoveredTool(null)
                      setTreeOpen(true)
                    }}
                    className="grid size-7 shrink-0 place-items-center rounded-[7px] border border-border bg-secondary text-secondary-foreground shadow-2xs outline-none transition-colors duration-150 hover:border-accent-border hover:bg-accent-soft/85 hover:text-primary focus-visible:ring-2 focus-visible:ring-ring/60"
                  >
                    <motion.span
                      className="grid place-items-center"
                      animate={
                        hoveredTool === 'expandTree' ? { x: 2, scale: 1.06 } : { x: 0, scale: 1 }
                      }
                      transition={{ type: 'spring', stiffness: 460, damping: 24 }}
                    >
                      <PanelLeftOpen className="size-4 stroke-[1.9]" />
                    </motion.span>
                  </motion.button>
                )}

                <div className="flex items-baseline gap-2">
                  {scopeSubtitle && (
                    <span className="text-xs text-muted-foreground">
                      <FlagText text={scopeSubtitle} /> /
                    </span>
                  )}
                  <h2 className="text-[15px] font-semibold text-foreground">
                    <FlagText text={scopeTitle} />
                  </h2>
                  <span className="mono text-xs text-muted-foreground">{filtered.length}</span>
                  {scope.kind !== 'all' && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setScope({ kind: 'all' })
                        setPage(1)
                      }}
                      className="h-6 px-1.5 text-xs text-primary hover:text-primary"
                    >
                      显示全部
                    </Button>
                  )}
                </div>

                <Separator orientation="vertical" className="h-3.5" />

                {selecting ? (
                  <>
                    <Button
                      type="button"
                      variant="subtle"
                      size="sm"
                      onClick={exitSelection}
                    >
                      <X data-icon="inline-start" />
                      退出选择
                    </Button>
                    <AirCheckbox
                      label="全选"
                      checked={
                        checked > 0 && checked < visible.length
                          ? 'indeterminate'
                          : visible.length > 0 && checked === visible.length
                      }
                      disabled={!visible.length}
                      onChange={selectPage}
                    >
                      <span className="text-xs font-medium text-muted-foreground">全选</span>
                    </AirCheckbox>
                    <Badge variant="accent" className="mono">
                      已选 {activeSelected.length} 个
                    </Badge>
                    <Button
                      type="button"
                      variant="subtle"
                      size="sm"
                      disabled={!activeSelected.length}
                      onClick={() =>
                        setGroupDialog({ kind: 'assign', nodeIds: activeSelected })
                      }
                    >
                      加入分组
                    </Button>
                  </>
                ) : (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={!filtered.length}
                    onClick={() => {
                      store.setSelected([])
                      setSelecting(true)
                    }}
                  >
                    <CheckSquare data-icon="inline-start" />
                    多选
                  </Button>
                )}
              </div>

              <div className="ml-auto flex min-w-0 max-w-full flex-wrap items-center justify-end gap-1.5">
                <AirSelect
                  variant="ghost"
                  label="排序"
                  value={sort}
                  options={sortOptions}
                  leading={<ArrowDownUp />}
                  trailing={null}
                  onChange={value => {
                    setSort(value)
                    setPage(1)
                  }}
                />

                {mode === 'cards' && (
                  <>
                    <Separator orientation="vertical" className="mx-0.5 hidden h-3.5 @[380px]:block" />
                    <Segmented
                      layoutId="node-library-card-density"
                      ariaLabel="卡片布局密度"
                      value={density}
                      options={densityOptions}
                      onChange={setDensity}
                    />
                  </>
                )}

                <Separator orientation="vertical" className="mx-0.5 hidden h-3.5 @[380px]:block" />

                <Segmented
                  layoutId="node-library-view-mode"
                  ariaLabel="视图"
                  value={mode}
                  options={viewModes}
                  onChange={setMode}
                />
              </div>
            </div>

            {chainOpen && chainSelection && (
              <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 rounded-[8px] border border-accent-border/45 bg-accent-soft/55 px-3 py-1.5 text-xs">
                <div className="flex flex-wrap items-center gap-1.5">
                  <Waypoints className="size-3.5 shrink-0 text-primary" />
                  <span className="font-medium text-foreground">链路选点：</span>
                  {chainSelection.hops.map((hopId, index) => {
                    const active = chainSelection.activeHopIndex === index
                    const role = hopRoleLabel(index, chainSelection.hops.length)
                    return (
                      <button
                        key={index}
                        type="button"
                        onClick={() => chainSelection.onSelectHopIndex(index)}
                        className={cn(
                          'inline-flex h-6 items-center gap-1 rounded-[5px] border px-2 text-xs font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring/60',
                          active
                            ? 'border-primary bg-primary text-primary-foreground shadow-2xs'
                            : hopId
                              ? 'border-border bg-card text-foreground hover:border-accent-border'
                              : 'border-dashed border-primary/40 bg-card/85 text-primary hover:bg-card',
                        )}
                      >
                        <span>
                          第 {index + 1} 跳 · {role}
                        </span>
                        {hopId && !active && (
                          <span
                            className={cn(
                              'size-1.5 rounded-full',
                              index === chainSelection.hops.length - 1 ? 'bg-success' : 'bg-primary',
                            )}
                          />
                        )}
                      </button>
                    )
                  })}
                </div>
                <span className="text-[12px] text-muted-foreground">
                  {chainSelection.activeHopIndex !== null
                    ? `直接点击下方节点填入第 ${chainSelection.activeHopIndex + 1} 跳`
                    : '点击左侧胶囊或右侧跳位卡片切换选点目标'}
                </span>
              </div>
            )}

            <ContextMenu>
              <ContextMenuTrigger
                render={
                  <div className="air-scroll flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden overflow-y-auto pr-0.5" />
                }
              >
                {!visible.length ? (
                  <div className="flex flex-1 flex-col items-center justify-center gap-3 rounded-[11px] border border-dashed border-border bg-card/60 p-8 text-center">
                    <div className="grid size-11 place-items-center rounded-full bg-accent-soft text-primary">
                      <Layers className="size-5" />
                    </div>
                    <strong className="text-sm font-semibold text-foreground">
                      {store.library.nodes.length ? '没有匹配的节点' : '还没有节点'}
                    </strong>
                    {!store.library.nodes.length && (
                      <div className="flex items-center gap-2">
                        <Button variant="default" onClick={onImport}>
                          <Plus data-icon="inline-start" />
                          导入订阅
                        </Button>
                        <Button variant="secondary" onClick={addNode}>
                          <Plus data-icon="inline-start" />
                          添加自定义节点
                        </Button>
                      </div>
                    )}
                  </div>
                ) : mode === 'cards' ? (
                  <div
                    className={cn(
                      'grid min-w-0 pb-1',
                      density === 'compact'
                        ? 'grid-cols-[repeat(auto-fill,minmax(min(100%,184px),1fr))] gap-2'
                        : density === 'normal'
                          ? 'grid-cols-[repeat(auto-fill,minmax(min(100%,256px),1fr))] gap-2.5'
                          : 'grid-cols-[repeat(auto-fill,minmax(min(100%,308px),1fr))] gap-2.5',
                    )}
                  >
                    {visible.map(node => {
                      const isChosen = !node.subscriptionNotice && selectedOutboundId === node.id
                      const isSelecting = selectingNodeId === node.id
                      const isMultiSelected = selecting && selectedIds.has(node.id)
                      const canMultiSelect = selecting
                      const canAssign = !selecting && pickingForChain && !node.subscriptionNotice
                      const canChoose = !selecting && !pickingForChain && !nodeActionDisabled && !isChosen && !node.subscriptionNotice
                      const cardClickable = canMultiSelect || canAssign || canChoose
                      const hopIndex =
                        chainOpen && chainSelection ? chainSelection.hops.indexOf(node.id) : -1
                      const isLastHop =
                        hopIndex !== -1 &&
                        Boolean(chainSelection) &&
                        hopIndex === (chainSelection?.hops.length ?? 0) - 1
                      const isActiveHopTarget =
                        hopIndex !== -1 &&
                        Boolean(chainSelection) &&
                        chainSelection?.activeHopIndex === hopIndex
                      return renderNodeContextMenu(
                        node,
                        <Card
                          {...nodeDragProps(node.id)}
                          onClick={
                            canMultiSelect
                              ? () => selectNode(node.id, !isMultiSelected)
                              : canAssign
                                ? () => chainSelection?.onAssignNode(node.id)
                                : canChoose
                                  ? () => onChooseNode(node.id)
                                  : undefined
                          }
                          className={cn(
                            'relative min-w-0 overflow-hidden transition-[transform,border-color,background-color,box-shadow,outline-color] duration-150',
                            density === 'compact' ? 'gap-1.5 px-2.5 py-2' : 'gap-2.5 p-3.5',
                            cardClickable && 'cursor-pointer active:translate-y-0 active:scale-[0.988]',
                            isMultiSelected
                              ? 'border-primary bg-accent-soft/55 ring-1 ring-primary/25'
                              : canMultiSelect
                                ? isChosen
                                  ? 'border-primary/70 hover:-translate-y-[1px] hover:border-primary hover:bg-accent-soft/20 hover:shadow-sm'
                                  : 'hover:-translate-y-[1px] hover:border-primary/55 hover:bg-accent-soft/20 hover:shadow-sm'
                                : isChosen
                                  ? 'border-primary outline-2 -outline-offset-2 outline-primary'
                                  : isActiveHopTarget
                                    ? 'border-primary bg-accent-soft/55 ring-1 ring-primary/30'
                                    : hopIndex !== -1
                                      ? 'border-accent-border bg-accent-soft/30'
                                      : cardClickable && 'hover:-translate-y-[1px] hover:border-accent-border hover:bg-card hover:shadow-sm',
                          )}
                        >
                          {isChosen ? (
                            <Pin
                              data-slot="node-outbound-marker"
                              aria-hidden="true"
                              className="pointer-events-none absolute top-1.5 right-2 size-[17px] rotate-45 fill-destructive stroke-destructive [&_path:first-child]:stroke-muted-foreground"
                            />
                          ) : isSelecting && (
                            <span
                              data-slot="node-outbound-marker"
                              aria-hidden="true"
                              className="pointer-events-none absolute top-2.5 right-2.5 size-2.5 rounded-full border border-primary/50 bg-primary/10 motion-safe:animate-pulse"
                            />
                          )}
                          <div className="flex min-w-0 items-start justify-between gap-1.5 pr-4">
                            <div className="min-w-0 flex-1" title={node.name}>
                              {nodeName(node, true)}
                            </div>
                            {hopIndex !== -1 && chainSelection && (
                              <Badge
                                variant={isLastHop ? 'success' : 'accent'}
                                className={cn('shrink-0', density === 'compact' && 'h-5 px-1')}
                              >
                                {density === 'compact'
                                  ? `${hopIndex + 1}跳`
                                  : `第 ${hopIndex + 1} 跳 · ${hopRoleLabel(hopIndex, chainSelection.hops.length)}`}
                              </Badge>
                            )}
                          </div>

                          {density === 'compact' ? (
                            <div className="mt-auto flex flex-col gap-1.5">
                              <div className="flex min-w-0 items-center">
                                <Badge
                                  variant="mono"
                                  className="h-5 max-w-full truncate px-1.5 leading-none"
                                  title={formatProtocol(node.protocol)}
                                >
                                  {node.subscriptionNotice ? '订阅提示' : formatProtocol(node.protocol)}
                                </Badge>
                              </div>
                              <div className="flex items-center justify-between gap-1.5 pt-0.5">
                                <div
                                  title={`24h 可用率：${ratio(node.availability)}`}
                                  className="flex min-w-0 items-baseline gap-1 text-[12px]"
                                >
                                  <span className="shrink-0 text-muted-foreground">24h</span>
                                  <strong
                                    className={cn(
                                      'mono shrink-0 tabular-nums text-xs font-semibold',
                                      node.availability !== null && node.availability >= 0.98
                                        ? 'text-success'
                                        : 'text-foreground',
                                    )}
                                  >
                                    {ratio(node.availability)}
                                  </strong>
                                </div>
                                {latest(node, true)}
                              </div>
                            </div>
                          ) : (
                          <>
                            <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
                              <span className="truncate">
                                <FlagText text={node.source} />
                              </span>
                              <Badge variant="mono">{node.subscriptionNotice ? '订阅提示' : formatProtocol(node.protocol)}</Badge>
                            </div>

                            <div className="mt-auto flex flex-col gap-2.5">
                              {density === 'detailed' && (
                                <div className="flex items-center justify-between gap-2 rounded-[6px] bg-muted/45 px-2 py-1 text-xs text-muted-foreground">
                                  <span
                                    className="mono min-w-0 truncate"
                                    title={`${node.server}:${node.port}`}
                                  >
                                    {node.server}:{node.port}
                                  </span>
                                  <span
                                    className={cn(
                                      'inline-flex shrink-0 items-center gap-1 font-medium',
                                      node.status === 'available'
                                        ? 'text-success'
                                        : node.status === 'timeout' || node.status === 'unreachable'
                                          ? 'text-destructive'
                                          : 'text-muted-foreground',
                                    )}
                                  >
                                    <span
                                      className={cn(
                                        'size-1.5 rounded-full',
                                        node.status === 'available'
                                          ? 'bg-success'
                                          : node.status === 'timeout' || node.status === 'unreachable'
                                            ? 'bg-destructive'
                                            : 'bg-icon-muted',
                                      )}
                                    />
                                    {nodeStatusLabel(node.status)}
                                  </span>
                                </div>
                              )}

                              <Separator />

                              <div className="grid grid-cols-[repeat(3,minmax(0,1fr))_72px] items-start gap-1.5 pt-0.5">
                                <div className="flex min-w-0 flex-col items-center gap-1 text-center">
                                  <span className="max-w-full truncate text-[12px] text-muted-foreground">
                                    24h 可用
                                  </span>
                                  <strong
                                    className={cn(
                                      'mono flex h-6 items-center justify-center tabular-nums whitespace-nowrap text-xs font-semibold',
                                      node.availability !== null && node.availability >= 0.98
                                        ? 'text-success'
                                        : 'text-foreground',
                                    )}
                                  >
                                    {ratio(node.availability)}
                                  </strong>
                                </div>
                                <div className="flex min-w-0 flex-col items-center gap-1 text-center">
                                  <span className="max-w-full truncate text-[12px] text-muted-foreground">
                                    连续可用
                                  </span>
                                  <strong className="mono max-w-full truncate text-xs leading-6 font-semibold text-foreground" title={span(node.continuousMs)}>
                                    {span(node.continuousMs)}
                                  </strong>
                                </div>
                                <div className="flex min-w-0 flex-col items-center gap-1 text-center">
                                  <span className="max-w-full truncate text-[12px] text-muted-foreground">
                                    平均延迟
                                  </span>
                                  <strong className="mono max-w-full truncate text-xs leading-6 font-semibold text-foreground" title={delay(node.averageMs)}>
                                    {delay(node.averageMs)}
                                  </strong>
                                </div>
                                <div className="flex min-w-0 flex-col items-center gap-1 text-center">
                                  <span className="text-[12px] text-muted-foreground">
                                    最近延迟
                                  </span>
                                  {latest(node)}
                                </div>
                              </div>
                            </div>
                          </>
                        )}
                      </Card>,
                    )
                  })}
                </div>
              ) : (
                <Table aria-label="节点列表">
                  <TableHeader>
                    <TableRow>
                      <TableHead className="px-2.5">{sortHead('name', '节点')}</TableHead>
                      <TableHead className="px-2.5">来源 / 协议</TableHead>
                      <TableHead className="w-19 px-2.5">出站</TableHead>
                      <TableHead className={cn('px-2.5', dualSidebars && 'hidden 2xl:table-cell')}>
                        {sortHead('availability', '24h 可用')}
                      </TableHead>
                      <TableHead className={cn('px-2.5', hasInspector || treeOpen ? 'hidden 2xl:table-cell' : 'hidden xl:table-cell')}>
                        连续可用
                      </TableHead>
                      <TableHead className={cn('px-2.5', dualSidebars && 'hidden 2xl:table-cell')}>
                        {sortHead('averageMs', '平均延迟')}
                      </TableHead>
                      <TableHead className="px-2.5 text-right">{sortHead('latestMs', '最近延迟', true)}</TableHead>
                      <TableHead className="w-9 px-2">
                        <span className="sr-only">编辑</span>
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {visible.map(node => {
                      const hopIndex =
                        chainOpen && chainSelection ? chainSelection.hops.indexOf(node.id) : -1
                      const isLastHop =
                        hopIndex !== -1 &&
                        Boolean(chainSelection) &&
                        hopIndex === (chainSelection?.hops.length ?? 0) - 1
                      return renderNodeContextMenu(
                        node,
                        <TableRow
                          {...nodeDragProps(node.id)}
                          data-selected={hopIndex !== -1 || (selecting && selectedIds.has(node.id))}
                          onClick={
                            selecting
                              ? () => selectNode(node.id, !selectedIds.has(node.id))
                              : pickingForChain
                                ? () => chainSelection?.onAssignNode(node.id)
                                : undefined
                          }
                          className={selecting || pickingForChain ? 'cursor-pointer' : undefined}
                        >
                          <TableCell className="max-w-[260px] px-2.5">
                            <div className="flex min-w-0 items-center gap-1.5" title={node.name}>
                              <div className="min-w-0 flex-1">{nodeName(node)}</div>
                              {hopIndex !== -1 && chainSelection && (
                                <Badge variant={isLastHop ? 'success' : 'accent'} className="shrink-0">
                                  第 {hopIndex + 1} 跳
                                </Badge>
                              )}
                            </div>
                          </TableCell>
                          <TableCell className="px-2.5">
                            <div className="flex items-center gap-1.5 text-muted-foreground">
                              <span className="max-w-[84px] truncate" title={node.source}>
                                <FlagText text={node.source} />
                              </span>
                              <Badge variant="mono">{formatProtocol(node.protocol)}</Badge>
                            </div>
                          </TableCell>
                          <TableCell className="px-2.5">{nodeChoice(node)}</TableCell>
                          <TableCell className={cn('mono px-2.5', dualSidebars && 'hidden 2xl:table-cell')}>
                            {ratio(node.availability)}
                          </TableCell>
                          <TableCell className={cn('mono px-2.5', hasInspector || treeOpen ? 'hidden 2xl:table-cell' : 'hidden xl:table-cell')}>
                            {span(node.continuousMs)}
                          </TableCell>
                          <TableCell className={cn('mono px-2.5', dualSidebars && 'hidden 2xl:table-cell')}>
                            {delay(node.averageMs)}
                          </TableCell>
                          <TableCell className="px-2.5 text-right">{latest(node)}</TableCell>
                          <TableCell className="px-2 text-right">{edit(node)}</TableCell>
                        </TableRow>,
                      )
                    })}
                  </TableBody>
                </Table>
              )}
              </ContextMenuTrigger>

              <ContextMenuContent>
                <ContextMenuItem
                  disabled={!filtered.length || batchTesting}
                  onClick={() =>
                    run(() =>
                      store.batch(
                        activeSelected.length ? activeSelected : filtered.map(node => node.id),
                      ),
                    )
                  }
                >
                  <Activity />
                  {activeSelected.length ? `批量测速（已选 ${activeSelected.length}）` : '测速全部节点'}
                </ContextMenuItem>
                <ContextMenuItem
                  disabled={!visible.length}
                  onClick={() => {
                    if (!selecting) {
                      setSelecting(true)
                      store.setSelected(visible.map(node => node.id))
                    } else {
                      selectPage(checked < visible.length)
                    }
                  }}
                >
                  <CheckSquare />
                  {selecting && visible.length > 0 && checked === visible.length ? '取消全选当前页' : '全选当前页'}
                </ContextMenuItem>
                {selecting && activeSelected.length > 0 && (
                  <ContextMenuItem onClick={() => store.setSelected([])}>
                    <X />
                    清空已选（{activeSelected.length}）
                  </ContextMenuItem>
                )}
                <ContextMenuSeparator />
                {activeCustomGroup && (
                  <ContextMenuItem disabled={!clipboardIds.length} onClick={() => addToGroup(activeCustomGroup, clipboardIds)}>
                    <ClipboardPaste />
                    粘贴节点
                  </ContextMenuItem>
                )}
                <ContextMenuItem onClick={addNode}>
                  <Plus />
                  {activeCustomGroup ? '在此分组新建节点' : '添加自定义节点'}
                </ContextMenuItem>
                <ContextMenuItem
                  onClick={() => setGroupDialog({ kind: 'create', initialMembers: activeSelected })}
                >
                  <Layers />
                  新建自定义分组
                </ContextMenuItem>
                <ContextMenuSub>
                  <ContextMenuSubTrigger>
                    <LayoutGrid />
                    视图与密度
                  </ContextMenuSubTrigger>
                  <ContextMenuSubContent>
                    <ContextMenuItem onClick={() => setMode('cards')}>
                      {mode === 'cards' ? <Check className="text-primary" /> : <LayoutGrid />}
                      卡片视图
                    </ContextMenuItem>
                    <ContextMenuItem onClick={() => setMode('table')}>
                      {mode === 'table' ? <Check className="text-primary" /> : <List />}
                      列表视图
                    </ContextMenuItem>
                    <ContextMenuSeparator />
                    {densityOptions.map(option => (
                      <ContextMenuItem
                        key={option.value}
                        onClick={() => {
                          setMode('cards')
                          setDensity(option.value)
                        }}
                      >
                        {mode === 'cards' && density === option.value ? (
                          <Check className="text-primary" />
                        ) : (
                          <LayoutGrid />
                        )}
                        {option.label}卡片
                      </ContextMenuItem>
                    ))}
                  </ContextMenuSubContent>
                </ContextMenuSub>
                <ContextMenuSeparator />
                <ContextMenuItem onClick={() => run(async () => {
                  await store.refresh()
                  if (store.kernelPath && filtered.length && !batchTesting) {
                    await store.batch(filtered.map(node => node.id))
                  }
                })}>
                  <RefreshCw />
                  刷新列表和测速结果
                </ContextMenuItem>
              </ContextMenuContent>
            </ContextMenu>

            <footer className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-border pt-2.5 text-xs text-muted-foreground @[440px]:justify-between">
              <span className="mono hidden whitespace-nowrap @[440px]:inline">
                显示 {filtered.length ? (page - 1) * pageSize + 1 : 0}–
                {Math.min(page * pageSize, filtered.length)} / {filtered.length}
              </span>
              <div className="flex items-center gap-2">
                <div className="w-28">
                  <AirSelect
                    label="每页条数"
                    value={String(pageSize)}
                    options={pageSizes}
                    side="top"
                    leading={<ChevronDown />}
                    trailing={null}
                    className="h-7.5"
                    onChange={value => {
                      setPageSize(Number(value))
                      setPage(1)
                    }}
                  />
                </div>
                <div className="flex items-center gap-1">
                  <Button
                    variant="secondary"
                    size="icon-sm"
                    aria-label="上一页"
                    disabled={page === 1}
                    onClick={() => setPage(page - 1)}
                  >
                    <ChevronLeft />
                  </Button>
                  <span
                    aria-current="page"
                    className="mono grid h-7 min-w-7 place-items-center rounded-[6px] border border-accent-border/45 bg-accent-soft px-1.5 font-semibold text-primary"
                  >
                    {page}
                  </span>
                  <Button
                    variant="secondary"
                    size="icon-sm"
                    aria-label="下一页"
                    disabled={page >= maxPage}
                    onClick={() => setPage(page + 1)}
                  >
                    <ChevronRight />
                  </Button>
                </div>
              </div>
            </footer>
          </div>
        </div>

        <AnimatePresence initial={false}>
          {children && (
            <motion.aside
              key="node-inspector-drawer"
              initial={{ opacity: 0, width: 0, x: 14 }}
              animate={{ opacity: 1, width: 344, x: 0 }}
              exit={{ opacity: 0, width: 0, x: 14 }}
              transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
              className="min-h-0 shrink-0 overflow-hidden"
            >
              <div className="h-full w-[344px]">{children}</div>
            </motion.aside>
          )}
        </AnimatePresence>
      </div>

      <CustomGroupDialog
        state={groupDialog}
        groups={store.customGroups}
        validNodeIds={validNodeIds}
        onClose={() => setGroupDialog({ kind: 'none' })}
        onSaveGroup={async input => {
          const saved = await store.saveCustomGroup(input)
          if (input.parentId) selectGroup(saved.id)
          return saved
        }}
        onAssignExisting={async (groupIds, nodeIds) => {
          for (const groupId of groupIds) {
            await store.addNodesToCustomGroup(groupId, nodeIds)
          }
        }}
        onDeleteGroup={id => store.deleteCustomGroup(id)}
      />
    </section>
  )
}
