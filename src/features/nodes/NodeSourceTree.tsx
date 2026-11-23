import { preferences } from '@/shared/lib/preferences'
import { tr } from '@/shared/i18n/messages'
import {
  Bookmark,
  CheckSquare,
  ChevronDown,
  ChevronRight,
  ClipboardPaste,
  CloudDownload,
  Copy,
  FileCode2,
  Folder,
  FolderOpen,
  FolderPlus,
  Layers,
  Network,
  PanelLeftClose,
  Pencil,
  Plus,
  RefreshCw,
  Server,
  Trash2,
} from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useMemo, useState, type DragEvent, type ReactNode } from 'react'
import { cn } from '@/shared/lib/utils'
import { Card } from '@/shared/ui/card'
import { FlagText } from '@/shared/ui/FlagText'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/shared/ui/context-menu'
import { Separator } from '@/shared/ui/separator'
import type { CustomGroup, Library } from '@/platform/desktop/air'

export type NodeScope =
  | { kind: 'all' }
  | { kind: 'source'; sourceId: string }
  | { kind: 'group'; sourceId: string; name: string }
  | { kind: 'customGroup'; groupId: string }

export const nodeDragType = 'application/x-air-nodes'

interface Props {
  library: Library
  customGroups: CustomGroup[]
  scope: NodeScope
  onSelectScope: (scope: NodeScope) => void
  onCollapse: () => void
  onRefreshSource?: (sourceId: string) => void
  onEditYaml?: (sourceId: string) => void
  onAddCustom?: () => void
  onSelectGroupNodes?: (memberIds: string[]) => void
  onCreateCustomGroup?: (parent?: CustomGroup) => void
  onRenameCustomGroup?: (group: CustomGroup) => void
  onDeleteCustomGroup?: (group: CustomGroup) => void
  onCreateGroupNode: (groupId: string) => void
  onCopyNodes: (ids: string[]) => void
  onPasteNodes: (group: CustomGroup) => void
  onDragNodes: (event: DragEvent, ids: string[]) => void
  onDragEnd: () => void
  onDropNodes: (group: CustomGroup) => void
  draggingNodes: boolean
  clipboardSize: number
  onImport?: () => void
}

export function isCustomSource(source: Library['sources'][number]) {
  return source.id === 'custom' || source.details?.kind === 'custom'
}

function loadIdSet(key: string): Set<string> {
  try {
    const parsed: unknown = JSON.parse(preferences.getItem(key) ?? 'null')
    if (Array.isArray(parsed)) {
      return new Set(parsed.filter((item): item is string => typeof item === 'string'))
    }
  } catch { /* Ignore invalid saved set. */ }
  return new Set()
}

