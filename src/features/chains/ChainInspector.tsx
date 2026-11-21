import {
  AppWindow,
  Activity,
  ArrowDown,
  ArrowDownToLine,
  ArrowUp,
  Check,
  MousePointerClick,
  Play,
  Plus,
  Trash2,
  Waypoints,
  X,
} from 'lucide-react'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { cn, formatProtocol } from '@/shared/lib/utils'
import { Badge } from '@/shared/ui/badge'
import { Button } from '@/shared/ui/button'
import { FlagText } from '@/shared/ui/FlagText'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/shared/ui/context-menu'
import { Input } from '@/shared/ui/input'
import { Label } from '@/shared/ui/label'
import { showMessage } from '@/shared/ui/message'
import { Separator } from '@/shared/ui/separator'
import { air, type ChainProbeResult, type ChainRecord, type ExitVerification, type NodeRecord, type ProxyMode } from '@/platform/desktop/air'
import { AirSelect } from '../../shared/ui/AirSelect'

interface Props {
  nodes: NodeRecord[]
  chains: ChainRecord[]
  activeChainId: string
  chainName: string
  hops: string[]
  activeHopIndex: number | null
  kernelPath: string
  proxyRunning: boolean
  proxyMode: ProxyMode
  proxyPending?: 'start' | 'stop'
  verified?: ExitVerification
  onSelectChain: (id: string) => void
  onNewChain: () => void
  onSaveChain: () => Promise<void>
  onStartChain: () => void
  onDeleteChain: (id: string) => void
  onChangeName: (name: string) => void
  onChangeHops: (hops: string[]) => void
  onActiveHopChange: (index: number | null) => void
  onClose: () => void
  onSettings: () => void
  onBind: () => void
  onProbeResult: (result: ChainProbeResult) => void
  onError: (error: unknown) => void
}

export function hopRoleLabel(index: number, total: number) {
  if (index === 0) return '前置'
  if (index === total - 1) return '出口'
  return '中转'
}

