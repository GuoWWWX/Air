import { useEffect, useState } from 'react'
import { Activity, ArrowDown, ArrowUp, CheckSquare, ChevronRight, CloudDownload, Globe2, Grid2X2, List, ListFilter, Loader2, Network, Plus, RefreshCw, Search, ShieldCheck, Waypoints, X, Zap } from 'lucide-react'
import { AirSelect } from '@/shared/ui/AirSelect'
import { Segmented } from '@/shared/ui/segmented'
import { proxyModes } from '@/shared/proxy/modes'
import { NodeLatencyButton } from '@/shared/ui/NodeLatencyButton'
import { ConnectionApp } from '@/shared/ui/ConnectionApp'
import { ProxyPowerButton } from '@/shared/ui/ProxyPowerButton'
import { DashboardPowerButton } from '@/shared/ui/DashboardPowerButton'
import { idleHeights, TrafficBars, trafficHeights } from '@/shared/ui/TrafficBars'
import { Button } from '@/shared/ui/button'
import { bytes, formatDuration, membersOf, protocol, selectionName, stats, usage, type Choice, type Connection, type ExitInfo, type Group, type Library, type Mode, type Node, type Subscription, type VpnStatus, type readLibrary } from './model'
import { Empty, Tag } from './ui'

export const policyLabels = { select: '手动选择', 'url-test': '自动择优', fallback: '故障转移', 'load-balance': '负载均衡' }
export type Model = ReturnType<typeof readLibrary>
export type ChainMeasurement = { name: string; hops: string[]; delay: number }

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