export function NodeSourceTree({
  library,
  customGroups,
  scope,
  onSelectScope,
  onCollapse,
  onRefreshSource,
  onEditYaml,
  onAddCustom,
  onSelectGroupNodes,
  onCreateCustomGroup,
  onRenameCustomGroup,
  onDeleteCustomGroup,
  onCreateGroupNode,
  onCopyNodes,
  onPasteNodes,
  onDragNodes,
  onDragEnd,
  onDropNodes,
  draggingNodes,
  clipboardSize,
  onImport,
}: Props) {
  const subscriptionSources = library.sources.filter(source => !isCustomSource(source))
  const customSource = library.sources.find(isCustomSource)
  const customNodeCount =
    customSource?.nodes ?? library.nodes.filter(node => node.sourceId === 'custom').length
  const { validNodeIds, nodesBySource } = useMemo(() => {
    const nodesBySource = new Map<string, string[]>()
    const validNodeIds = new Set<string>()
    for (const node of library.nodes) {
      validNodeIds.add(node.id)
      let ids = nodesBySource.get(node.sourceId)
      if (!ids) nodesBySource.set(node.sourceId, ids = [])
      ids.push(node.id)
    }
    return { validNodeIds, nodesBySource }
  }, [library.nodes])
  const { byId, byParent } = useMemo(() => {
    const byId = new Map(customGroups.map(group => [group.id, group]))
    const byParent = new Map<string | undefined, CustomGroup[]>()
    for (const group of customGroups) {
      const parentId = group.parentId && byId.has(group.parentId) ? group.parentId : undefined
      let children = byParent.get(parentId)
      if (!children) byParent.set(parentId, children = [])
      children.push(group)
    }
    return { byId, byParent }
  }, [customGroups])
  const expandableSourceIds = subscriptionSources
    .filter(source => library.groups.some(group => group.sourceId === source.id))
    .map(source => source.id)

  const [collapsedSources, setCollapsedSources] = useState<Set<string>>(() => loadIdSet('air.nodeTreeCollapsedSources'))
  const [hoveredTool, setHoveredTool] = useState<'collapse' | 'newGroup' | null>(null)
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => loadIdSet('air.nodeTreeCollapsedGroups'))
  const [dropGroupId, setDropGroupId] = useState<string>()
  const selectedGroup = scope.kind === 'customGroup' ? scope.groupId : undefined

  useEffect(() => {
    preferences.setItem('air.nodeTreeCollapsedSources', JSON.stringify([...collapsedSources]))
  }, [collapsedSources])

  useEffect(() => {
    preferences.setItem('air.nodeTreeCollapsedGroups', JSON.stringify([...collapsedGroups]))
  }, [collapsedGroups])

  useEffect(() => {
    const ancestors = new Set<string>()
    let parent = selectedGroup ? byId.get(selectedGroup)?.parentId : undefined
    while (parent && !ancestors.has(parent)) {
      ancestors.add(parent)
      parent = byId.get(parent)?.parentId
    }
    setCollapsedGroups(current => {
      if (![...ancestors].some(id => current.has(id))) return current
      return new Set([...current].filter(id => !ancestors.has(id)))
    })
  }, [selectedGroup, byId])

  function toggleCustomGroup(id: string) {
    setCollapsedGroups(current => {
      const next = new Set(current)
      if (!next.delete(id)) next.add(id)
      return next
    })
  }

  function toggleExpand(sourceId: string) {
    setCollapsedSources(previous => {
      const next = new Set(previous)
      if (!next.delete(sourceId)) next.add(sourceId)
      return next
    })
  }

  function renderCustomGroups(parentId?: string): ReactNode {
    return byParent.get(parentId)?.map(group => {
      const children = byParent.get(group.id)
      const isExpanded = Boolean(children) && !collapsedGroups.has(group.id)
      const validMembers = group.members.filter(id => validNodeIds.has(id))
      const chosen = selectedGroup === group.id
      return (
        <div key={group.id} className="flex min-w-0 flex-col gap-0.5">
          <div
            data-custom-group={group.id}
            data-drop-active={draggingNodes && dropGroupId === group.id ? '' : undefined}
            className={cn(
              'group flex min-w-0 items-center gap-0.5 rounded-[7px] transition-colors data-[drop-active]:bg-accent-soft data-[drop-active]:text-primary data-[drop-active]:ring-1 data-[drop-active]:ring-inset data-[drop-active]:ring-primary',
              chosen ? 'bg-accent-soft font-semibold text-primary' : 'hover:bg-accent-soft/75',
              children && 'pl-1',
            )}
            onDragOver={event => {
              if (!event.dataTransfer.types.includes(nodeDragType)) return
              event.preventDefault()
              event.dataTransfer.dropEffect = 'copy'
              setDropGroupId(group.id)
            }}
            onDragLeave={event => {
              if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return
              setDropGroupId(current => current === group.id ? undefined : current)
            }}
            onDrop={event => {
              if (!event.dataTransfer.types.includes(nodeDragType)) return
              event.preventDefault()
              event.stopPropagation()
              setDropGroupId(undefined)
              onDropNodes(group)
            }}
          >
            {children && (
              <button
                type="button"
                aria-label={`${isExpanded ? tr('收起') : tr('展开')} ${group.name}`}
                aria-expanded={isExpanded}
                onClick={() => toggleCustomGroup(group.id)}
                className="grid size-5 shrink-0 place-items-center rounded-[5px] text-muted-foreground outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/60"
              >
                {isExpanded ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
              </button>
            )}
            <ContextMenu>
              <ContextMenuTrigger
                render={
                  <button
                    type="button"
                    aria-current={chosen ? 'true' : undefined}
                    aria-expanded={children ? isExpanded : undefined}
                    onClick={() => {
                      if (!chosen) onSelectScope({ kind: 'customGroup', groupId: group.id })
                      if (children) toggleCustomGroup(group.id)
                    }}
                    className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-[7px] px-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/60"
                  />
                }
              >
                <Bookmark className={cn('size-4 shrink-0 stroke-[1.9]', chosen ? 'text-primary' : 'text-muted-foreground')} />
                <span className="min-w-0 flex-1 truncate" title={group.name}><FlagText text={group.name} /></span>
                <span className={cn('mono shrink-0 text-xs', !chosen && 'text-muted-foreground')}>{validMembers.length}</span>
              </ContextMenuTrigger>
              <ContextMenuContent>
                <ContextMenuItem disabled={!clipboardSize} onClick={() => onPasteNodes(group)}>
                  <ClipboardPaste />
                  {clipboardSize ? tr("粘贴节点（{0}）", clipboardSize) : tr('粘贴节点')}
                </ContextMenuItem>
                {validMembers.length > 0 && (
                  <ContextMenuItem onClick={() => onCopyNodes(validMembers)}><Copy />{tr("复制组内节点")}</ContextMenuItem>
                )}
                <ContextMenuSeparator />
                <ContextMenuItem onClick={() => onCreateGroupNode(group.id)}><Plus />{tr("新建节点")}</ContextMenuItem>
                {onCreateCustomGroup && (
                  <ContextMenuItem onClick={() => onCreateCustomGroup(group)}><FolderPlus />{tr("新建子分组")}</ContextMenuItem>
                )}
                <ContextMenuSeparator />
                <ContextMenuItem onClick={() => onSelectScope({ kind: 'customGroup', groupId: group.id })}>
                  <Bookmark />{tr("筛选此分组节点")}</ContextMenuItem>
                {onSelectGroupNodes && validMembers.length > 0 && (
                  <ContextMenuItem onClick={() => onSelectGroupNodes(validMembers)}><CheckSquare />{tr("勾选组内全部节点")}</ContextMenuItem>
                )}
                {(onRenameCustomGroup || onDeleteCustomGroup) && <ContextMenuSeparator />}
                {onRenameCustomGroup && (
                  <ContextMenuItem onClick={() => onRenameCustomGroup(group)}><Pencil />{tr("重命名分组")}</ContextMenuItem>
                )}
                {onDeleteCustomGroup && (
                  <ContextMenuItem variant="destructive" onClick={() => onDeleteCustomGroup(group)}><Trash2 />{tr("删除分组")}</ContextMenuItem>
                )}
              </ContextMenuContent>
            </ContextMenu>
          </div>
          {isExpanded && (
            <div className="ml-3 flex min-w-0 flex-col gap-0.5 border-l border-border-subtle pl-2">
              {renderCustomGroups(group.id)}
            </div>
          )}
        </div>
      )
    })
  }

  return (
    <Card
      aria-label={tr("订阅与分组目录")}
      className="h-full min-h-0 w-full gap-2 p-2.5 text-sm select-none"
    >
      <div className="flex shrink-0 items-center justify-between gap-2 px-1 py-0.5">
        <span className="flex min-w-0 items-center gap-1.5 font-semibold text-foreground">
          <Layers className="size-4 shrink-0 text-primary" />
          <span className="truncate">{tr("订阅与分组")}</span>
        </span>
        <motion.button
          type="button"
          aria-label={tr("收起分组树")}
          title={tr("收起分组树")}
          whileHover={{ scale: 1.06 }}
          whileTap={{ scale: 0.92 }}
          transition={{ type: 'spring', stiffness: 520, damping: 28 }}
          onMouseEnter={() => setHoveredTool('collapse')}
          onMouseLeave={() => setHoveredTool(prev => (prev === 'collapse' ? null : prev))}
          onClick={onCollapse}
          className="grid size-6 place-items-center rounded-[6px] text-secondary-foreground/80 outline-none transition-colors duration-150 hover:bg-accent-soft/85 hover:text-primary focus-visible:ring-2 focus-visible:ring-ring/60"
        >
          <motion.span
            className="grid place-items-center"
            animate={hoveredTool === 'collapse' ? { x: -2, scale: 1.06 } : { x: 0, scale: 1 }}
            transition={{ type: 'spring', stiffness: 460, damping: 24 }}
          >
            <PanelLeftClose className="size-4 stroke-[1.9]" />
          </motion.span>
        </motion.button>
      </div>

      <Separator />

      <ContextMenu>
        <ContextMenuTrigger
          render={
            <div className="air-scroll flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto pr-0.5" />
          }
        >
          <button
            type="button"
            onClick={() => onSelectScope({ kind: 'all' })}
            className={cn(
              'group flex h-9 shrink-0 items-center gap-2 rounded-[7px] px-2 text-left transition-[background-color,color,transform] duration-150 outline-none active:scale-[0.985] focus-visible:ring-2 focus-visible:ring-ring/60',
              scope.kind === 'all'
                ? 'bg-accent-soft font-semibold text-primary'
                : 'text-foreground hover:bg-accent-soft/75 hover:text-primary',
            )}
          >
            <Network
              className={cn(
                'size-4 shrink-0 stroke-[1.9] transition-[transform,color] duration-150 group-hover:scale-110 group-hover:text-primary',
                scope.kind === 'all' ? 'text-primary' : 'text-secondary-foreground/75',
              )}
            />
            <span className="min-w-0 flex-1 truncate">{tr("全部节点")}</span>
            <span
              className={cn(
                'mono shrink-0 text-xs transition-colors duration-150 group-hover:text-primary',
                scope.kind === 'all' ? 'text-primary' : 'text-muted-foreground',
              )}
            >
              {library.nodes.length}
            </span>
          </button>

        {subscriptionSources.length > 0 && (
          <div className="mt-1.5 flex flex-col gap-0.5">
            <span className="px-2 pb-1 text-xs font-semibold text-muted-foreground">{tr("订阅来源")}</span>

            {subscriptionSources.map(source => {
              const sourceGroups = library.groups.filter(group => group.sourceId === source.id)
              const hasChildren = sourceGroups.length > 0
              const isExpanded = hasChildren && !collapsedSources.has(source.id)
              const sourceSelected = scope.kind === 'source' && scope.sourceId === source.id
              const childSelected = scope.kind === 'group' && scope.sourceId === source.id
              const canRefresh = source.details?.kind !== 'file'
              const sourceNodes = nodesBySource.get(source.id) ?? []

              return (
                <div key={source.id} className="flex flex-col gap-0.5">
                  <ContextMenu>
                    <ContextMenuTrigger
                      render={
                        <div
                          className={cn(
                          'group flex h-9 items-center rounded-[7px] transition-colors duration-150',
                            sourceSelected
                              ? 'bg-accent-soft text-primary'
                              : childSelected
                                ? 'bg-muted/45 text-foreground hover:bg-accent-soft/75 hover:text-primary'
                                : 'text-foreground hover:bg-accent-soft/75 hover:text-primary',
                          )}
                        />
                      }
                    >
                      {hasChildren ? (
                        <motion.button
                          type="button"
                          aria-label={isExpanded ? tr("收起 {0}", source.name) : tr("展开 {0}", source.name)}
                          aria-expanded={isExpanded}
                          whileHover={{ scale: 1.08 }}
                          whileTap={{ scale: 0.9 }}
                          transition={{ type: 'spring', stiffness: 520, damping: 28 }}
                          onClick={() => toggleExpand(source.id)}
                          className="grid h-full w-6 shrink-0 place-items-center rounded-[5px] text-secondary-foreground/75 transition-colors duration-150 hover:bg-accent-soft hover:text-primary outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
                        >
                          <motion.span
                            className="grid place-items-center"
                            initial={false}
                            animate={{ rotate: isExpanded ? 90 : 0 }}
                            transition={{ type: 'spring', stiffness: 460, damping: 30 }}
                          >
                            <ChevronRight className="size-4 stroke-[2]" />
                          </motion.span>
                        </motion.button>
                      ) : (
                        <span className="w-6 shrink-0" />
                      )}

                      <button
                        type="button"
                        aria-current={sourceSelected ? 'true' : undefined}
                        aria-expanded={hasChildren ? isExpanded : undefined}
                        draggable={sourceNodes.length > 0}
                        onDragStart={event => onDragNodes(event, sourceNodes)}
                        onDragEnd={onDragEnd}
                        onClick={() => {
                          if (!sourceSelected) onSelectScope({ kind: 'source', sourceId: source.id })
                          if (hasChildren) toggleExpand(source.id)
                        }}
                        className="flex h-full min-w-0 flex-1 items-center gap-1.5 pr-2 pl-1 text-left transition-transform duration-150 active:scale-[0.985] outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
                      >
                        {hasChildren && isExpanded ? (
                          <FolderOpen
                            className={cn(
                              'size-4 shrink-0 stroke-[1.9] transition-[transform,color] duration-150 group-hover:scale-110 group-hover:text-primary',
                              sourceSelected ? 'text-primary' : 'text-primary/85',
                            )}
                          />
                        ) : (
                          <Folder
                            className={cn(
                              'size-4 shrink-0 stroke-[1.9] transition-[transform,color] duration-150 group-hover:scale-110 group-hover:text-primary',
                              sourceSelected ? 'text-primary' : 'text-secondary-foreground/75',
                            )}
                          />
                        )}
                        <span
                          className={cn(
                            'min-w-0 flex-1 truncate',
                            sourceSelected && 'font-semibold',
                          )}
                          title={source.name}
                        >
                          <FlagText text={source.name} />
                        </span>
                        <span
                          className={cn(
                            'mono shrink-0 text-xs transition-colors duration-150 group-hover:text-primary',
                            sourceSelected ? 'text-primary' : 'text-muted-foreground',
                          )}
                        >
                          {source.nodes}
                        </span>
                      </button>
                    </ContextMenuTrigger>

                    <ContextMenuContent>
                      <ContextMenuItem
                        onClick={() => {
                          onSelectScope({ kind: 'source', sourceId: source.id })
                          if (hasChildren && !isExpanded) toggleExpand(source.id)
                        }}
                      >
                        <FolderOpen />{tr("查看该订阅节点")}</ContextMenuItem>
                      {sourceNodes.length > 0 && (
                        <ContextMenuItem onClick={() => onCopyNodes(sourceNodes)}>
                          <Copy />{tr("复制订阅节点")}</ContextMenuItem>
                      )}
                      {hasChildren && (
                        <ContextMenuItem onClick={() => toggleExpand(source.id)}>
                          {isExpanded ? <ChevronDown /> : <ChevronRight />}
                          {isExpanded ? tr('收起下属分组') : tr('展开下属分组')}
                        </ContextMenuItem>
                      )}
                      {(onRefreshSource || onEditYaml) && <ContextMenuSeparator />}
                      {onRefreshSource && (
                        <ContextMenuItem
                          disabled={!canRefresh}
                          onClick={() => onRefreshSource(source.id)}
                        >
                          <RefreshCw />{tr("刷新订阅")}</ContextMenuItem>
                      )}
                      {onEditYaml && (
                        <ContextMenuItem onClick={() => onEditYaml(source.id)}>
                          <FileCode2 />{tr("编辑 YAML")}</ContextMenuItem>
                      )}
                    </ContextMenuContent>
                  </ContextMenu>

                  <AnimatePresence initial={false}>
                    {hasChildren && isExpanded && (
                      <motion.div
                        key={`${source.id}-groups`}
                        initial={{ opacity: 0, height: 0 }}
                        animate={{ opacity: 1, height: 'auto' }}
                        exit={{ opacity: 0, height: 0 }}
                        transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
                        className="overflow-hidden"
                      >
                        <div className="ml-3.5 flex flex-col gap-0.5 border-l border-border-subtle pl-2">
                          {sourceGroups.map(group => {
                            const chosen =
                              scope.kind === 'group' &&
                              scope.sourceId === group.sourceId &&
                              scope.name === group.name
                            return (
                              <ContextMenu key={`${group.sourceId}:${group.name}`}>
                                <ContextMenuTrigger
                                  render={
                                    <button
                                      type="button"
                                      draggable={group.members.length > 0}
                                      onDragStart={event => onDragNodes(event, group.members)}
                                      onDragEnd={onDragEnd}
                                      onClick={() =>
                                        onSelectScope({
                                          kind: 'group',
                                          sourceId: group.sourceId,
                                          name: group.name,
                                        })
                                      }
                                      className={cn(
                                        'group flex h-8 items-center gap-1.5 rounded-[6px] px-2 text-left transition-[background-color,color,transform] duration-150 active:scale-[0.985] outline-none focus-visible:ring-2 focus-visible:ring-ring/60',
                                        chosen
                                          ? 'bg-accent-soft font-semibold text-primary'
                                          : 'text-secondary-foreground/80 hover:bg-accent-soft/75 hover:text-primary',
                                      )}
                                    />
                                  }
                                >
                                  <Layers
                                    className={cn(
                                      'size-4 shrink-0 stroke-[1.9] transition-[transform,color] duration-150 group-hover:scale-110 group-hover:text-primary',
                                      chosen ? 'text-primary' : 'text-secondary-foreground/65',
                                    )}
                                  />
                                  <span className="min-w-0 flex-1 truncate" title={group.name}>
                                    <FlagText text={group.name} />
                                  </span>
                                  <span
                                    className={cn(
                                      'mono shrink-0 text-xs transition-colors duration-150 group-hover:text-primary',
                                      chosen ? 'text-primary' : 'text-muted-foreground',
                                    )}
                                  >
                                    {group.members.length}
                                  </span>
                                </ContextMenuTrigger>

                                <ContextMenuContent>
                                  <ContextMenuItem
                                    onClick={() =>
                                      onSelectScope({
                                        kind: 'group',
                                        sourceId: group.sourceId,
                                        name: group.name,
                                      })
                                    }
                                  >
                                    <Layers />{tr("筛选此分组节点")}</ContextMenuItem>
                                  {group.members.length > 0 && (
                                    <ContextMenuItem onClick={() => onCopyNodes(group.members)}>
                                      <Copy />{tr("复制组内节点")}</ContextMenuItem>
                                  )}
                                  {onSelectGroupNodes && group.members.length > 0 && (
                                    <ContextMenuItem
                                      onClick={() => onSelectGroupNodes(group.members)}
                                    >
                                      <CheckSquare />{tr("勾选组内全部节点")}</ContextMenuItem>
                                  )}
                                </ContextMenuContent>
                              </ContextMenu>
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

        <div className="mt-1.5 flex flex-col gap-0.5">
          <div className="flex items-center justify-between px-2 pb-1">
            <span className="text-xs font-semibold text-muted-foreground">{tr("本地自定义")}</span>
            {onCreateCustomGroup && (
              <motion.button
                type="button"
                aria-label={tr("新建自定义分组")}
                title={tr("新建自定义分组")}
                whileHover={{ scale: 1.08 }}
                whileTap={{ scale: 0.9 }}
                transition={{ type: 'spring', stiffness: 520, damping: 28 }}
                onMouseEnter={() => setHoveredTool('newGroup')}
                onMouseLeave={() => setHoveredTool(prev => (prev === 'newGroup' ? null : prev))}
                onClick={() => onCreateCustomGroup()}
                className="grid size-5 place-items-center rounded-[5px] text-secondary-foreground/80 transition-colors duration-150 hover:bg-accent-soft/85 hover:text-primary outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
              >
                <motion.span
                  className="grid place-items-center"
                  animate={
                    hoveredTool === 'newGroup'
                      ? { rotate: 90, scale: 1.08 }
                      : { rotate: 0, scale: 1 }
                  }
                  transition={{ type: 'spring', stiffness: 460, damping: 24 }}
                >
                  <Plus className="size-4 stroke-[2]" />
                </motion.span>
              </motion.button>
            )}
          </div>

          <ContextMenu>
            <ContextMenuTrigger
              render={
                <button
                  type="button"
                  onClick={() => onSelectScope({ kind: 'source', sourceId: 'custom' })}
                  className={cn(
                    'group flex h-9 shrink-0 items-center gap-2 rounded-[7px] px-2 text-left transition-[background-color,color,transform] duration-150 active:scale-[0.985] outline-none focus-visible:ring-2 focus-visible:ring-ring/60',
                    scope.kind === 'source' && scope.sourceId === 'custom'
                      ? 'bg-accent-soft font-semibold text-primary'
                      : 'text-foreground hover:bg-accent-soft/75 hover:text-primary',
                  )}
                />
              }
            >
              <Server
                className={cn(
                  'size-4 shrink-0 stroke-[1.9] transition-[transform,color] duration-150 group-hover:scale-110 group-hover:text-primary',
                  scope.kind === 'source' && scope.sourceId === 'custom'
                    ? 'text-primary'
                    : 'text-secondary-foreground/75',
                )}
              />
              <span className="min-w-0 flex-1 truncate">{tr("自定义节点")}</span>
              <span
                className={cn(
                  'mono shrink-0 text-xs transition-colors duration-150 group-hover:text-primary',
                  scope.kind === 'source' && scope.sourceId === 'custom'
                    ? 'text-primary'
                    : 'text-muted-foreground',
                )}
              >
                {customNodeCount}
              </span>
            </ContextMenuTrigger>

            <ContextMenuContent>
              <ContextMenuItem
                onClick={() => onSelectScope({ kind: 'source', sourceId: 'custom' })}
              >
                <Server />{tr("查看自定义节点")}</ContextMenuItem>
              {onAddCustom && (
                <ContextMenuItem onClick={onAddCustom}>
                  <Plus />{tr("添加自定义节点")}</ContextMenuItem>
              )}
            </ContextMenuContent>
          </ContextMenu>

          {renderCustomGroups()}
        </div>

        {subscriptionSources.length === 0 && customNodeCount === 0 && customGroups.length === 0 && (
          <p className="px-2 py-3 text-xs leading-relaxed text-muted-foreground">{tr("导入订阅或添加自定义节点、自定义分组后，可在此按结构快速切换查看。")}</p>
        )}
        </ContextMenuTrigger>

        <ContextMenuContent>
          <ContextMenuItem onClick={() => onSelectScope({ kind: 'all' })}>
            <Network />{tr("查看全部节点")}</ContextMenuItem>
          {(onAddCustom || onCreateCustomGroup) && <ContextMenuSeparator />}
          {onAddCustom && (
            <ContextMenuItem onClick={onAddCustom}>
              <Plus />{tr("添加自定义节点")}</ContextMenuItem>
          )}
          {onCreateCustomGroup && (
            <ContextMenuItem onClick={() => onCreateCustomGroup()}>
              <Layers />{tr("新建自定义分组")}</ContextMenuItem>
          )}
          {expandableSourceIds.length > 0 && (
            <>
              <ContextMenuSeparator />
              <ContextMenuItem onClick={() => setCollapsedSources(new Set())}>
                <ChevronDown />{tr("展开全部分组")}</ContextMenuItem>
              <ContextMenuItem onClick={() => setCollapsedSources(new Set(expandableSourceIds))}>
                <ChevronRight />{tr("收起全部分组")}</ContextMenuItem>
            </>
          )}
          {onImport && (
            <>
              <ContextMenuSeparator />
              <ContextMenuItem onClick={onImport}>
                <CloudDownload />{tr("导入订阅")}</ContextMenuItem>
            </>
          )}
        </ContextMenuContent>
      </ContextMenu>
    </Card>
  )
}
