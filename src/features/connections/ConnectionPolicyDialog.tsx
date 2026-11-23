import { tr } from '@/shared/i18n/messages'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Plus, Shield, Trash2 } from 'lucide-react'
import {
  air,
  type HostMatcher,
  type NodeRecord,
  type ProxyConnection,
  type ProxyMode,
  type RouteRule,
  type RouteTarget,
  type RoutingConfig,
  type SubscriptionGroup,
} from '@/platform/desktop/air'
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
import { cn } from '@/shared/lib/utils'
import { AirSelect } from '@/shared/ui/AirSelect'
import { Badge } from '@/shared/ui/badge'
import { Button } from '@/shared/ui/button'
import { ConnectionApp } from '@/shared/ui/ConnectionApp'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/shared/ui/dialog'
import { FlagText } from '@/shared/ui/FlagText'
import { Input } from '@/shared/ui/input'
import { showMessage } from '@/shared/ui/message'

type QuickPreset = 'default' | 'direct' | 'selected' | 'custom' | 'reject'

interface FineDraftRow {
  id: string
  hostMatcher: HostMatcher
  hostValue: string
  target: RouteTarget
}

function targetKey(target: RouteTarget): string {
  if (target.kind === 'node') return `node:${target.id}`
  if (target.kind === 'group') return `group:${target.sourceId}:${target.name}`
  return target.kind
}

function targetPreset(target: RouteTarget | null): QuickPreset {
  if (!target) return 'default'
  if (target.kind === 'direct') return 'direct'
  if (target.kind === 'selected') return 'selected'
  if (target.kind === 'reject') return 'reject'
  return 'custom'
}

function isExeName(value: string): boolean {
  return value.length > 4 && value.toLowerCase().endsWith('.exe')
}