export function ChainInspector({
  nodes,
  chains,
  activeChainId,
  chainName,
  hops,
  activeHopIndex,
  kernelPath,
  proxyRunning,
  proxyMode,
  proxyPending,
  verified,
  onSelectChain,
  onNewChain,
  onSaveChain,
  onStartChain,
  onDeleteChain,
  onChangeName,
  onChangeHops,
  onActiveHopChange,
  onClose,
  onSettings,
  onBind,
  onProbeResult,
  onError,
}: Props) {
  const [pending, setPending] = useState(false)
  const [saving, setSaving] = useState(false)
  const [savedFeedback, setSavedFeedback] = useState(false)
  const savedTimer = useRef<number | undefined>(undefined)

  useEffect(() => () => window.clearTimeout(savedTimer.current), [])

  const nodeById = new Map(nodes.map(node => [node.id, node]))
  const readyHops = hops.filter(id => Boolean(id && nodeById.has(id)))
  const allFilled = hops.length >= 2 && readyHops.length === hops.length
  const chainStartHint = proxyRunning
    ? '顶部可停止当前代理'
    : proxyMode === 'direct'
      ? '切换为规则或全局模式后可启动链路'
      : undefined
  const chainOptions = chains.map(chain => ({
    value: chain.id,
    label: `${chain.name}（${chain.hops.length} 跳）`,
  }))

  function addHop() {
    const next = [...hops, '']
    onChangeHops(next)
    onActiveHopChange(next.length - 1)
  }

  function moveHop(index: number, delta: -1 | 1) {
    const target = index + delta
    if (target < 0 || target >= hops.length) return
    const next = [...hops]
    const current = next[index]!
    next[index] = next[target]!
    next[target] = current
    onChangeHops(next)
    if (activeHopIndex === index) onActiveHopChange(target)
    else if (activeHopIndex === target) onActiveHopChange(index)
  }

  function moveToExit(index: number) {
    const last = hops.length - 1
    if (index < 0 || index >= last) return
    const next = [...hops]
    const [item] = next.splice(index, 1)
    next.push(item!)
    onChangeHops(next)
    if (activeHopIndex === index) onActiveHopChange(last)
    else if (activeHopIndex !== null && activeHopIndex > index) {
      onActiveHopChange(activeHopIndex - 1)
    }
  }

  function removeOrClearHop(index: number) {
    if (hops.length > 2) {
      const next = hops.filter((_, i) => i !== index)
      onChangeHops(next)
      if (activeHopIndex === null) return
      if (activeHopIndex === index) {
        onActiveHopChange(Math.min(index, next.length - 1))
      } else if (activeHopIndex > index) {
        onActiveHopChange(activeHopIndex - 1)
      }
      return
    }
    const next = [...hops]
    next[index] = ''
    onChangeHops(next)
    onActiveHopChange(index)
  }

  async function verifyChain() {
    if (!kernelPath) {
      onSettings()
      return
    }
    if (!allFilled) {
      onError('请先在左侧节点库依次点选并填满每一跳节点')
      return
    }
    setPending(true)
    try {
      const outcome = await air.verify(kernelPath, hops)
      onProbeResult(outcome)
      showMessage({
        type: 'success',
        title: `整链可达 · ${outcome.latencyMs} ms`,
        description: `出口 IP ${outcome.ip}`,
      })
    } catch (error) {
      onProbeResult({ error: error instanceof Error ? error.message : String(error) })
      onError(error)
    } finally {
      setPending(false)
    }
  }

  async function save() {
    if (saving) return
    if (!allFilled) {
      onError('链路至少需要 2 跳有效节点，请在左侧节点库选择后保存')
      return
    }
    setSaving(true)
    setSavedFeedback(false)
    try {
      await onSaveChain()
      setSavedFeedback(true)
      showMessage({ type: 'success', title: '链路已保存' })
      window.clearTimeout(savedTimer.current)
      savedTimer.current = window.setTimeout(() => setSavedFeedback(false), 1500)
    } catch (error) {
      onError(error)
    } finally {
      setSaving(false)
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault()
    void save()
  }

  return (
    <form
      onSubmit={submit}
      className="flex h-full min-h-0 flex-col rounded-[11px] border border-border bg-card shadow-(--shadow-drawer)"
    >
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-4 py-3">
        <div className="flex items-center gap-2">
          <span className="grid size-6.5 place-items-center rounded-[6px] bg-accent-soft text-primary">
            <Waypoints className="size-3.5" />
          </span>
          <h2 className="text-sm font-semibold text-foreground">链路配置</h2>
        </div>
        <Button type="button" variant="ghost" size="icon-sm" aria-label="关闭链路" onClick={onClose}>
          <X />
        </Button>
      </div>

      <div className="air-scroll flex min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto px-4 py-3.5">
        <div className="flex items-center gap-1.5">
          <div className="min-w-0 flex-1">
            <AirSelect
              label="已保存链路"
              value={activeChainId}
              placeholder={chains.length ? '新建或选择已有链路' : '当前为新建链路'}
              options={chainOptions}
              onChange={onSelectChain}
            />
          </div>
          <Button type="button" variant="secondary" size="sm" onClick={onNewChain}>
            新建
          </Button>
          {activeChainId && (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="删除当前链路"
              onClick={() => onDeleteChain(activeChainId)}
              className="text-destructive hover:bg-danger-soft hover:text-destructive"
            >
              <Trash2 />
            </Button>
          )}
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="chain-name-input">链路名称</Label>
          <Input
            id="chain-name-input"
            maxLength={80}
            placeholder="选填，默认按首尾节点自动命名"
            value={chainName}
            onChange={e => onChangeName(e.target.value)}
          />
        </div>

        <Separator />

        <ContextMenu>
          <ContextMenuTrigger render={<div className="flex flex-1 flex-col gap-3.5" />}>
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                按顺序经过（{hops.length} 跳）
              </span>
              <Badge variant="accent">最后一跳即为出口</Badge>
            </div>

            <p className="flex items-center gap-1.5 rounded-[7px] border border-border-subtle bg-muted/35 px-2.5 py-2 text-[12px] text-muted-foreground">
              <MousePointerClick className="size-3.5 shrink-0 text-primary" />
              <span>选中任意一跳后，在左侧节点列表直接点击节点即可填入</span>
            </p>

            <div className="relative flex flex-col gap-2.5 pl-5">
              <div
                className="absolute top-4 bottom-6 left-[7px] w-px bg-border"
                aria-hidden="true"
              />

              {hops.map((hopId, index) => {
                const node = hopId ? nodeById.get(hopId) : undefined
                const role = hopRoleLabel(index, hops.length)
                const isFirst = index === 0
                const isLast = index === hops.length - 1
                const isActive = activeHopIndex === index

                const hopCard = (
                  <div
                    role="button"
                    tabIndex={0}
                    onClick={() => onActiveHopChange(index)}
                    onKeyDown={e => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        onActiveHopChange(index)
                      }
                    }}
                    className={cn(
                      'relative flex cursor-pointer flex-col gap-2 rounded-[9px] border p-2.5 text-left transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/60',
                      isActive
                        ? 'border-primary bg-accent-soft/50 ring-1 ring-primary/25'
                        : 'border-border-subtle bg-muted/35 hover:border-accent-border',
                    )}
                  >
                    <span
                      aria-hidden="true"
                      className={cn(
                        'absolute top-3.5 -left-[18px] size-2.5 rounded-full border-2 border-card',
                        isLast
                          ? 'bg-success shadow-[0_0_0_3px_var(--success-soft)]'
                          : isFirst
                            ? 'bg-primary shadow-[0_0_0_3px_var(--accent-soft)]'
                            : 'bg-sky-500 shadow-[0_0_0_3px_var(--accent-soft)]',
                      )}
                    />

                    <div className="flex items-center justify-between gap-1.5">
                      <div className="flex min-w-0 items-center gap-1.5">
                        <span className="text-xs font-semibold text-foreground">
                          第 {index + 1} 跳 · {role}
                        </span>
                        {isActive && (
                          <Badge variant="accent" className="h-5 px-1.5">
                            选点中
                          </Badge>
                        )}
                      </div>

                      <div
                        className="flex shrink-0 items-center gap-0.5"
                        onClick={e => e.stopPropagation()}
                      >
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`上移第 ${index + 1} 跳`}
                          disabled={index === 0}
                          onClick={() => moveHop(index, -1)}
                          className="size-6 text-muted-foreground hover:text-foreground"
                        >
                          <ArrowUp className="size-3" />
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`下移第 ${index + 1} 跳`}
                          disabled={index === hops.length - 1}
                          onClick={() => moveHop(index, 1)}
                          className="size-6 text-muted-foreground hover:text-foreground"
                        >
                          <ArrowDown className="size-3" />
                        </Button>
                        {(hops.length > 2 || node) && (
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-sm"
                            aria-label={hops.length > 2 ? `删除第 ${index + 1} 跳` : `清空第 ${index + 1} 跳`}
                            onClick={() => removeOrClearHop(index)}
                            className="size-6 text-muted-foreground hover:bg-danger-soft hover:text-destructive"
                          >
                            <X className="size-3" />
                          </Button>
                        )}
                      </div>
                    </div>

                    {node ? (
                      <div className="flex flex-col gap-1 rounded-[7px] border border-border-subtle bg-card px-2.5 py-2">
                        <div className="flex items-center justify-between gap-2">
                          <strong className="truncate text-xs font-semibold text-foreground">
                            <FlagText text={node.name} />
                          </strong>
                          <Badge variant="mono">{formatProtocol(node.protocol)}</Badge>
                        </div>
                        <div className="flex items-center justify-between text-xs text-muted-foreground">
                          <span className="truncate">
                            <FlagText text={node.source} />
                          </span>
                          <span className="mono shrink-0">
                            {node.latestMs !== null ? `${node.latestMs} ms` : '待测速'}
                          </span>
                        </div>
                      </div>
                    ) : (
                      <div
                        className={cn(
                          'flex items-center justify-center rounded-[7px] border border-dashed px-2.5 py-2.5 text-xs',
                          isActive
                            ? 'border-primary/50 bg-card/70 text-primary font-medium'
                            : 'border-border bg-card/40 text-muted-foreground',
                        )}
                      >
                        {hopId ? '原节点已不存在，请从左侧重选' : '请在左侧节点库点选节点填入'}
                      </div>
                    )}
                  </div>
                )

                return (
                  <ContextMenu key={index}>
                    <ContextMenuTrigger render={hopCard} />
                    <ContextMenuContent>
                      <ContextMenuItem onClick={() => onActiveHopChange(index)}>
                        <MousePointerClick />
                        在左侧重选节点
                      </ContextMenuItem>
                      <ContextMenuSeparator />
                      <ContextMenuItem disabled={isFirst} onClick={() => moveHop(index, -1)}>
                        <ArrowUp />
                        上移一跳
                      </ContextMenuItem>
                      <ContextMenuItem disabled={isLast} onClick={() => moveHop(index, 1)}>
                        <ArrowDown />
                        下移一跳
                      </ContextMenuItem>
                      <ContextMenuItem disabled={isLast} onClick={() => moveToExit(index)}>
                        <ArrowDownToLine />
                        移至末尾设为出口
                      </ContextMenuItem>
                      {(hops.length > 2 || node) && (
                        <>
                          <ContextMenuSeparator />
                          <ContextMenuItem
                            variant="destructive"
                            onClick={() => removeOrClearHop(index)}
                          >
                            <Trash2 />
                            {hops.length > 2 ? '删除此跳' : '清空当前跳'}
                          </ContextMenuItem>
                        </>
                      )}
                    </ContextMenuContent>
                  </ContextMenu>
                )
              })}
            </div>

            <Button type="button" variant="secondary" size="sm" onClick={addHop} className="w-full">
              <Plus data-icon="inline-start" />
              添加一跳
            </Button>

            <Separator />

            <div className="flex items-center justify-between gap-2 rounded-[8px] border border-border-subtle bg-muted/30 px-3 py-2">
              <div className="flex flex-col">
                <span className="text-xs font-medium text-foreground">应用分流</span>
                <span className="text-[12px] text-muted-foreground">按 Windows 程序绑定当前链路</span>
              </div>
              <Button type="button" variant="secondary" size="sm" onClick={onBind}>
                <AppWindow data-icon="inline-start" />
                绑定应用
              </Button>
            </div>

            {verified && (
              <div
                role="status"
                className="flex items-center gap-2.5 rounded-[8px] border border-success/30 bg-success-soft px-3 py-2.5 text-success"
              >
                <Check className="size-4 shrink-0" />
                <div className="flex min-w-0 flex-col gap-0.5">
                  <strong className="mono text-xs font-semibold">{verified.ip}</strong>
                  <span className="text-xs opacity-90">{verified.latencyMs} ms · 整链出口可达</span>
                </div>
              </div>
            )}
          </ContextMenuTrigger>

          <ContextMenuContent>
            <ContextMenuItem onClick={addHop}>
              <Plus />
              添加一跳
            </ContextMenuItem>
            <ContextMenuItem onClick={onNewChain}>
              <Waypoints />
              新建空白链路
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem disabled={saving || !allFilled} onClick={() => void save()}>
              <Check />
              保存当前链路
            </ContextMenuItem>
            <ContextMenuItem disabled={pending || !allFilled} onClick={() => void verifyChain()}>
              <Activity />
              {pending ? '探测中…' : '测整链'}
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
      </div>

      <div className="flex shrink-0 flex-col gap-1.5 border-t border-border px-4 py-3">
        {chainStartHint && (
          <p className="text-[12px] text-muted-foreground">{chainStartHint}</p>
        )}
        <div className="flex flex-wrap items-center gap-1.5">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={pending || !allFilled}
            onClick={() => void verifyChain()}
          >
            <Activity data-icon="inline-start" />
            {pending ? '探测中…' : '测整链'}
          </Button>
          <Button type="submit" variant={savedFeedback ? 'subtle' : 'secondary'} size="sm" disabled={saving || !allFilled}>
            <Check data-icon="inline-start" />
            {saving ? '保存中…' : savedFeedback ? '已保存' : '保存链路'}
          </Button>
          <Button
            type="button"
            variant="default"
            size="sm"
            disabled={!allFilled || saving || proxyRunning || Boolean(proxyPending) || proxyMode === 'direct'}
            aria-busy={proxyPending === 'start' || undefined}
            onClick={onStartChain}
          >
            <Play data-icon="inline-start" />
            {proxyPending === 'start' ? '正在启动…' : proxyRunning ? '代理运行中' : '启动此链路'}
          </Button>
        </div>
      </div>
    </form>
  )
}