export function Home({ status, pending, library, model, choice, exit, rows, busy, detect, mode, select, connections, importSub, toggle }: {
  status: VpnStatus; library: Library; model: Model; choice?: Choice; exit?: ExitInfo; busy: boolean
  pending?: 'start' | 'stop'; rows: Connection[]
  detect: () => void; mode: (mode: Mode) => void; select: () => void; connections: () => void
  importSub: () => void; toggle: () => void
}) {
  const running = status.phase === 'running'
  const chosen = selectionName(choice, model, library)
  const chain = library.chains.find(chain => choice?.type === 'chain' && chain.id === choice.id)
  const node = model.nodes.find(node => choice?.type === 'node' && node.id === choice.id)
  const group = model.groups.find(group => choice?.type === 'group' && group.id === choice.id)
  const source = library.sources.find(s => s.id === (node?.sourceId ?? group?.sourceId))
  const waveformPending = pending ?? (status.phase === 'starting' ? 'start' : status.phase === 'stopping' ? 'stop' : undefined)
  const [samples, setSamples] = useState<{ session: number; up: number[]; down: number[] }>({ session: 0, up: [], down: [] })
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
  return <div className="page-scroll home">
    <section className="panel dashboard-node">
      <div className="dashboard-node-body">
        <h2 className="flex items-center gap-2"><Globe2 size={16} className="text-primary" />当前节点</h2>
        {(source || node || group || chain) && <div className="flex flex-wrap gap-1.5">
          {source && <Tag tone="gray">{source.name}</Tag>}
          {node && <Tag tone="gray">{protocol(node)}</Tag>}
          {group && <Tag tone="gray">{policyLabels[group.type]}</Tag>}
          {chain && <Tag tone="gray">{chain.hops.length} 跳链路</Tag>}
        </div>}
        <button className="flex min-w-0 items-center gap-1 text-left font-semibold" type="button" onClick={chosen ? select : importSub}>
          <span className="truncate">{chosen ?? '导入订阅'}</span><ChevronRight size={15} className="shrink-0" />
        </button>
        <small className="fine-print">{running ? '虚拟网卡 · 已接管' : '启动后使用'}</small>
      </div>
      <DashboardPowerButton status={{ running, tun: running, systemProxy: false }} pending={waveformPending}
        telemetry={running ? { uploadRate: status.traffic.up ?? 0, downloadRate: status.traffic.down ?? 0 } : undefined}
        disabled={busy} onToggle={toggle} />
    </section>
    <section className="panel exit-card">
      <div className="flex items-center gap-2.5">
        <span className={running ? 'status-icon connected' : 'status-icon'}><ShieldCheck size={18} /></span>
        <strong>{running ? '代理运行中' : status.phase === 'starting' ? '正在建立 VPN' : status.phase === 'error' ? '连接失败' : '代理已停止'}</strong>
        <span className="ml-auto"><Tag tone={running ? 'green' : 'gray'}>{running ? '虚拟网卡已接管' : '等候启动'}</Tag></span>
      </div>
      <div className="exit-label">当前出口 IP</div>
      <div className="flex items-center gap-3 min-w-0">
        {flag && <button className="exit-flag" type="button" aria-label={'刷新出口 IP · ' + exit?.country} disabled={busy} onClick={detect}>{flag}</button>}
        <strong className="exit-ip">{exit?.ip ?? '—'}</strong>
        {running && !flag && <Button size="icon-sm" variant="ghost" aria-label="检测出口 IP" disabled={busy} onClick={detect}><RefreshCw /></Button>}
      </div>
      {exit?.ip && <div className="exit-location">{exit.city || exit.region}{exit.org ? ' · ' + exit.org : ''}</div>}
      {status.error && <small className="text-destructive">{status.error}</small>}
      <div className="exit-bottom"><span>运行时长</span><b>{running ? formatDuration(Date.now() - status.startedAt) : '00:00:00'}</b></div>
    </section>
    <div className="grid grid-cols-2 gap-2">{([
      { label: '上传', icon: ArrowUp, direction: 'up' }, { label: '下载', icon: ArrowDown, direction: 'down' },
    ] as const).map(({ label, icon: Icon, direction }) => {
      const history = samples.session === status.startedAt ? samples[direction] : []
      const total = status.totals?.[direction]
      return <div className="panel rate" key={direction}>
        <span><Icon size={16} />{label}</span>
        <strong>{running ? bytes(status.traffic[direction] ?? 0) + '/s' : '—'}</strong>
        <small className="fine-print">峰值 {history.length ? bytes(Math.max(...history)) + '/s' : '—'} · 累计 {total === undefined ? '—' : bytes(total)}</small>
        <TrafficBars running={running} heights={history.length ? trafficHeights(history) : idleHeights} />
      </div>
    })}</div>
    <section className="panel mode-card">
      <strong>出站模式</strong>
      <Segmented layoutId="android-proxy-mode" ariaLabel="出站模式" size="md" fullWidth
        options={proxyModes} value={library.mode} onChange={mode} disabled={busy} />
    </section>
    <section className="panel diagnostic">
      <div className="section-title"><strong>实时连接 <Tag>{rows.filter(row => !row.closed).length}</Tag></strong>
        <Button size="sm" variant="outline" onClick={connections}>查看连接<ChevronRight data-icon="inline-end" /></Button>
      </div>
      {rows.filter(row => !row.closed).slice(0, 4).map(row =>
        <button type="button" key={row.id} className="dashboard-connection" onClick={connections}>
          <span className="grid min-w-0 gap-1">
            <ConnectionApp name={row.appName || row.metadata.process || '未知应用'} icon={row.appIcon} />
            <small className="truncate fine-print">{row.metadata.host || row.metadata.destinationIP || '未知目标'}</small>
          </span>
          <small className="shrink-0 fine-print">{bytes(row.upload + row.download)}</small>
        </button>)}
      {rows.every(row => row.closed) && <p className="fine-print">暂无实时连接</p>}
    </section>
    {model.groups.length > 0 && <section className="panel diagnostic">
      <div className="section-title"><strong>分组 <Tag>{model.groups.length}</Tag></strong>
        <Button size="sm" variant="outline" onClick={select}>查看分组<ChevronRight data-icon="inline-end" /></Button>
      </div>
      {model.groups.slice(0, 3).map(group => <div className="dashboard-connection" key={group.id}>
        <span className="truncate">{group.name}</span><Tag tone="gray">{policyLabels[group.type]}</Tag>
      </div>)}
    </section>}
  </div>
}

