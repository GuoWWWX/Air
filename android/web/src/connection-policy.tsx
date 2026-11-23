import { tr } from '@/shared/i18n/messages'
import { useMemo, useState } from 'react'
import { ChevronDown, Copy, Plus, Shield, Trash2 } from 'lucide-react'
import { AirSelect } from '@/shared/ui/AirSelect'
import { Button } from '@/shared/ui/button'
import { ConnectionApp } from '@/shared/ui/ConnectionApp'
import { Input } from '@/shared/ui/input'
import { showMessage } from '@/shared/ui/message'
import {
  extractHostInfo,
  findAppPolicyRules,
  findStandaloneHostRule,
  mergeAppPolicyRules,
  mergeStandaloneHostRule,
  normalizeHostRuleValue,
  validatePolicyHostValue,
  type PolicyHostMatcher,
} from '@/shared/proxy/connection-policy'
import type { HostMatcher, MobileRouting, RouteRule, RouteTarget } from './configuration'
import { bytes, type Connection, type Library } from './model'
import { Tag } from './ui'
import { connectionRoute, formatSpeed, type Model } from './views'

type QuickPreset = 'default' | 'direct' | 'selected' | 'custom' | 'reject'

interface FineDraftRow {
  id: string
  hostMatcher: HostMatcher
  hostValue: string
  target: RouteTarget
}

function targetKey(target: RouteTarget): string {
  return 'id' in target ? `${target.kind}:${target.id}` : target.kind
}

function targetPreset(target: RouteTarget | null): QuickPreset {
  if (!target) return 'default'
  if (target.kind === 'direct') return 'direct'
  if (target.kind === 'selected') return 'selected'
  if (target.kind === 'reject') return 'reject'
  return 'custom'
}