export function ConnectionPolicyDialog({
  connection,
  recentConnections,
  appIcons,
  proxyMode,
  nodes,
  groups,
  onSwitchToRuleMode,
  onClose,
}: {
  connection: ProxyConnection | null
  recentConnections: ProxyConnection[]
  appIcons?: Record<string, string>
  proxyMode: ProxyMode
  nodes: NodeRecord[]
  groups: SubscriptionGroup[]
  onSwitchToRuleMode: () => Promise<unknown>
  onClose: () => void
}) {
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [routingDoc, setRoutingDoc] = useState<{ routing: RoutingConfig; revision: string } | null>(null)
  const [procMatcher, setProcMatcher] = useState<'processName' | 'processPath'>('processName')
  const [coarseTarget, setCoarseTarget] = useState<RouteTarget | null>(null)
  const [fineRules, setFineRules] = useState<FineDraftRow[]>([])
  const [standaloneTarget, setStandaloneTarget] = useState<RouteTarget | null>(null)
  const [hostScope, setHostScope] = useState<'suffix' | 'exact'>('suffix')
  const [manualMatcher, setManualMatcher] = useState<HostMatcher>('domainSuffix')
  const [manualHost, setManualHost] = useState('')
  const [manualTarget, setManualTarget] = useState<RouteTarget>({ kind: 'direct' })
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  const processName = useMemo(() => {
    if (!connection) return ''
    return (
      [connection.processName, connection.appExecutable, connection.app]
        .map(v => (v ?? '').trim())
        .find(v => isExeName(v) && !/[\\/:]/.test(v)) ?? ''
    )
  }, [connection])

  const processPath = useMemo(() => {
    const raw = (connection?.processPath ?? '').trim().replaceAll('/', '\\')
    return isExeName(raw) && (/^[a-zA-Z]:\\/.test(raw) || raw.startsWith('\\\\')) ? raw : ''
  }, [connection])

  const extracted = useMemo(
    () =>
      connection
        ? extractHostInfo(connection.host || connection.target, connection.destinationIp)
        : { kind: 'none' as const, value: '' },
    [connection],
  )

  const activeHostMatcher: HostMatcher | null =
    extracted.kind === 'none'
      ? null
      : extracted.kind === 'ip'
        ? 'ip'
        : hostScope === 'suffix' && extracted.suggestedSuffix
          ? 'domainSuffix'
          : 'domain'

  const activeHostValue =
    extracted.kind === 'none'
      ? ''
      : activeHostMatcher === 'domainSuffix' && extracted.suggestedSuffix
        ? extracted.suggestedSuffix
        : extracted.value

  useEffect(() => {
    if (!connection) {
      setRoutingDoc(null)
      return
    }
    setManualMatcher('domainSuffix')
    setManualHost('')
    setManualTarget({ kind: 'direct' })
    setLoading(true)
    let active = true
    void air
      .routingSettings()
      .then(doc => {
        if (!active) return
        setRoutingDoc({ routing: doc.routing, revision: doc.revision })
        let initialMatcher: 'processName' | 'processPath' = processName ? 'processName' : 'processPath'
        let procVal = initialMatcher === 'processName' ? processName : processPath
        if (initialMatcher === 'processName' && processPath) {
          const byName = findAppPolicyRules(doc.routing.rules, 'processName', processName)
          if (!byName.coarseRule && !byName.fineRules.length) {
            const byPath = findAppPolicyRules(doc.routing.rules, 'processPath', processPath)
            if (byPath.coarseRule || byPath.fineRules.length) {
              initialMatcher = 'processPath'
              procVal = processPath
            }
          }
        }
        setProcMatcher(initialMatcher)
        if (procVal) {
          const found = findAppPolicyRules(doc.routing.rules, initialMatcher, procVal)
          setCoarseTarget(found.coarseRule?.target ?? null)
          const fine = found.fineRules.map((rule, index) => ({
            id: `${index}:${rule.hostMatcher}:${rule.hostValue}`,
            hostMatcher: rule.hostMatcher ?? 'domainSuffix',
            hostValue: rule.hostValue ?? '',
            target: rule.target,
          }))
          setFineRules(fine)
          if (extracted.kind === 'domain') {
            const hasExact = fine.some(
              r => r.hostMatcher === 'domain' && normalizeHostRuleValue('domain', r.hostValue) === extracted.value,
            )
            setHostScope(hasExact ? 'exact' : 'suffix')
          } else {
            setHostScope('exact')
          }
          setStandaloneTarget(null)
        } else {
          setCoarseTarget(null)
          setFineRules([])
          const hasExactStandalone =
            extracted.kind === 'domain' &&
            Boolean(findStandaloneHostRule(doc.routing.rules, 'domain', extracted.value))
          const scope = hasExactStandalone ? 'exact' : extracted.kind === 'domain' ? 'suffix' : 'exact'
          setHostScope(scope)
          const matcher: HostMatcher | null =
            extracted.kind === 'ip'
              ? 'ip'
              : extracted.kind === 'domain'
                ? scope === 'suffix' && extracted.suggestedSuffix
                  ? 'domainSuffix'
                  : 'domain'
                : null
          const hostVal =
            matcher === 'domainSuffix' && extracted.suggestedSuffix
              ? extracted.suggestedSuffix
              : extracted.value
          setStandaloneTarget(
            matcher && hostVal
              ? findStandaloneHostRule(doc.routing.rules, matcher, hostVal)?.target ?? null
              : null,
          )
        }
      })
      .catch(error => {
        if (active) {
          showMessage({
            type: 'error',
            title: error instanceof Error ? error.message : String(error),
          })
          onCloseRef.current()
        }
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [connection, extracted, processName, processPath])

  function changeHostScope(next: 'suffix' | 'exact') {
    setHostScope(next)
    if (!canProcessRule && routingDoc && extracted.kind === 'domain') {
      const nextMatcher: PolicyHostMatcher =
        next === 'suffix' && extracted.suggestedSuffix ? 'domainSuffix' : 'domain'
      const nextHost =
        nextMatcher === 'domainSuffix' && extracted.suggestedSuffix
          ? extracted.suggestedSuffix
          : extracted.value
      setStandaloneTarget(findStandaloneHostRule(routingDoc.routing.rules, nextMatcher, nextHost)?.target ?? null)
    }
  }

  function switchProcMatcher(next: 'processName' | 'processPath') {
    if (next === procMatcher || !routingDoc) return
    setProcMatcher(next)
    const procVal = next === 'processName' ? processName : processPath
    if (!procVal) return
    const found = findAppPolicyRules(routingDoc.routing.rules, next, procVal)
    setCoarseTarget(found.coarseRule?.target ?? null)
    setFineRules(
      found.fineRules.map((rule, index) => ({
        id: `${index}:${rule.hostMatcher}:${rule.hostValue}`,
        hostMatcher: rule.hostMatcher ?? 'domainSuffix',
        hostValue: rule.hostValue ?? '',
        target: rule.target,
      })),
    )
  }

  const activeProcessValue = procMatcher === 'processName' ? processName : processPath
  const canProcessRule = Boolean(activeProcessValue)

  const customOutbounds = useMemo(() => {
    const list: { value: string; label: string; target: RouteTarget }[] = [
      { value: 'residential', label: tr('链式出口'), target: { kind: 'residential' } },
    ]
    for (const group of groups) {
      const source = nodes.find(node => node.sourceId === group.sourceId)?.source ?? group.sourceId
      list.push({
        value: `group:${group.sourceId}:${group.name}`,
        label: `${tr('订阅分组')} · ${group.name} (${source})`,
        target: { kind: 'group', sourceId: group.sourceId, name: group.name },
      })
    }
    for (const node of nodes) {
      if (node.subscriptionNotice) continue
      list.push({
        value: `node:${node.id}`,
        label: `${node.name} (${node.source})`,
        target: { kind: 'node', id: node.id },
      })
    }
    return list
  }, [groups, nodes])

  const defaultCustomTarget =
    customOutbounds.find(item => item.target.kind === 'node')?.target ?? customOutbounds[0]?.target ?? { kind: 'selected' as const }

  const allTargetOptions = useMemo(
    () => [
      { value: 'direct', label: tr('直连') },
      { value: 'selected', label: tr('当前代理出口') },
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
      const rest = previous.filter(
        row =>
          !(
            row.hostMatcher === activeHostMatcher &&
            normalizeHostRuleValue(row.hostMatcher, row.hostValue) === normalized
          ),
      )
      if (!next) return rest
      return [
        {
          id: `${Date.now()}:${activeHostMatcher}:${normalized}`,
          hostMatcher: activeHostMatcher,
          hostValue: activeHostValue,
          target: next,
        },
        ...rest,
      ]
    })
  }

  const recentAppHosts = useMemo(() => {
    if (!canProcessRule || !connection) return []
    const seen = new Set<string>()
    if (extracted.kind !== 'none') {
      seen.add(extracted.value.toLowerCase())
      if (extracted.suggestedSuffix) seen.add(extracted.suggestedSuffix.toLowerCase())
    }
    for (const row of fineRules) {
      seen.add(normalizeHostRuleValue(row.hostMatcher, row.hostValue))
    }
    const procKey = activeProcessValue.toLowerCase()
    const items: { matcher: HostMatcher; value: string }[] = []
    for (const item of recentConnections) {
      const itemProc =
        procMatcher === 'processName'
          ? (item.processName || item.appExecutable || (isExeName(item.app) ? item.app : '')).trim().toLowerCase()
          : (item.processPath ?? '').trim().toLowerCase()
      if (!itemProc || itemProc !== procKey) continue
      const info = extractHostInfo(item.host || item.target, item.destinationIp)
      if (info.kind === 'none') continue
      const candidate = info.kind === 'domain' && info.suggestedSuffix ? info.suggestedSuffix : info.value
      const matcher: HostMatcher = info.kind === 'ip' ? 'ip' : info.suggestedSuffix ? 'domainSuffix' : 'domain'
      const key = normalizeHostRuleValue(matcher, candidate)
      if (seen.has(key)) continue
      seen.add(key)
      items.push({ matcher, value: candidate })
      if (items.length >= 10) break
    }
    return items
  }, [activeProcessValue, canProcessRule, connection, extracted, fineRules, procMatcher, recentConnections])

  function upsertFineRule(
    list: FineDraftRow[],
    matcher: HostMatcher,
    value: string,
    target: RouteTarget,
  ): FineDraftRow[] {
    const key = normalizeHostRuleValue(matcher, value)
    const rest = list.filter(
      row =>
        !(
          row.hostMatcher === matcher &&
          normalizeHostRuleValue(row.hostMatcher, row.hostValue) === key
        ),
    )
    return [
      {
        id: `${Date.now()}:${matcher}:${key}`,
        hostMatcher: matcher,
        hostValue: value,
        target,
      },
      ...rest,
    ]
  }

  function validateManualHost(matcher: HostMatcher, raw: string): string | null {
    const valid = validatePolicyHostValue(matcher, raw)
    if (!valid) {
      showMessage({
        type: 'warning',
        title: matcher === 'ip' ? tr('请输入有效 IP 地址或 CIDR 网段') : tr('请输入有效域名，例如 example.com'),
      })
    }
    return valid
  }

  function addManualFineRule() {
    const trimmed = manualHost.trim()
    if (!trimmed) {
      showMessage({ type: 'warning', title: tr('请先填写域名或 IP') })
      return
    }
    const valid = validateManualHost(manualMatcher, trimmed)
    if (!valid) return
    setFineRules(previous => upsertFineRule(previous, manualMatcher, valid, manualTarget))
    setManualHost('')
  }

  async function handleSave() {
    if (!connection || saving) return
    const hasStandaloneTarget = Boolean(activeHostMatcher && activeHostValue)
    if (!canProcessRule && !hasStandaloneTarget) return
    let nextFineRules = fineRules
    if (canProcessRule && manualHost.trim()) {
      const valid = validateManualHost(manualMatcher, manualHost)
      if (!valid) return
      nextFineRules = upsertFineRule(fineRules, manualMatcher, valid, manualTarget)
      setFineRules(nextFineRules)
      setManualHost('')
    }
    setSaving(true)
    try {
      const latest = await air.routingSettings()
      let nextRules: RouteRule[]
      if (canProcessRule) {
        nextRules = mergeAppPolicyRules<RouteTarget, RouteRule>(latest.routing.rules, {
          processMatcher: procMatcher,
          processValue: activeProcessValue,
          coarseTarget,
          fineRules: nextFineRules.map(item => ({
            hostMatcher: item.hostMatcher as PolicyHostMatcher,
            hostValue: item.hostValue,
            target: item.target,
          })),
        })
      } else if (activeHostMatcher && activeHostValue) {
        nextRules = mergeStandaloneHostRule<RouteTarget, RouteRule>(latest.routing.rules, {
          hostMatcher: activeHostMatcher,
          hostValue: activeHostValue,
          target: standaloneTarget,
        })
      } else {
        nextRules = latest.routing.rules
      }
      await air.saveRouting({ ...latest.routing, rules: nextRules }, latest.revision)
      const procForClose = processName || processPath.split(/[\\/]/).pop() || undefined
      await air
        .closeMatchingConnections(
          canProcessRule ? procForClose : undefined,
          canProcessRule ? undefined : activeHostValue || undefined,
        )
        .catch(() => undefined)
      showMessage({ type: 'success', title: tr('分流策略已保存并生效') })
      onClose()
    } catch (error) {
      showMessage({ type: 'error', title: error instanceof Error ? error.message : String(error) })
    } finally {
      setSaving(false)
    }
  }

  function renderPresetButtons(
    value: RouteTarget | null,
    onChange: (next: RouteTarget | null) => void,
    defaultLabel: string,
    onTintedSurface = false,
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
        <div className="grid grid-cols-5 gap-1.5">
          {buttons.map(btn => {
            const active = preset === btn.id
            const activeClass =
              btn.id === 'direct'
                ? 'border-success/55 bg-success-soft font-semibold text-success shadow-2xs hover:bg-success-soft'
                : btn.id === 'reject'
                  ? 'border-destructive/55 bg-danger-soft font-semibold text-destructive shadow-2xs hover:bg-danger-soft'
                  : 'border-primary/65 bg-primary/18 font-semibold text-primary shadow-2xs hover:bg-primary/22'
            const inactiveClass = onTintedSurface
              ? 'border-border/90 bg-card text-foreground/90 hover:border-accent-border hover:bg-card/85 dark:border-[#3a4158] dark:bg-[#1a1d28] dark:text-foreground/85 dark:hover:border-[#4d5673] dark:hover:bg-[#2d3245]'
              : 'border-border bg-secondary/90 text-foreground/90 hover:border-accent-border hover:bg-accent dark:border-[#343640] dark:bg-[#27282f] dark:text-foreground/85 dark:hover:bg-[#31333d]'
            return (
              <Button
                key={btn.id}
                type="button"
                size="sm"
                variant="outline"
                title={btn.label}
                disabled={saving || loading || (btn.id === 'custom' && !customOutbounds.length)}
                className={cn('min-w-0 px-1.5', active ? activeClass : inactiveClass)}
                onClick={btn.apply}
              >
                <span className="truncate">{btn.label}</span>
              </Button>
            )
          })}
        </div>
        {preset === 'custom' && value && customOutbounds.length > 0 && (
          <AirSelect
            label={tr('选择指定出站')}
            value={targetKey(value)}
            disabled={saving || loading}
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
  const hasConfigurableTarget = canProcessRule || Boolean(activeHostMatcher && activeHostValue)

  return (
    <Dialog open={Boolean(connection)} onOpenChange={open => { if (!open && !saving) onClose() }}>
      <DialogContent className="max-w-[540px] gap-3 bg-background dark:bg-[#141519]" showCloseButton={!saving}>
        <DialogHeader className="pb-1">
          <DialogTitle>{tr('连接分流策略')}</DialogTitle>
        </DialogHeader>
        <DialogDescription className="sr-only">
          {tr('为当前应用设置默认分流规则与指定域名规则，优先级高于订阅配置。')}
        </DialogDescription>

        {connection && (
          <div className="air-scroll flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto pr-1">
            <div className="flex items-center justify-between gap-2 rounded-[10px] border border-(--exit-border) bg-(--exit-bg) p-3 shadow-(--shadow-card)">
              <div className="min-w-0 flex-1">
                <ConnectionApp
                  name={connection.app}
                  executable={connection.appExecutable}
                  icon={connection.appIconKey ? appIcons?.[connection.appIconKey] : undefined}
                />
                <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
                  <span className="mono truncate">{connection.target}</span>
                  <span>·</span>
                  <span className="truncate">{connection.rule || tr('默认路由')}</span>
                </div>
              </div>
              <Badge
                variant={connection.closed ? 'default' : 'success'}
                className="max-w-[175px] overflow-hidden"
                title={connection.path.at(-1) ?? undefined}
              >
                <span className="min-w-0 truncate">
                  <FlagText text={connection.path.at(-1) ?? '—'} />
                </span>
              </Badge>
            </div>

            {proxyMode !== 'rule' && (
              <div className="flex items-center justify-between gap-2 rounded-[8px] border border-warning/35 bg-warning-soft px-3 py-2 text-xs text-warning">
                <span>{tr('当前为非规则模式，自定义分流仅在「规则」模式下生效')}</span>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={saving}
                  onClick={() => void onSwitchToRuleMode()}
                >
                  {tr('切到规则')}
                </Button>
              </div>
            )}

            {canProcessRule ? (
              <div className="flex flex-col gap-2.5 rounded-[10px] border border-border bg-card p-3.5 shadow-(--shadow-card)">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-1.5">
                    <Shield className="size-4 shrink-0 text-primary" />
                    <strong className="truncate text-sm font-semibold">{tr('按应用分流')}</strong>
                  </div>
                  <div className="flex min-w-0 items-center gap-1.5">
                    {processName && processPath && (
                      <div className="inline-flex min-w-0 rounded-[7px] border border-border bg-background/90 p-0.5 text-[11px] dark:bg-[#131418]">
                        <button
                          type="button"
                          disabled={saving || loading}
                          title={processName}
                          onClick={() => switchProcMatcher('processName')}
                          className={cn(
                            'max-w-[140px] truncate rounded-[5px] px-2 py-0.5 transition-colors disabled:opacity-50',
                            procMatcher === 'processName'
                              ? 'bg-primary/15 font-semibold text-primary ring-1 ring-primary/30'
                              : 'text-muted-foreground hover:text-foreground',
                          )}
                        >
                          {processName}
                        </button>
                        <button
                          type="button"
                          disabled={saving || loading}
                          onClick={() => switchProcMatcher('processPath')}
                          className={cn(
                            'shrink-0 rounded-[5px] px-2 py-0.5 transition-colors disabled:opacity-50',
                            procMatcher === 'processPath'
                              ? 'bg-primary/15 font-semibold text-primary ring-1 ring-primary/30'
                              : 'text-muted-foreground hover:text-foreground',
                          )}
                        >
                          {tr('完整路径')}
                        </button>
                      </div>
                    )}
                    <Badge variant="accent">{tr('高于订阅')}</Badge>
                  </div>
                </div>
                {procMatcher === 'processPath' && processPath && (
                  <span className="mono truncate text-[11px] text-muted-foreground" title={processPath}>
                    {processPath}
                  </span>
                )}
                <span className="text-xs text-muted-foreground">
                  {tr('未单独指定域名时，该应用默认走：')}
                </span>
                {renderPresetButtons(coarseTarget, setCoarseTarget, tr('跟随默认'))}
              </div>
            ) : (
              <div className="rounded-[10px] border border-border bg-card px-3.5 py-2.5 text-xs text-muted-foreground shadow-(--shadow-card)">
                {tr('此连接未获取到 .exe 进程信息，将按目标域名/IP 配置全局规则')}
              </div>
            )}

            <div className="flex flex-col gap-3 rounded-[10px] border border-border bg-card p-3.5 shadow-(--shadow-card)">
              <div className="flex items-center justify-between gap-2">
                <strong className="text-sm font-semibold">{tr('按域名分流')}</strong>
                <Badge variant="success">{tr('最高优先级')}</Badge>
              </div>

              {activeHostMatcher && activeHostValue ? (
                <div className="flex flex-col gap-2.5 rounded-[9px] border border-accent-border/80 bg-accent-soft/70 p-3 shadow-2xs dark:border-[#3b4259] dark:bg-[#252938]">
                  <div className="flex items-center justify-between gap-2">
                    <span className="mono min-w-0 truncate text-xs font-semibold text-foreground" title={activeHostValue}>
                      {activeHostValue}
                    </span>
                    {extracted.kind === 'domain' && extracted.suggestedSuffix && extracted.suggestedSuffix !== extracted.value && (
                      <div className="inline-flex shrink-0 rounded-[7px] border border-accent-border/60 bg-card/90 p-0.5 text-[11px] dark:border-[#343a4f] dark:bg-[#171a24]">
                        <button
                          type="button"
                          disabled={saving || loading}
                          onClick={() => changeHostScope('suffix')}
                          className={cn(
                            'rounded-[5px] px-2 py-0.5 transition-colors disabled:opacity-50',
                            hostScope === 'suffix'
                              ? 'bg-primary/18 font-semibold text-primary ring-1 ring-primary/35'
                              : 'text-muted-foreground hover:text-foreground',
                          )}
                        >
                          {tr('含子域名')}
                        </button>
                        <button
                          type="button"
                          disabled={saving || loading}
                          onClick={() => changeHostScope('exact')}
                          className={cn(
                            'rounded-[5px] px-2 py-0.5 transition-colors disabled:opacity-50',
                            hostScope === 'exact'
                              ? 'bg-primary/18 font-semibold text-primary ring-1 ring-primary/35'
                              : 'text-muted-foreground hover:text-foreground',
                          )}
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
                    true,
                  )}
                </div>
              ) : !canProcessRule && (
                <p className="text-xs text-muted-foreground">
                  {tr('此连接既未包含 .exe 进程信息，也没有可识别的域名或 IP，暂不支持添加分流规则。')}
                </p>
              )}

              {recentAppHosts.length > 0 && (
                <div className="flex flex-col gap-1.5">
                  <span className="text-xs text-muted-foreground">
                    {tr('近期访问的域名（点击快速添加）：')}
                  </span>
                  <div className="flex flex-wrap gap-1.5">
                    {recentAppHosts.map(item => (
                      <Button
                        key={`${item.matcher}:${item.value}`}
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={saving || loading}
                        className="mono h-6 max-w-full gap-1 border-border bg-secondary/85 px-2 text-xs text-foreground/90 hover:border-accent-border hover:bg-accent dark:border-[#363946] dark:bg-[#262832]"
                        onClick={() =>
                          setFineRules(previous => [
                            {
                              id: `${Date.now()}:${item.matcher}:${item.value}`,
                              hostMatcher: item.matcher,
                              hostValue: item.value,
                              target: { kind: 'direct' },
                            },
                            ...previous,
                          ])
                        }
                      >
                        <Plus className="size-3 shrink-0" />
                        <span className="truncate">{item.value}</span>
                      </Button>
                    ))}
                  </div>
                </div>
              )}

              {otherFineRules.length > 0 && (
                <div className="flex flex-col gap-1.5 border-t border-border-subtle pt-2">
                  <span className="text-xs text-muted-foreground">{tr('其他已配置的域名规则：')}</span>
                  {otherFineRules.map(item => (
                    <div
                      key={item.id}
                      className="flex items-center gap-2 rounded-[8px] border border-border/80 bg-muted/45 px-2.5 py-1.5 dark:bg-[#22242c]"
                    >
                      <div className="flex min-w-0 flex-1 flex-col">
                        <span className="mono truncate text-xs font-medium text-foreground" title={item.hostValue}>{item.hostValue}</span>
                        <span className="text-[11px] text-muted-foreground">
                          {item.hostMatcher === 'domain'
                            ? tr('完整域名')
                            : item.hostMatcher === 'domainSuffix'
                              ? tr('域名及子域名')
                              : tr('IP 或网段')}
                        </span>
                      </div>
                      <div className="w-[152px] shrink-0">
                        <AirSelect
                          label={item.hostValue}
                          value={targetKey(item.target)}
                          disabled={saving || loading}
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
                        disabled={saving || loading}
                        aria-label={tr('删除规则')}
                        onClick={() => setFineRules(previous => previous.filter(r => r.id !== item.id))}
                      >
                        <Trash2 />
                      </Button>
                    </div>
                  ))}
                </div>
              )}

              {canProcessRule && (
                <div className="flex flex-col gap-1.5 rounded-[8px] border border-border/80 bg-muted/45 p-2.5 dark:bg-[#22242c]">
                  <span className="text-xs text-muted-foreground">{tr('手动添加域名规则：')}</span>
                  <div className="flex flex-col gap-1.5">
                    <div className="grid grid-cols-[124px_minmax(0,1fr)] items-center gap-1.5">
                      <AirSelect
                        label={tr('匹配方式')}
                        value={manualMatcher}
                        disabled={saving || loading}
                        options={[
                          { value: 'domainSuffix', label: tr('含子域名') },
                          { value: 'domain', label: tr('完整域名') },
                          { value: 'ip', label: tr('IP/网段') },
                        ]}
                        onChange={value => setManualMatcher(value as HostMatcher)}
                      />
                      <Input
                        value={manualHost}
                        disabled={saving || loading}
                        placeholder={manualMatcher === 'ip' ? '1.2.3.4/32' : 'example.com'}
                        spellCheck={false}
                        onKeyDown={e => {
                          if (e.key === 'Enter') {
                            e.preventDefault()
                            addManualFineRule()
                          }
                        }}
                        onChange={e => setManualHost(e.target.value)}
                      />
                    </div>
                    <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-1.5">
                      <AirSelect
                        label={tr('出站方式')}
                        value={targetKey(manualTarget)}
                        disabled={saving || loading}
                        options={allTargetOptions}
                        onChange={val => setManualTarget(resolveTargetFromValue(val))}
                      />
                      <Button
                        type="button"
                        size="sm"
                        variant="secondary"
                        disabled={saving || loading}
                        className="h-9 shrink-0 px-3"
                        onClick={addManualFineRule}
                      >
                        <Plus />{tr('添加')}
                      </Button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        <DialogFooter className="justify-end border-t border-border/80 pt-3">
          <Button type="button" variant="secondary" disabled={saving} onClick={onClose}>
            {tr('取消')}
          </Button>
          <Button type="button" variant="default" disabled={saving || loading || !hasConfigurableTarget} onClick={() => void handleSave()}>
            {saving ? tr('正在保存…') : tr('保存并生效')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