export interface PendingImport {
  id: string
  label: string
  detail: string
}

export function Subscriptions({ model, library, sources, pendingImports, busy, refreshing, toggle, refresh, all, edit, detail, importSub }: {
  model: Model; library: Library; sources: Subscription[]; pendingImports: PendingImport[]; busy: boolean; toggle: (id: string) => void; refresh: (source: Subscription) => void
  refreshing: string[]; all: () => void; edit: (source: Subscription) => void; detail: () => void; importSub: () => void
}) {
  if (!sources.length && !pendingImports.length) return <main className="page-scroll"><Empty icon={CloudDownload} title="暂无订阅"
    description="用 URL 链接、本地 YAML 或二维码导入" className="min-h-56">
    <Button variant="default" className="justify-center" onClick={importSub}><CloudDownload data-icon="inline-start" />导入订阅</Button>
  </Empty></main>
  const count = sources.filter(s => library.sourceFilter.includes(s.id)).length
  return <>
    <main className="page-scroll">
      <div className="section-title"><strong>订阅来源 <small>{sources.length} 个</small></strong><Button size="sm" variant="outline" disabled={busy || !sources.some(s => s.url)} onClick={all}><RefreshCw data-icon="inline-start" className={refreshing.length ? 'motion-safe:animate-spin' : undefined} />刷新全部</Button></div>
      {sources.length > 0 && <div className="selection-summary">
        <label><input type="checkbox" checked={count === sources.length} onChange={() => toggle('*')} />全选</label>
        <span>已选 {count} 个来源</span>
      </div>}
      <div className="item-stack">
        {pendingImports.map(task => (
          <article key={task.id} role="status" aria-live="polite" className="panel subscription-card" data-selected="true">
            <div className="flex items-center justify-between gap-2 min-w-0">
              <div className="flex items-center gap-2 min-w-0">
                <Loader2 size={16} className="shrink-0 animate-spin text-primary" aria-hidden="true" />
                <b className="truncate">{task.label}</b>
              </div>
              <Tag tone="blue">导入中</Tag>
            </div>
            <div className="sub-meta">
              <small className="mono truncate">{task.detail}</small>
              <small className="shrink-0">后台加载中…</small>
            </div>
            <div className="air-import-bar" aria-hidden="true" />
          </article>
        ))}
        {sources.map(source => {
          const meta = usage(source)
          const expired = Boolean(meta.expire && meta.expire < Date.now())
          const checked = library.sourceFilter.includes(source.id)
          return <article className="panel subscription-card" data-selected={checked} key={source.id} onContextMenu={event => { event.preventDefault(); edit(source) }}>
            <div className="flex items-start gap-3">
              <label className="source-check">
                <input type="checkbox" checked={checked} onChange={() => toggle(source.id)} />
                <span><b>{source.name}</b><small>{model.nodes.filter(n => n.sourceId === source.id).length} 个节点 · {model.groups.filter(g => g.sourceId === source.id).length} 个分组</small></span>
              </label>
              <Button size="icon" variant="outline" aria-label={'管理 ' + source.name} onClick={() => edit(source)}><ListFilter /></Button>
            </div>
            <div className="sub-meta"><Tag tone={source.refreshError || expired ? 'red' : 'green'}>{source.refreshError ? '刷新失败' : expired ? '已过期' : '正常'}</Tag><small>{source.url ? 'URL 订阅' : '本地订阅'}</small>{source.refreshError && <small className="text-destructive">{source.refreshError}</small>}</div>
            {meta.total > 0 && <progress max={meta.total} value={Math.min(meta.total, meta.used)} aria-label="订阅流量用量" />}
            <div className="sub-meta">
              <small>{meta.total > 0 ? bytes(meta.used) + ' / ' + bytes(meta.total) : '用量未提供'}{meta.expire ? ' · ' + new Date(meta.expire).toLocaleDateString() + ' 到期' : ''}</small>
              {source.url && <Button size="icon-sm" variant="outline" disabled={busy} aria-label={'刷新 ' + source.name} onClick={() => refresh(source)}><RefreshCw className={refreshing.includes(source.id) ? 'motion-safe:animate-spin' : undefined} /></Button>}
            </div>
          </article>
        })}
      </div>
    </main>
    <footer className="page-action"><Button variant="default" className="w-full" disabled={!count} onClick={detail}><Network />管理所选 {count} 个订阅</Button></footer>
  </>
}