export function ConnectionPolicySheet({
  conn,
  history,
  library,
  model,
  labels,
  running,
  busy,
  sdk,
  onSwitchToRuleMode,
  onSaveRouting,
  onCopyDest,
  onCloseConnection,
}: {
  conn: Connection
  history: Connection[]
  library: Library
  model: Model
  labels: Record<string, string>
  running: boolean
  busy: boolean
  sdk: number
  onSwitchToRuleMode: () => void
  onSaveRouting: (nextRouting: MobileRouting, processName?: string, host?: string) => void
  onCopyDest: (dest: string) => void
  onCloseConnection: (id: string) => void
}) {
  const processName = conn.metadata.process?.trim() ?? ''
  const canProcessRule = Boolean(processName) && sdk >= 29
  const route = connectionRoute(conn, labels)
  const host = conn.metadata.host || conn.metadata.destinationIP || tr('未知目标')
  const dest = conn.metadata.destinationPort
    ? (host.includes(':') ? `[${host}]` : host) + ':' + conn.metadata.destinationPort
    : host
  const fullPath = [...(conn.chains ?? [])].reverse().map(name => labels[name] ?? name).join(' → ')
  const matchedRule = [conn.rule, conn.rulePayload].filter(Boolean).join(' · ')

  const extracted = useMemo(
    () => extractHostInfo(conn.metadata.host || conn.metadata.destinationIP, conn.metadata.destinationIP),
    [conn.metadata.host, conn.metadata.destinationIP],
  )

  const customOutbounds = useMemo(() => {
    const sourceNames = new Map(library.sources.map(source => [source.id, source.name]))
    const list: { value: string; label: string; target: RouteTarget }[] = []
    for (const chain of library.chains) {
      list.push({
        value: `chain:${chain.id}`,
        label: tr('链式出口 · ') + chain.name,
        target: { kind: 'chain', id: chain.id },
      })
    }
    for (const group of model.groups) {
      list.push({
        value: `group:${group.id}`,
        label: `${tr('分组')} · ${group.name}`,
        target: { kind: 'group', id: group.id },
      })
    }
    for (const node of model.nodes) {
      const src = node.sourceId === 'custom' ? tr('自定义节点') : (sourceNames.get(node.sourceId) ?? '')
      list.push({
        value: `node:${node.id}`,
        label: src ? `${node.config.name} (${src})` : node.config.name,
        target: { kind: 'node', id: node.id },
      })
    }
    return list
  }, [library.chains, library.sources, model.groups, model.nodes])

  const defaultCustomTarget = customOutbounds[0]?.target ?? { kind: 'selected' as const }

  const initialState = useMemo(() => {
    if (canProcessRule) {
      const found = findAppPolicyRules(library.routing.rules, 'processName', processName, {
        caseSensitiveProcess: true,
      })
      const fine = found.fineRules.map((rule, index) => ({
        id: `${index}:${rule.hostMatcher}:${rule.hostValue}`,
        hostMatcher: rule.hostMatcher ?? 'domainSuffix',
        hostValue: rule.hostValue ?? '',
        target: rule.target,
      }))
      return {
        coarseTarget: found.coarseRule?.target ?? null,
        fineRules: fine,
      }
    }
    return {
      coarseTarget: null,
      fineRules: [] as FineDraftRow[],
    }
  }, [canProcessRule, library.routing.rules, processName])

  const [coarseTarget, setCoarseTarget] = useState<RouteTarget | null>(initialState.coarseTarget)
  const [fineRules, setFineRules] = useState<FineDraftRow[]>(initialState.fineRules)
  const [hostScope, setHostScope] = useState<'suffix' | 'exact'>(() => {
    if (extracted.kind !== 'domain') return 'exact'
    if (canProcessRule) {
      const exactMatch = initialState.fineRules.some(
        r => r.hostMatcher === 'domain' && normalizeHostRuleValue('domain', r.hostValue) === extracted.value,
      )
      return exactMatch ? 'exact' : 'suffix'
    }
    const standaloneExact = findStandaloneHostRule(library.routing.rules, 'domain', extracted.value)
    return standaloneExact ? 'exact' : 'suffix'
  })

  function hostForScope(scope: 'suffix' | 'exact'): { matcher: HostMatcher | null; value: string } {
    if (extracted.kind === 'none') return { matcher: null, value: '' }
    if (extracted.kind === 'ip') return { matcher: 'ip', value: extracted.value }
    const useSuffix = scope === 'suffix' && Boolean(extracted.suggestedSuffix)
    return {
      matcher: useSuffix ? 'domainSuffix' : 'domain',
      value: useSuffix ? extracted.suggestedSuffix! : extracted.value,
    }
  }

  const { matcher: activeHostMatcher, value: activeHostValue } = hostForScope(hostScope)

  const standaloneInitialTarget = useMemo(() => {
    if (canProcessRule || !activeHostMatcher || !activeHostValue) return null
    return findStandaloneHostRule(library.routing.rules, activeHostMatcher, activeHostValue)?.target ?? null
  }, [canProcessRule, library.routing.rules, activeHostMatcher, activeHostValue])

  const [standaloneTarget, setStandaloneTarget] = useState<RouteTarget | null>(standaloneInitialTarget)
  const [manualMatcher, setManualMatcher] = useState<HostMatcher>('domainSuffix')
  const [manualHost, setManualHost] = useState('')
  const [manualTarget, setManualTarget] = useState<RouteTarget>({ kind: 'direct' })
  const [detailsOpen, setDetailsOpen] = useState(false)

  function changeHostScope(nextScope: 'suffix' | 'exact') {
    setHostScope(nextScope)
    if (!canProcessRule && extracted.kind === 'domain') {
      const nextHost = hostForScope(nextScope)
      if (nextHost.matcher && nextHost.value) {
        setStandaloneTarget(findStandaloneHostRule(library.routing.rules, nextHost.matcher, nextHost.value)?.target ?? null)
      }
    }
  }

  function upsertFineRule(
    previous: FineDraftRow[],
    hostMatcher: HostMatcher,
    hostValue: string,
    target: RouteTarget,
  ): FineDraftRow[] {
    const normalized = normalizeHostRuleValue(hostMatcher, hostValue)
    const rest = previous.filter(
      row =>
        !(
          row.hostMatcher === hostMatcher &&
          normalizeHostRuleValue(row.hostMatcher, row.hostValue) === normalized
        ),
    )
    return [
      {
        id: `${Date.now()}:${hostMatcher}:${normalized}`,
        hostMatcher,
        hostValue,
        target,
      },
      ...rest,
    ]
  }

  const currentFineRule = activeHostMatcher && activeHostValue
    ? fineRules.find(
        row =>
          row.hostMatcher === activeHostMatcher &&
          normalizeHostRuleValue(row.hostMatcher, row.hostValue) ===
            normalizeHostRuleValue(activeHostMatcher, activeHostValue),
      )
    : undefined

  const currentHostTarget = canProcessRule ? (currentFineRule?.target ?? null) : standaloneTarget

  function setCurrentHostTarget(next: RouteTarget | null) {
    if (!activeHostMatcher || !activeHostValue) return
    if (!canProcessRule) {
      setStandaloneTarget(next)
      return
    }
    const normalized = normalizeHostRuleValue(activeHostMatcher, activeHostValue)
    setFineRules(previous => {
      if (!next) {
        return previous.filter(
          row =>
            !(
              row.hostMatcher === activeHostMatcher &&
              normalizeHostRuleValue(row.hostMatcher, row.hostValue) === normalized
            ),
        )
      }
      return upsertFineRule(previous, activeHostMatcher, activeHostValue, next)
    })
  }

  const recentAppHosts = useMemo(() => {
    if (!canProcessRule) return []
    const seen = new Set<string>()
    if (extracted.kind !== 'none') {
      seen.add(extracted.value.toLowerCase())
      if (extracted.suggestedSuffix) seen.add(extracted.suggestedSuffix.toLowerCase())
    }
    for (const row of fineRules) {
      seen.add(normalizeHostRuleValue(row.hostMatcher, row.hostValue))
    }
    const items: { matcher: HostMatcher; value: string; raw: string }[] = []
    for (const row of history) {
      if (row.metadata.process?.trim() !== processName) continue
      const info = extractHostInfo(row.metadata.host || row.metadata.destinationIP, row.metadata.destinationIP)
      if (info.kind === 'none') continue
      const candidate = info.kind === 'domain' && info.suggestedSuffix ? info.suggestedSuffix : info.value
      const matcher: HostMatcher = info.kind === 'ip' ? 'ip' : info.suggestedSuffix ? 'domainSuffix' : 'domain'
      const key = normalizeHostRuleValue(matcher, candidate)
      if (seen.has(key)) continue
      seen.add(key)
      items.push({ matcher, value: candidate, raw: info.value })
      if (items.length >= 10) break
    }
    return items
  }, [canProcessRule, extracted, fineRules, history, processName])

  const allTargetOptions = useMemo(
    () => [
      { value: 'direct', label: tr('直连') },
      { value: 'selected', label: tr('当前所选代理') },
      { value: 'reject', label: tr('拒绝连接') },
      ...customOutbounds.map(item => ({ value: item.value, label: item.label })),
    ],
    [customOutbounds],
  )

  function resolveTargetFromValue(value: string): RouteTarget {
    if (value === 'direct') return { kind: 'direct' }
    if (value === 'selected') return { kind: 'selected' }
    if (value === 'reject') return { kind: 'reject' }
    return customOutbounds.find(item => item.value === value)?.target ?? { kind: 'selected' }
  }

  function renderPresetButtons(
    value: RouteTarget | null,
    onChange: (next: RouteTarget | null) => void,
    defaultLabel: string,
  ) {
    const preset = targetPreset(value)
    const buttons: { id: QuickPreset; label: string; apply: () => void }[] = [
      { id: 'default', label: defaultLabel, apply: () => onChange(null) },
      { id: 'direct', label: tr('直连'), apply: () => onChange({ kind: 'direct' }) },
      { id: 'selected', label: tr('当前代理'), apply: () => onChange({ kind: 'selected' }) },
      {
        id: 'custom',
        label: tr('指定节点'),
        apply: () => onChange(preset === 'custom' && value ? value : defaultCustomTarget),
      },
      { id: 'reject', label: tr('拒绝'), apply: () => onChange({ kind: 'reject' }) },
    ]
    return (
      <div className="flex flex-col gap-2">
        <div className="policy-preset-grid">
          {buttons.map(btn => (
            <button
              key={btn.id}
              type="button"
              disabled={busy || (btn.id === 'custom' && !customOutbounds.length)}
              data-tone={btn.id}
              data-active={preset === btn.id || undefined}
              className="policy-preset-btn"
              onClick={btn.apply}
            >
              <span className="truncate">{btn.label}</span>
            </button>
          ))}
        </div>
        {preset === 'custom' && value && customOutbounds.length > 0 && (
          <AirSelect
            label={tr('选择指定出站')}
            value={targetKey(value)}
            disabled={busy}
            options={customOutbounds.map(item => ({ value: item.value, label: item.label }))}
            onChange={key => {
              const picked = customOutbounds.find(item => item.value === key)
              if (picked) onChange(picked.target)
            }}
          />
        )}
      </div>
    )
  }

  function addManualFineRule() {
    const trimmed = manualHost.trim()
    if (!trimmed) {
      showMessage({ type: 'warning', title: tr('请先填写域名或 IP') })
      return
    }
    const validationError = validatePolicyHostValue(manualMatcher, trimmed)
    if (validationError) {
      showMessage({ type: 'error', title: tr(validationError) })
      return
    }
    setFineRules(previous => upsertFineRule(previous, manualMatcher, trimmed, manualTarget))
    setManualHost('')
  }

  function handleSave() {
    let effectiveFineRules = fineRules
    const pendingManual = manualHost.trim()
    if (canProcessRule && pendingManual) {
      const validationError = validatePolicyHostValue(manualMatcher, pendingManual)
      if (validationError) {
        showMessage({ type: 'error', title: tr(validationError) })
        return
      }
      effectiveFineRules = upsertFineRule(fineRules, manualMatcher, pendingManual, manualTarget)
      setFineRules(effectiveFineRules)
      setManualHost('')
    }

    let nextRules: RouteRule[]
    if (canProcessRule) {
      nextRules = mergeAppPolicyRules<RouteTarget, RouteRule>(library.routing.rules, {
        processMatcher: 'processName',
        processValue: processName,
        coarseTarget,
        fineRules: effectiveFineRules.map(item => ({
          hostMatcher: item.hostMatcher as PolicyHostMatcher,
          hostValue: item.hostValue,
          target: item.target,
        })),
        caseSensitiveProcess: true,
      })
    } else if (activeHostMatcher && activeHostValue) {
      nextRules = mergeStandaloneHostRule<RouteTarget, RouteRule>(library.routing.rules, {
        hostMatcher: activeHostMatcher,
        hostValue: activeHostValue,
        target: standaloneTarget,
      })
    } else {
      nextRules = [...library.routing.rules]
    }
    onSaveRouting(
      { ...library.routing, rules: nextRules },
      canProcessRule ? processName : undefined,
      activeHostValue || undefined,
    )
  }

  const otherFineRules = fineRules.filter(
    row =>
      !(
        activeHostMatcher &&
        activeHostValue &&
        row.hostMatcher === activeHostMatcher &&
        normalizeHostRuleValue(row.hostMatcher, row.hostValue) ===
          normalizeHostRuleValue(activeHostMatcher, activeHostValue)
      ),
  )

  return (
    <div className="sheet-form">
      <section className="panel policy-summary-card">
        <div className="min-w-0 flex-1">
          <ConnectionApp
            name={conn.appName || conn.metadata.process || tr('未知应用')}
            executable={conn.appName ? conn.metadata.process : undefined}
            icon={conn.appIcon}
          />
          {processName && <small className="mono block truncate text-muted-foreground">{processName}</small>}
        </div>
        <div className="flex max-w-full min-w-0 items-center gap-1.5">
          <Tag tone={route.tone} className="tag-truncate">{route.fullLabel}</Tag>
          <Tag tone={conn.closed ? 'gray' : 'green'} className="shrink-0">
            {conn.closed ? tr('已结束') : tr('进行中')}
          </Tag>
        </div>
      </section>

      {library.mode !== 'rule' && (
        <div className="policy-mode-banner">
          <span>{tr('当前为非规则模式，自定义分流仅在「规则」模式下生效')}</span>
          <Button type="button" size="sm" variant="subtle" disabled={busy} onClick={onSwitchToRuleMode}>
            {tr('切到规则')}
          </Button>
        </div>
      )}

      {canProcessRule ? (
        <section className="panel policy-card">
          <div className="policy-card-head">
            <span className="flex items-center gap-1.5 font-semibold text-sm">
              <Shield size={15} className="text-primary" />
              {tr('按应用分流')}
            </span>
            <Tag tone="blue">{tr('高于订阅')}</Tag>
          </div>
          <small className="fine-print">{tr('未单独指定域名时，该应用默认走：')}</small>
          {renderPresetButtons(coarseTarget, setCoarseTarget, tr('跟随默认'))}
        </section>
      ) : (
        <div className="policy-mode-banner">
          <span>
            {processName
              ? tr('按应用分流需要 Android 10 及以上系统，当前按目标域名/IP 配置全局规则')
              : tr('此连接未报告应用包名，将按目标域名/IP 配置全局规则')}
          </span>
        </div>
      )}

      <section className="panel policy-card">
        <div className="policy-card-head">
          <strong className="text-sm">{tr('按域名分流')}</strong>
          <Tag tone="green">{tr('最高优先级')}</Tag>
        </div>

        {activeHostMatcher && activeHostValue && (
          <div className="policy-host-block">
            <div className="flex items-center justify-between gap-2 min-w-0">
              <span className="mono min-w-0 flex-1 truncate text-xs font-semibold">{activeHostValue}</span>
              {extracted.kind === 'domain' && extracted.suggestedSuffix && extracted.suggestedSuffix !== extracted.value && (
                <div className="inline-flex shrink-0 rounded-[7px] border border-border bg-secondary p-0.5 text-[11px]">
                  <button
                    type="button"
                    disabled={busy}
                    className={hostScope === 'suffix' ? 'policy-chip-tab active' : 'policy-chip-tab'}
                    onClick={() => changeHostScope('suffix')}
                  >
                    {tr('含子域名')}
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    className={hostScope === 'exact' ? 'policy-chip-tab active' : 'policy-chip-tab'}
                    onClick={() => changeHostScope('exact')}
                  >
                    {tr('仅此域名')}
                  </button>
                </div>
              )}
            </div>
            {renderPresetButtons(
              currentHostTarget,
              setCurrentHostTarget,
              canProcessRule ? tr('跟随应用') : tr('跟随默认'),
            )}
          </div>
        )}

        {recentAppHosts.length > 0 && (
          <div className="flex flex-col gap-1.5">
            <small className="fine-print">{tr('近期访问的域名（点击快速添加）：')}</small>
            <div className="flex flex-wrap gap-1.5">
              {recentAppHosts.map(item => (
                <button
                  key={`${item.matcher}:${item.value}`}
                  type="button"
                  disabled={busy}
                  className="policy-recent-chip mono"
                  onClick={() =>
                    setFineRules(previous => upsertFineRule(previous, item.matcher, item.value, { kind: 'direct' }))
                  }
                >
                  <Plus size={12} />
                  <span className="truncate">{item.value}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {otherFineRules.length > 0 && (
          <div className="flex flex-col gap-1.5 pt-1 border-t border-border-subtle">
            <small className="fine-print">{tr('其他已配置的域名规则：')}</small>
            {otherFineRules.map(item => (
              <div key={item.id} className="policy-fine-row">
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="mono truncate text-xs font-medium">{item.hostValue}</span>
                  <small className="text-[11px] text-muted-foreground">
                    {item.hostMatcher === 'domain'
                      ? tr('完整域名')
                      : item.hostMatcher === 'domainSuffix'
                        ? tr('域名及子域名')
                        : tr('IP 或网段')}
                  </small>
                </div>
                <div className="w-[126px] shrink-0">
                  <AirSelect
                    label={item.hostValue}
                    value={targetKey(item.target)}
                    disabled={busy}
                    options={allTargetOptions}
                    onChange={val => {
                      const nextTarget = resolveTargetFromValue(val)
                      setFineRules(previous =>
                        previous.map(r => (r.id === item.id ? { ...r, target: nextTarget } : r)),
                      )
                    }}
                  />
                </div>
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  disabled={busy}
                  aria-label={tr('删除规则')}
                  onClick={() => setFineRules(previous => previous.filter(r => r.id !== item.id))}
                >
                  <Trash2 size={14} />
                </Button>
              </div>
            ))}
          </div>
        )}

        {canProcessRule && (
          <div className="flex flex-col gap-1.5 pt-1 border-t border-border-subtle">
            <small className="fine-print">{tr('手动添加域名规则：')}</small>
            <div className="grid grid-cols-[96px_minmax(0,1fr)] gap-1.5">
              <AirSelect
                label={tr('匹配方式')}
                value={manualMatcher}
                disabled={busy}
                options={[
                  { value: 'domainSuffix', label: tr('含子域名') },
                  { value: 'domain', label: tr('完整域名') },
                  { value: 'ip', label: tr('IP/网段') },
                ]}
                onChange={value => setManualMatcher(value as HostMatcher)}
              />
              <Input
                value={manualHost}
                disabled={busy}
                placeholder={manualMatcher === 'ip' ? '1.2.3.4/32' : 'example.com'}
                spellCheck={false}
                onChange={e => setManualHost(e.target.value)}
                onKeyDown={event => {
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    addManualFineRule()
                  }
                }}
              />
            </div>
            <div className="flex items-center gap-1.5">
              <div className="min-w-0 flex-1">
                <AirSelect
                  label={tr('出站方式')}
                  value={targetKey(manualTarget)}
                  disabled={busy}
                  options={allTargetOptions}
                  onChange={val => setManualTarget(resolveTargetFromValue(val))}
                />
              </div>
              <Button type="button" variant="outline" className="h-9 shrink-0" disabled={busy} onClick={addManualFineRule}>
                <Plus size={14} />{tr('添加')}
              </Button>
            </div>
          </div>
        )}
      </section>

      <button
        type="button"
        className="policy-details-toggle"
        aria-expanded={detailsOpen}
        onClick={() => setDetailsOpen(value => !value)}
      >
        <span>{tr('连接技术详情')}</span>
        <ChevronDown size={15} className={detailsOpen ? 'rotate-180 transition-transform' : 'transition-transform'} />
      </button>

      {detailsOpen && (
        <div className="sheet-detail-list">
          <div className="sheet-detail-row"><small>{tr('目标地址')}</small><b className="mono">{dest}</b></div>
          {conn.metadata.network && <div className="sheet-detail-row"><small>{tr('网络协议')}</small><span className="mono">{conn.metadata.network.toUpperCase()}</span></div>}
          <div className="sheet-detail-row"><small>{tr('命中规则')}</small><span>{matchedRule || tr('默认路由')}</span></div>
          <div className="sheet-detail-row"><small>{tr('出站链路')}</small><span>{fullPath || '—'}</span></div>
          {!conn.closed && (
            <div className="sheet-detail-row">
              <small>{tr('实时网速')}</small>
              <span className="mono">↓ {formatSpeed(conn.downRate)} · ↑ {formatSpeed(conn.upRate)}</span>
            </div>
          )}
          <div className="sheet-detail-row">
            <small>{tr('累计流量')}</small>
            <span className="mono">{tr('下载 {0} · 上传 {1}', bytes(conn.download), bytes(conn.upload))}</span>
          </div>
        </div>
      )}

      <div className="sheet-actions policy-sheet-actions">
        <Button type="button" variant="outline" className="h-9 w-full min-w-0 px-2 text-xs" onClick={() => onCopyDest(dest)}>
          <Copy />
          <span className="truncate">{tr('复制目标')}</span>
        </Button>
        {running && !conn.closed && (
          <Button type="button" variant="outline" className="h-9 w-full min-w-0 px-2 text-xs" disabled={busy} onClick={() => onCloseConnection(conn.id)}>
            <span className="truncate">{tr('断开连接')}</span>
          </Button>
        )}
        <Button
          type="button"
          variant="default"
          className="h-9 w-full min-w-0 px-2 text-xs"
          disabled={busy || (!canProcessRule && (!activeHostMatcher || !activeHostValue))}
          onClick={handleSave}
        >
          <span className="truncate">{tr('保存生效')}</span>
        </Button>
      </div>
    </div>
  )
}
