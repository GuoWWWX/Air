import {
  Activity,
  AlertCircle,
  CheckCircle2,
  ChevronRight,
  Copy,
  Globe,
  Layers,
  MinusCircle,
  Search,
  Waypoints,
} from 'lucide-react'
import { useState } from 'react'
import { cn, formatBytes, formatProtocol } from '@/shared/lib/utils'
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
import type { ChainProbeResult, NodeRecord, ProxyStatus, ProxyTelemetry } from '@/platform/desktop/air'
import { hopRoleLabel } from '../chains/ChainInspector'
import { ConnectionApp } from '@/shared/ui/ConnectionApp'

interface ConnectionsPageProps {
  proxy: ProxyStatus
  telemetry?: ProxyTelemetry
  probe?: ChainProbeResult
  hops: string[]
  chainName: string
  nodes: NodeRecord[]
  onOpenChain: () => void
}

const filterOptions = [
  { value: 'all', label: '全部' },
  { value: 'ok', label: '已连通' },
  { value: 'warn', label: '异常' },
] as const

export function ConnectionsPage({
  proxy,
  telemetry,
  probe,
  hops,
  chainName,
  nodes,
  onOpenChain,
}: ConnectionsPageProps) {
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<'all' | 'ok' | 'warn'>('all')
  const [selectedId, setSelectedId] = useState<string>('')
  const nodeById = new Map(nodes.map(node => [node.id, node]))
  const draftHops = hops.map(id => nodeById.get(id))
  const draftPath = draftHops.map((node, index) => node?.name ?? `第 ${index + 1} 跳待选`)
  const verified = probe && 'ip' in probe ? probe : undefined
  const probeError = probe && 'error' in probe ? probe.error : undefined
  const records = [
    ...(probe
      ? [
          {
            id: 'verify-chain',
            kind: 'probe' as const,
            app: '出口探测',
            appExecutable: undefined,
            appIcon: undefined,
            target: verified?.ip ?? '出口验证服务',
            rule: chainName || `多跳链路（${hops.length} 跳）`,
            chain: draftPath.join(' → '),
            path: draftPath,
            ok: Boolean(verified),
            totalBytes: undefined,
            traffic: '整链探测不统计流量',
          },
        ]
      : []),
    ...(telemetry?.connections ?? []).map(conn => ({
      id: conn.id,
      kind: 'live' as const,
      app: conn.app,
      appExecutable: conn.appExecutable,
      appIcon: conn.appIconKey ? telemetry?.appIcons?.[conn.appIconKey] : undefined,
      target: conn.target,
      rule: conn.rule,
      chain: conn.path.join(' → ') || '—',
      path: conn.path,
      ok: true,
      totalBytes: conn.downloadBytes + conn.uploadBytes,
      traffic: `下载 ${formatBytes(conn.downloadBytes)} / 上传 ${formatBytes(conn.uploadBytes)}`,
    })),
  ]

  const q = search.trim().toLowerCase()
  const visible = records.filter(row => {
    if (filter === 'ok' && !row.ok) return false
    if (filter === 'warn' && row.ok) return false
    return !q || [row.app, row.appExecutable, row.target, row.rule, row.chain].some(v => v?.toLowerCase().includes(q))
  })

  const active = visible.find(row => row.id === selectedId) ?? visible[0]
  const activeConnection = active?.kind === 'live' ? active : undefined
  const showingProbe = active?.kind === 'probe'
  const hopNodes = showingProbe || !proxy.running ? draftHops : proxy.mode === 'direct' ? [] : proxy.outbound?.hops ?? []
  const filledCount = hopNodes.filter(Boolean).length
  const exitNode = hopNodes.at(-1)
  const pathText = active?.chain ?? (filledCount
    ? hopNodes.map((node, index) => node?.name ?? `第 ${index + 1} 跳待选`).join(' → ')
    : proxy.running ? proxy.mode === 'direct' ? '直连模式' : '按分流规则' : '尚未配置多跳链路')

  function copyText(text: string, label: string) {
    if (!navigator.clipboard) {
      showMessage({ type: 'error', title: '当前环境不支持剪贴板' })
      return
    }
    void navigator.clipboard.writeText(text)
      .then(() => showMessage({ type: 'success', title: `已复制${label}` }))
      .catch(() => showMessage({ type: 'error', title: `复制${label}失败` }))
  }

  return (
    <section className="flex h-full min-h-0 flex-col gap-3 px-5 py-4">
      <header className="flex min-h-11 shrink-0 items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-4 whitespace-nowrap">
          <h1 className="text-[26px] font-bold leading-tight tracking-tight text-foreground">
            连接日志
          </h1>
          <TraceLines variant="connections" />
        </div>
        <div className="flex items-center gap-2">
          <Badge variant={proxy.running ? 'success' : 'default'}>
            <span
              className={cn(
                'size-1.5 rounded-full',
                proxy.running ? 'bg-success' : 'bg-icon-muted',
              )}
            />
            {proxy.running ? '内核运行中' : '内核未启动'}
          </Badge>
          <Button variant="default" onClick={onOpenChain}>
            <Activity data-icon="inline-start" />
            测整链
          </Button>
        </div>
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 lg:grid-cols-[minmax(0,1fr)_360px]">
        <Card className="min-h-0 min-w-0 gap-3 p-4">
          <CardHeader>
            <div className="flex items-center gap-2">
              <Activity className="size-4 text-primary" />
              <CardTitle>{telemetry?.stale ? '探测与最近采样' : '探测与连接记录'}</CardTitle>
              <Badge variant="default" className="mono">
                {visible.length}
              </Badge>
            </div>
            <div className="flex items-center gap-2">
              <div className="relative w-40">
                <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  placeholder="筛选目标或链路"
                  aria-label="筛选连接记录"
                  className="h-7.5 pl-8 text-xs"
                />
              </div>
              <Segmented
                layoutId="connections-filter"
                ariaLabel="连接状态筛选"
                value={filter}
                options={filterOptions}
                onChange={setFilter}
              />
            </div>
          </CardHeader>

          <ContextMenu>
            <ContextMenuTrigger render={<CardContent className="min-h-0 min-w-0 flex-1" />}>
              {visible.length > 0 ? (
                <Table aria-label="探测与连接记录" containerClassName="min-h-0 flex-1" className="min-w-[32rem] table-fixed">
                  <TableHeader>
                    <TableRow className="[&>th]:text-center">
                      <TableHead className="w-[24%] px-2.5">来源 / 应用</TableHead>
                      <TableHead className="w-[28%] px-2.5">出口目标</TableHead>
                      <TableHead className="px-2.5">链路路径</TableHead>
                      <TableHead className="w-[4.75rem] px-2.5">状态</TableHead>
                      <TableHead className="w-[5.75rem] px-2.5">累计流量</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {visible.map(row => (
                      <ContextMenu key={row.id}>
                        <ContextMenuTrigger
                          render={
                            <TableRow
                              data-selected={active?.id === row.id}
                              onClick={() => setSelectedId(row.id)}
                              className="cursor-pointer"
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
                              <TableCell className="px-2.5 text-center">
                                <Badge variant={row.ok ? 'success' : 'default'}>
                                  {row.ok ? '已连通' : '探测失败'}
                                </Badge>
                              </TableCell>
                              <TableCell className="mono px-2.5 text-center" title={row.traffic}>
                                {row.totalBytes === undefined ? '—' : formatBytes(row.totalBytes)}
                              </TableCell>
                            </TableRow>
                          }
                        />
                        <ContextMenuContent>
                          <ContextMenuItem onClick={() => setSelectedId(row.id)}>
                            <Activity />
                            查看连接诊断
                          </ContextMenuItem>
                          <ContextMenuSeparator />
                          <ContextMenuItem onClick={() => copyText(row.target, '目标地址')}>
                            <Copy />
                            复制目标地址
                          </ContextMenuItem>
                          <ContextMenuItem onClick={() => copyText(row.chain, '链路路径')}>
                            <Copy />
                            复制链路路径
                          </ContextMenuItem>
                          <ContextMenuSeparator />
                          <ContextMenuItem onClick={onOpenChain}>
                            <Waypoints />
                            编辑当前链路
                          </ContextMenuItem>
                        </ContextMenuContent>
                      </ContextMenu>
                    ))}
                  </TableBody>
                </Table>
              ) : (
                <div className="flex flex-1 flex-col items-center justify-center gap-3 rounded-[9px] border border-dashed border-border bg-muted/25 p-8 text-center">
                  <div className="grid size-11 place-items-center rounded-full bg-accent-soft text-primary">
                    <Waypoints className="size-5" />
                  </div>
                  <div className="flex flex-col gap-1">
                    <strong className="text-sm font-semibold text-foreground">
                      {records.length ? '没有匹配的连接记录' : '暂无整链探测与连接记录'}
                    </strong>
                    <p className="max-w-xs text-xs text-muted-foreground">
                      {records.length
                        ? '请尝试调整筛选条件或清除搜索关键字。'
                        : '在节点库打开「链路」并从左侧依次点选各跳节点后，点击「测整链」或开启代理即可在此核验路径与连接状态。'}
                    </p>
                  </div>
                  {!records.length && (
                    <Button variant="subtle" onClick={onOpenChain}>
                      <Waypoints data-icon="inline-start" />
                      前往编排并测整链
                    </Button>
                  )}
                </div>
              )}
            </ContextMenuTrigger>

            <ContextMenuContent>
              <ContextMenuItem onClick={onOpenChain}>
                <Waypoints />
                编辑当前链路
              </ContextMenuItem>
              {(search || filter !== 'all') && (
                <>
                  <ContextMenuSeparator />
                  <ContextMenuItem
                    onClick={() => {
                      setSearch('')
                      setFilter('all')
                    }}
                  >
                    <Search />
                    重置筛选条件
                  </ContextMenuItem>
                </>
              )}
            </ContextMenuContent>
          </ContextMenu>
        </Card>

        <Card className="min-h-0 gap-3.5 p-4">
          <CardHeader>
            <div className="flex items-center gap-2">
              <Globe className="size-4 text-primary" />
              <CardTitle>连接诊断</CardTitle>
            </div>
            <Badge variant={active || verified ? 'success' : 'default'}>
              {active || verified ? '已验证' : '待验证'}
            </Badge>
          </CardHeader>

          <div className="flex items-center gap-3 rounded-[9px] border border-border-subtle bg-muted/45 p-3">
            <div className="grid size-8 shrink-0 place-items-center rounded-[7px] bg-accent-soft text-primary">
              <Layers className="size-4" />
            </div>
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <strong
                className="truncate text-xs font-semibold text-foreground"
                title={active ? `${active.app} · ${active.target}` : pathText}
              >
                {active ? `${active.app} · ${active.target}` : pathText}
              </strong>
              <span className="truncate text-xs text-muted-foreground" title={active ? active.chain : pathText}>
                {active?.rule || (proxy.running ? proxy.outbound?.name : chainName) || pathText}
              </span>
            </div>
          </div>

          <Separator />

          <div className="flex flex-col gap-2.5 text-xs">
            <div className="flex items-center justify-between gap-2">
              <span className="text-muted-foreground">{activeConnection ? '路径节点' : '总跳数'}</span>
              <span className="mono font-medium text-foreground">
                {activeConnection ? activeConnection.path.length || '—' : `${filledCount} / ${hopNodes.length} 跳`}
              </span>
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="text-muted-foreground">末跳出口</span>
              <span className="truncate font-medium text-foreground">
                <FlagText
                  text={
                    activeConnection
                      ? activeConnection.path.at(-1) ?? '—'
                      : exitNode
                        ? `${exitNode.name} (${exitNode.source})`
                        : '未选择'
                  }
                />
              </span>
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="text-muted-foreground">当前模式</span>
              <span className="font-medium text-foreground">
                {proxy.mode === 'rule' ? '规则' : proxy.mode === 'global' ? '全局' : '直连'}
              </span>
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="text-muted-foreground">
                {activeConnection ? '流量统计' : '探测出口 IP'}
              </span>
              <span className="mono font-semibold text-foreground">
                {activeConnection ? activeConnection.traffic : showingProbe && verified ? verified.ip : '—'}
              </span>
            </div>
          </div>

          <Separator />

          <div className="air-scroll flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto pr-0.5">
            <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              {activeConnection ? '内核报告的出站路径' : '链路诊断阶段'}
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
                    <strong className={cn('text-xs font-semibold', node ? 'text-success' : 'text-foreground')}>
                      第 {index + 1} 跳 · {role}
                      {node ? '已就绪' : '待选择'}
                    </strong>
                    <span className="truncate text-xs text-muted-foreground">
                      <FlagText
                        text={
                          node
                            ? `${node.name} · ${formatProtocol(node.protocol)} (${node.source})`
                            : '请在节点库左侧点选填入该跳'
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
                  <strong className="text-xs font-semibold text-success">整链出口连通正常</strong>
                  <span className="mono text-xs text-muted-foreground">
                    出口 IP {verified.ip} · 耗时 {verified.latencyMs} ms
                  </span>
                </div>
              </div>
            )}
          </div>

          <Separator />

          <div className="flex items-center justify-end gap-2">
            <Button variant="secondary" onClick={onOpenChain}>
              编辑链路
            </Button>
            <Button variant="default" onClick={onOpenChain}>
              <Activity data-icon="inline-start" />
              重测整链
              <ChevronRight data-icon="inline-end" />
            </Button>
          </div>
        </Card>
      </div>
    </section>
  )
}