export function Nodes({ nodes, model, library, selected, busy, probing, checked, setChecked, choose, openNode, openGroup, openChain, view, probe, join, filters }: {
  nodes: Node[]; model: Model; library: Library; selected?: Choice; busy: boolean; checked: string[]; setChecked: (ids: string[]) => void
  probing: string[]
  choose: (choice: Choice) => void; openNode: (node?: Node) => void; openGroup: (group?: Group) => void; openChain: () => void
  view: (view: Library['view']) => void; probe: (ids: string[]) => void; join: () => void
  filters: { search: string; setSearch: (value: string) => void; source: string; setSource: (value: string) => void }
}) {
  const [showFilter, setShowFilter] = useState(false)
  const [selecting, setSelecting] = useState(false)
  const query = filters.search.trim().toLocaleLowerCase()
  const current = nodes.filter(n => (!filters.source || n.sourceId === filters.source) &&
    (!query || [n.config.name, n.config.server, protocol(n)].some(value => value.toLocaleLowerCase().includes(query))))
  return <main className="page-scroll">
    <section className="panel groups">
      <div className="section-title"><strong>分组</strong><Button variant="subtle" size="sm" onClick={() => openGroup()}><Plus />新增</Button></div>
      {model.groups.length ? <div className="group-list">
        {model.groups.map(group => <button key={group.id} type="button" className="group-chip" data-selected={selected?.id === group.id} onClick={() => openGroup(group)}>
          <Network size={15} /><b>{group.name}</b><small>{membersOf(group, model, library).length} 个</small><ChevronRight size={13} />
        </button>)}
      </div> : <small className="text-muted-foreground">暂无分组</small>}
    </section>
    <div className="section-title">
      <strong>全部节点 <small>{current.length}</small></strong>
      <span className="flex items-center gap-1.5">
        <Button size="icon" variant={showFilter ? 'subtle' : 'outline'} aria-label="搜索与筛选" onClick={() => setShowFilter(!showFilter)}><Search /></Button>
        <Segmented ariaLabel="节点视图" layoutId="android-node-view" value={library.view} onChange={view} disabled={busy}
          options={[{ value: 'cards', label: '卡片', icon: <Grid2X2 /> }, { value: 'list', label: '列表', icon: <List /> }]} />
      </span>
    </div>
    {showFilter && <div className="filter-bar">
      <input aria-label="搜索节点" placeholder="搜索名称、地址或协议" value={filters.search} onChange={e => filters.setSearch(e.target.value)} />
      <AirSelect
        label="筛选订阅"
        value={filters.source || '__all__'}
        onChange={value => filters.setSource(value === '__all__' ? '' : value)}
        options={[
          { value: '__all__', label: '全部来源' },
          { value: 'custom', label: '自定义节点' },
          ...library.sources.map(s => ({ value: s.id, label: s.name })),
        ]}
      />
    </div>}
    <div className="node-actions">
      <Button size="sm" variant={selecting ? 'subtle' : 'outline'} onClick={() => { setSelecting(!selecting); setChecked([]) }}>
        {selecting ? <X data-icon="inline-start" /> : <CheckSquare data-icon="inline-start" />}
        {selecting ? '退出选择' : '多选'}
      </Button>
      {selecting && <small>已选 {checked.length} 个</small>}
      <span className="ml-auto flex gap-1.5">
        <Button size="sm" variant="outline" disabled={busy || !current.length} onClick={() => probe(checked.length ? checked : current.map(n => n.id))}>
          {probing.length ? <RefreshCw data-icon="inline-start" className="motion-safe:animate-spin" /> : <Zap data-icon="inline-start" />}
          {probing.length ? '正在测速' : '批量测速'}
        </Button>
        {selecting && <Button size="sm" variant="subtle" disabled={!checked.length} onClick={join}>加入分组</Button>}
        {!selecting && <Button size="sm" variant="outline" onClick={openChain}><Waypoints />链路</Button>}
      </span>
    </div>
    {current.length === 0 && <Empty icon={Network} title={nodes.length ? '没有匹配的节点' : '暂无节点'}><Button variant="subtle" onClick={() => openNode()}><Plus />添加自定义节点</Button></Empty>}
    <div className="item-stack" data-view={library.view}>
      {current.map(node => {
        const result = stats(library.probes[node.id])
        const chosen = node.id === selected?.id
        const chosenForGroup = checked.includes(node.id)
        const toggleSelect = () => setChecked(chosenForGroup ? checked.filter(id => id !== node.id) : [...checked, node.id])
        return <article
          key={node.id}
          className="panel node-card"
          data-selected={selecting ? chosenForGroup : chosen}
          data-selecting={selecting || undefined}
          onContextMenu={event => { event.preventDefault(); openNode(node) }}
          onClick={() => {
            if (busy) return
            if (selecting) toggleSelect()
            else choose({ type: 'node', id: node.id })
          }}
        >
          <div className="node-heading">
            {selecting && (
              <input
                type="checkbox"
                aria-label={'选择 ' + node.config.name}
                checked={chosenForGroup}
                onClick={event => event.stopPropagation()}
                onChange={toggleSelect}
              />
            )}
            <button
              type="button"
              className="node-name"
              aria-label={(selecting ? '勾选或取消 ' : '设为当前节点 ') + node.config.name}
              disabled={busy}
            >
              <strong>{node.config.name}</strong>
              <small>{node.sourceId === 'custom' ? '自定义节点' : library.sources.find(s => s.id === node.sourceId)?.name}{' · '}{protocol(node)}</small>
            </button>
            {chosen && <Tag>已选</Tag>}
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={'节点操作 ' + node.config.name}
              onClick={event => {
                event.stopPropagation()
                openNode(node)
              }}
            >···</Button>
          </div>
          <div className="node-metrics">
            <span><small>24h 可用率</small><b>{result.percent === undefined ? '—' : result.percent + '%'}</b></span>
            <span><small>24h 平均</small><b>{result.average === undefined ? '—' : result.average + ' ms'}</b></span>
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
}

export function Connections({ running, rows, exit, labels, busy, measurement, diagnose, close }: {
  running: boolean; rows: Connection[]; exit?: ExitInfo; labels: Record<string, string>; busy: boolean; measurement?: ChainMeasurement
  diagnose: () => void; close: (id: string) => void
}) {
  const [selected, setSelected] = useState<string>()
  const [filter, setFilter] = useState<'all' | 'ok' | 'warn'>('all')
  const [query, setQuery] = useState('')
  const destination = (c: Connection) => {
    const host = c.metadata.host || c.metadata.destinationIP || '未知目标'
    if (!c.metadata.destinationPort) return host
    return (host.includes(':') ? '[' + host + ']' : host) + ':' + c.metadata.destinationPort
  }
  const path = (c: Connection) => [...(c.chains ?? [])].reverse().map(name => labels[name] ?? name).join(' → ')
  const search = query.trim().toLowerCase()
  const visible = filter === 'warn' ? [] : rows.filter(row => !search ||
    [row.appName, row.metadata.process, destination(row), row.rule, path(row)].some(value => value?.toLowerCase().includes(search)))
  const connection = visible.find(c => c.id === selected) ?? visible[0]
  const showProbe = measurement && (filter === 'all' || (filter === 'ok') === (measurement.delay > 0)) &&
    (!search || [measurement.name, ...measurement.hops].some(value => value.toLowerCase().includes(search)))
  return <main className="page-scroll">
    <div className="section-title">
      <Segmented ariaLabel="连接状态筛选" layoutId="android-connection-filter" value={filter} onChange={setFilter}
        options={[{ value: 'all', label: '全部' }, { value: 'ok', label: '已连通' }, { value: 'warn', label: '异常' }]} />
      <Tag tone={running ? 'green' : 'gray'}>{running ? '实时刷新' : '代理已停止'}</Tag>
    </div>
    <input aria-label="搜索连接" placeholder="搜索应用、目标或链路" value={query} onChange={event => setQuery(event.target.value)} />
    {!visible.length && !showProbe && <Empty icon={Activity}
      title={query || filter === 'warn' ? '没有匹配的连接记录' : running ? '等待应用发起连接' : '暂无整链探测与连接记录'} />}
    {showProbe && <section className="panel diagnostic">
      <div className="section-title"><strong>整链探测</strong><Tag tone={measurement.delay > 0 ? 'green' : 'red'}>{measurement.delay > 0 ? measurement.delay + ' ms' : '探测失败'}</Tag></div>
      <strong>{measurement.name}</strong><small className="fine-print">{measurement.hops.join(' → ')}</small>
    </section>}
    <div className="item-stack">
      {visible.map(c => {
        const routeSummary = path(c) || [c.rule, c.rulePayload].filter(Boolean).join(' · ') || '默认路由'
        return <button type="button" key={c.id} className="panel connection-row" data-selected={c.id === connection?.id} onClick={() => setSelected(c.id)}>
          <div className="connection-row-head">
            <div className="connection-row-app">
              <ConnectionApp name={c.appName || c.metadata.process || '未知应用'} executable={c.appName ? c.metadata.process : undefined} icon={c.appIcon} />
            </div>
            <div className="connection-row-status">
              <Tag tone={c.closed ? 'gray' : 'green'}>
                {!c.closed && <span className="connection-row-dot" aria-hidden="true" />}
                {c.closed ? '已结束' : '进行中'}
              </Tag>
            </div>
          </div>
          <div className="connection-row-target">{destination(c)}</div>
          <div className="connection-row-foot">
            <span className="connection-row-meta" title={routeSummary}>{routeSummary}</span>
            <span className="connection-row-traffic">
              <span className="connection-row-dl"><ArrowDown size={11} aria-hidden="true" />{bytes(c.download)}</span>
              <span className="connection-row-ul"><ArrowUp size={11} aria-hidden="true" />{bytes(c.upload)}</span>
            </span>
          </div>
        </button>
      })}
    </div>
    <section className="panel diagnostic">
      <strong>连接诊断</strong>
      {connection && <div className="diag-details">
        <span><small>目标</small><b>{destination(connection)}</b></span>
        <span><small>命中规则</small><b>{[connection.rule, connection.rulePayload].filter(Boolean).join(' · ') || '—'}</b></span>
        <span><small>出站链路</small><b>{path(connection) || '—'}</b></span>
      </div>}
      <span className="text-muted-foreground text-xs">{exit ? '已验证出口 · ' + exit.ip : '启动代理后可核对出口 IP'}</span>
      <div className="flex flex-wrap justify-end gap-2">
        {connection && running && !connection.closed && <Button size="sm" variant="outline" onClick={() => close(connection.id)}>断开此连接</Button>}
        <Button size="sm" disabled={!running || busy} onClick={diagnose}><Activity />验证出口</Button>
      </div>
    </section>
  </main>
}
