import { useEffect, useState, type ReactNode } from 'react'
import { AppWindow, ArrowDown, ArrowUp, ChevronRight, Plus, Trash2 } from 'lucide-react'
import { tr } from '@/shared/i18n/messages'
import { applicationRule, moveRuleRow, replaceRuleRows, ruleRows, toggleRuleRow, type RuleRow } from '@/shared/proxy/rule-rows'
import { validatePolicyHostValue, type PolicyRuleLike, type PolicyHostMatcher } from '@/shared/proxy/connection-policy'
import { AirSelect } from './AirSelect'
import { Badge } from './badge'
import { Button } from './button'
import { ConnectionApp } from './ConnectionApp'
import { Input } from './input'
import { Switch } from './switch'
import { showMessage } from './message'

export type RuleOverlay = (title: string, close: () => void, content: ReactNode) => ReactNode
export type AppIdentity = { executable?: string; path?: string; name?: string; icon?: string }

interface Props<R extends PolicyRuleLike> {
  rules: R[]
  android?: boolean
  apps: AppIdentity[]
  onInspectApp?: (value: string) => void
  matchers: readonly { value: R['matcher']; label: string; disabled?: boolean }[]
  targets: { target: R['target']; label: string }[]
  newRule: () => R
  overlay: RuleOverlay
  save: (rules: R[]) => Promise<boolean>
}

interface AppDialogMeta {
  matcher: string
  value: string
  name?: string
  icon?: string
}

interface EditState<R extends PolicyRuleLike> {
  indices: number[]
  entries: R[]
  original: R[]
  rowKey?: string
  app?: AppDialogMeta
}

export function GlobalRuleList<R extends PolicyRuleLike>({ rules, android, apps, onInspectApp, matchers, targets, newRule, overlay, save }: Props<R>) {
  const rows = ruleRows(rules, android)
  const [edit, setEdit] = useState<EditState<R>>()
  const [busy, setBusy] = useState(false)
  const [drag, setDrag] = useState<RuleRow>()
  const targetIndex = (target: R['target']) => targets.findIndex(item => {
    return Object.entries(target).every(([key, value]) => Reflect.get(item.target, key) === value)
  })
  const label = (rule: R) => targets[targetIndex(rule.target)]?.label ?? tr('不可用')
  const open = (indices: number[], entries: R[], rowKey?: string, app?: AppDialogMeta) =>
    setEdit({ indices, entries, original: rules, rowKey, app })
  const closeEdit = () => { if (!busy) setEdit(undefined) }
  const patch = (i: number, fields: Partial<PolicyRuleLike>) => setEdit(current => current && ({
    ...current, entries: current.entries.map((rule, at) => i === at ? { ...rule, ...fields } : rule),
  }))

  const findIdentity = (value: string) => {
    const trimmed = value.trim()
    if (!trimmed) return undefined
    const matches = (item?: string) => Boolean(item && (android ? item === trimmed : item.toLowerCase() === trimmed.toLowerCase()))
    return apps.find(app => (matches(app.executable) || matches(app.path)) && Boolean(app.name || app.icon))
      ?? apps.find(app => matches(app.executable) || matches(app.path))
  }

  const inspectedValue = edit?.app?.value
    ?? edit?.entries.find(rule => applicationRule(rule) && rule.value.trim())?.value
    ?? ''
  useEffect(() => {
    if (inspectedValue.trim()) onInspectApp?.(inspectedValue.trim())
  }, [inspectedValue, onInspectApp])

  const detectedApps: AppIdentity[] = []
  const seenAppKeys = new Set<string>()
  for (const app of apps) {
    const key = (android ? app.executable : (app.path || app.executable))?.trim().toLowerCase()
    if (!key || seenAppKeys.has(key)) continue
    seenAppKeys.add(key)
    detectedApps.push(app)
    if (detectedApps.length >= 8) break
  }

  function swapEntries(a: number, b: number) {
    if (!edit || a < 0 || b < 0 || a >= edit.entries.length || b >= edit.entries.length) return
    const entries = [...edit.entries]
    const item = entries[a]
    entries[a] = entries[b]
    entries[b] = item
    setEdit({ ...edit, entries })
  }

  async function persist(next: R[], close = false) {
    if (busy) return false
    setBusy(true)
    try {
      const ok = await save(next)
      if (ok && close) setEdit(undefined)
      return ok
    } catch (error) {
      showMessage({ type: 'error', title: String(error instanceof Error ? error.message : error) })
      return false
    } finally { setBusy(false) }
  }

  async function shiftRow(rowIndex: number, other: RuleRow) {
    if (!edit) return
    const nextRules = moveRuleRow(rules, rows[rowIndex], other)
    if (!await persist(nextRules, false)) return
    const nextRows = ruleRows(nextRules, android)
    const targetPos = rows[rowIndex].indices[0] > other.indices[0]
      ? other.indices[0]
      : other.indices[other.indices.length - 1]
    const moved = nextRows.find(item => edit.rowKey?.startsWith('app:') ? item.key === edit.rowKey : item.indices[0] === targetPos)
    setEdit(current => current && moved
      ? { ...current, rowKey: moved.key, indices: moved.indices, entries: moved.indices.map(i => nextRules[i]), original: nextRules }
      : undefined)
  }

  function finish() {
    if (!edit) return
    if (JSON.stringify(edit.original) !== JSON.stringify(rules)) {
      showMessage({ type: 'error', title: tr('规则已变更，请重新打开') })
      return
    }
    for (const rule of edit.entries) {
      if (!rule.enabled) continue
      const invalidHost = rule.hostMatcher && !validatePolicyHostValue(rule.hostMatcher, rule.hostValue ?? '')
      if (invalidHost || !rule.value.trim()) {
        showMessage({ type: 'error', title: invalidHost ? tr('请输入有效的域名或 IP') : tr('请填写匹配值') })
        return
      }
    }
    void persist(replaceRuleRows(rules, edit.indices, edit.entries), true)
  }

  const addAppException = () => {
    if (!edit?.app) return
    const seed = edit.entries[0]
    const base = {
      ...(seed ?? newRule()),
      matcher: seed?.matcher ?? edit.app.matcher,
      value: seed?.value ?? edit.app.value,
      enabled: true,
      hostMatcher: 'domainSuffix' as const,
      hostValue: '',
    }
    setEdit({ ...edit, entries: [base, ...edit.entries] })
  }

  const priorityControls = edit && edit.indices.length > 0 && rows.length > 1 && (() => {
    const active = edit
    const index = rows.findIndex(row => row.indices[0] === active.indices[0])
    const edited = JSON.stringify(active.entries) !== JSON.stringify(active.indices.map(i => rules[i]))
    return (
      <div className="flex items-center gap-1.5">
        {([-1, 1] as const).map(step => {
          const other = index >= 0 ? rows[index + step] : undefined
          return <Button key={step} type="button" size="sm" variant="outline" disabled={!other || busy || edited}
            onClick={() => other && void shiftRow(index, other)}>{step < 0 ? tr('提高优先级') : tr('降低优先级')}</Button>
        })}
      </div>
    )
  })()

  const footerActions = (
    <div className={android ? 'sheet-actions' : 'flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3'}>
      {priorityControls}
      <div className="ml-auto flex items-center gap-2">
        <Button type="button" variant="outline" disabled={busy} onClick={closeEdit}>{tr('取消')}</Button>
        <Button type="button" variant="default" disabled={busy} onClick={finish}>{tr('保存')}</Button>
      </div>
    </div>
  )

  const appMeta = edit?.app
  const liveIdentity = appMeta ? findIdentity(appMeta.value) : undefined
  const resolvedAppName = appMeta ? (liveIdentity?.name || appMeta.name) : undefined
  const resolvedAppIcon = appMeta ? (liveIdentity?.icon || appMeta.icon) : undefined
  const showAppSubline = Boolean(appMeta && resolvedAppName && resolvedAppName !== appMeta.value)
  const coarseIndex = edit && appMeta ? edit.entries.findIndex(rule => !rule.hostMatcher) : -1
  const coarseRule = edit && coarseIndex >= 0 ? edit.entries[coarseIndex] : undefined
  const fineItems = edit && appMeta
    ? edit.entries.map((rule, index) => ({ rule, index })).filter(({ rule }) => Boolean(rule.hostMatcher))
    : []

  return <div className="flex min-w-0 flex-col gap-2">
    <div className="flex items-center justify-between gap-2"><h2 className="text-sm font-semibold">{tr('自定义规则')}</h2>
      <Button type="button" size="sm" variant="secondary" onClick={() => open([], [newRule()])}><Plus />{tr('添加规则')}</Button></div>
    {rows.map((row, position) => {
      const entries = row.indices.map(i => rules[i])
      const first = entries[0]
      const main = entries.find(rule => !rule.hostMatcher)
      const identity = row.application ? findIdentity(first.value) : undefined
      const hasResolvedName = Boolean(identity?.name && identity.name !== first.value)
      const count = entries.filter(rule => rule.hostMatcher).length
      const matcherLabel = matchers.find(item => item.value === first.matcher)?.label
      return <div key={row.key} className="flex min-w-0 items-center gap-1 rounded-md border border-border px-2 py-1"
        onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); if (drag && drag.key !== row.key) void persist(moveRuleRow(rules, drag, row)); setDrag(undefined) }}>
        <button type="button" draggable={!android} onDragStart={() => setDrag(row)} onDragEnd={() => setDrag(undefined)}
          className="flex min-w-0 flex-1 items-center gap-2 py-1.5 text-left"
          onClick={() => open(row.indices, entries, row.key, row.application ? { matcher: first.matcher, value: first.value, name: identity?.name, icon: identity?.icon } : undefined)}>
          <span className="min-w-0 flex-1">
            {row.application ? <ConnectionApp name={identity?.name || first.value || tr('应用')} icon={identity?.icon} executable={first.value} />
              : <span className="block truncate text-sm font-medium" title={first.value}>{position + 1}. {first.value}</span>}
            <small className="block truncate text-muted-foreground">
              {row.application
                ? (hasResolvedName ? `${first.value} · ${tr('{0} 条例外', count)}` : `${matcherLabel ?? tr('应用')} · ${tr('{0} 条例外', count)}`)
                : matcherLabel}
            </small>
          </span>
          <Badge variant="accent" className="max-w-[32%] truncate">{main ? label(main) : tr('按域名细分')}</Badge><ChevronRight size={14} />
        </button>
        <Switch size="sm" aria-label={tr('启用规则')} disabled={busy} checked={entries.some(rule => rule.enabled)}
          onCheckedChange={enabled => void persist(toggleRuleRow(rules, row, enabled))} />
      </div>
    })}
    {edit && overlay(appMeta ? tr('软件分流详情') : tr('规则详情'), closeEdit, appMeta ? (
      <div className="grid min-w-0 gap-3">
        <div className="flex min-w-0 items-center gap-3 rounded-lg border border-border bg-muted/45 px-3 py-2.5">
          {resolvedAppIcon ? (
            <img src={resolvedAppIcon} alt="" draggable={false} className="size-8 shrink-0 rounded-md object-contain" />
          ) : (
            <span className="grid size-8 shrink-0 place-items-center rounded-md border border-border bg-background text-muted-foreground">
              <AppWindow aria-hidden="true" className="size-4" />
            </span>
          )}
          <div className="min-w-0 flex-1">
            <strong className="block truncate text-sm font-semibold">{resolvedAppName || appMeta.value || tr('应用')}</strong>
            {showAppSubline && (
              <small className="block truncate font-mono text-[11px] text-muted-foreground">{appMeta.value}</small>
            )}
          </div>
        </div>

        <div className="grid gap-2.5 rounded-lg border border-border bg-card p-3">
          <div className="flex items-center justify-between gap-2">
            <strong className="text-sm">{tr('整个应用')}</strong>
            {coarseRule && (
              <Switch size="sm" aria-label={tr('启用规则')} checked={coarseRule.enabled}
                onCheckedChange={enabled => patch(coarseIndex, { enabled, resumeOnEnable: undefined })} />
            )}
          </div>
          <div className="flex items-center justify-between gap-3">
            <span className="shrink-0 text-xs text-muted-foreground">{tr('出站方式')}</span>
            <div className="min-w-0 flex-1 max-w-[220px]">
              <AirSelect
                label={tr('出站方式')}
                value={coarseRule ? (targetIndex(coarseRule.target) >= 0 ? String(targetIndex(coarseRule.target)) : '') : 'inherit'}
                options={[
                  { value: 'inherit', label: tr('保持订阅规则') },
                  ...targets.map((item, index) => ({ value: String(index), label: item.label })),
                ]}
                onChange={value => {
                  if (value === 'inherit') {
                    if (coarseIndex >= 0) setEdit({ ...edit, entries: edit.entries.filter((_, at) => at !== coarseIndex) })
                    return
                  }
                  const target = targets[Number(value)]?.target
                  if (!target) return
                  if (coarseIndex >= 0) {
                    patch(coarseIndex, { target, enabled: true, resumeOnEnable: undefined })
                  } else {
                    const seed = edit.entries[0]
                    setEdit({
                      ...edit,
                      entries: [...edit.entries, { ...(seed ?? newRule()), matcher: seed?.matcher ?? appMeta.matcher, value: seed?.value ?? appMeta.value, hostMatcher: undefined, hostValue: undefined, enabled: true, target }],
                    })
                  }
                }}
              />
            </div>
          </div>
        </div>

        <div className="flex items-center justify-between gap-2 pt-0.5">
          <strong className="text-sm">{tr('域名或 IP 例外')}</strong>
          <Button type="button" size="sm" variant="outline" onClick={addAppException}>
            <Plus />{tr('添加域名或 IP 例外')}
          </Button>
        </div>

        {fineItems.length === 0 ? (
          <p className="text-xs text-muted-foreground">{tr('暂无域名或 IP 例外规则')}</p>
        ) : (
          fineItems.map(({ rule, index }, pos) => {
            const matchedTargetIdx = targetIndex(rule.target)
            return (
              <div key={index} className="grid gap-2.5 rounded-lg border border-border bg-card p-3">
                <div className="flex items-center gap-2">
                  <strong className="flex-1 text-sm">{pos + 1}. {tr('域名或 IP 例外')}</strong>
                  <Switch size="sm" aria-label={tr('启用规则')} checked={rule.enabled} onCheckedChange={enabled => patch(index, { enabled, resumeOnEnable: undefined })} />
                  <Button type="button" size="icon-sm" variant="ghost" aria-label={tr('上移')} disabled={pos === 0} onClick={() => swapEntries(index, fineItems[pos - 1].index)}><ArrowUp /></Button>
                  <Button type="button" size="icon-sm" variant="ghost" aria-label={tr('下移')} disabled={pos === fineItems.length - 1} onClick={() => swapEntries(index, fineItems[pos + 1].index)}><ArrowDown /></Button>
                  <Button type="button" size="icon-sm" variant="ghost" aria-label={tr('删除规则')} onClick={() => setEdit({ ...edit, entries: edit.entries.filter((_, at) => at !== index) })}><Trash2 /></Button>
                </div>
                <div className="grid grid-cols-[124px_minmax(0,1fr)] gap-2">
                  <AirSelect
                    label={tr('限定目标方式')}
                    value={rule.hostMatcher ?? 'domainSuffix'}
                    options={[
                      { value: 'domainSuffix', label: tr('域名及子域名') },
                      { value: 'domain', label: tr('完整域名') },
                      { value: 'ip', label: tr('IP 或网段') },
                    ]}
                    onChange={value => patch(index, { hostMatcher: value as PolicyHostMatcher })}
                  />
                  <Input aria-label={tr('限定域名或 IP')} placeholder={tr('限定域名或 IP')} value={rule.hostValue ?? ''} onChange={event => patch(index, { hostValue: event.target.value })} />
                </div>
                <div className="flex items-center justify-between gap-3">
                  <span className="shrink-0 text-xs text-muted-foreground">{tr('出站方式')}</span>
                  <div className="min-w-0 flex-1 max-w-[220px]">
                    <AirSelect
                      label={tr('出站方式')}
                      value={matchedTargetIdx >= 0 ? String(matchedTargetIdx) : ''}
                      options={targets.map((item, idx) => ({ value: String(idx), label: item.label }))}
                      onChange={value => {
                        const target = targets[Number(value)]?.target
                        if (target) patch(index, { target })
                      }}
                    />
                  </div>
                </div>
              </div>
            )
          })
        )}

        {footerActions}
      </div>
    ) : (
      <div className="grid min-w-0 gap-3">
        {edit.entries.map((rule, i) => {
          const matchedTargetIdx = targetIndex(rule.target)
          const matchedIdentity = applicationRule(rule) ? findIdentity(rule.value) : undefined
          return <div key={i} className="grid gap-2.5 rounded-lg border border-border bg-card p-3">
            <div className="flex items-center gap-2">
              <strong className="flex-1 text-sm">{applicationRule(rule) ? rule.hostMatcher ? tr('域名或 IP 例外') : tr('整个应用') : tr('匹配方式')}</strong>
              <Switch size="sm" aria-label={tr('启用规则')} checked={rule.enabled} onCheckedChange={enabled => patch(i, { enabled, resumeOnEnable: undefined })} />
              {edit.entries.length > 1 && <>
                <Button type="button" size="icon-sm" variant="ghost" aria-label={tr('上移')} disabled={!i} onClick={() => swapEntries(i, i - 1)}><ArrowUp /></Button>
                <Button type="button" size="icon-sm" variant="ghost" aria-label={tr('下移')} disabled={i === edit.entries.length - 1} onClick={() => swapEntries(i, i + 1)}><ArrowDown /></Button>
              </>}
              <Button type="button" size="icon-sm" variant="ghost" aria-label={tr('删除规则')} onClick={() => setEdit({ ...edit, entries: edit.entries.filter((_, at) => i !== at) })}><Trash2 /></Button>
            </div>
            <div className="grid grid-cols-[132px_minmax(0,1fr)] gap-2">
              <AirSelect label={tr('匹配方式')} value={rule.matcher} options={matchers} onChange={matcher => patch(i, { matcher, hostMatcher: undefined, hostValue: undefined })} />
              <Input aria-label={tr('匹配值')} value={rule.value} placeholder={tr('匹配值')} onChange={event => patch(i, { value: event.target.value })} />
            </div>
            {matchedIdentity?.name && (
              <div className="flex min-w-0 items-center gap-2 rounded-md border border-border bg-muted/40 px-2.5 py-1.5 text-xs">
                <ConnectionApp name={matchedIdentity.name} icon={matchedIdentity.icon} executable={rule.value} />
                {matchedIdentity.name !== rule.value.trim() && (
                  <span className="ml-auto shrink-0 font-mono text-[11px] text-muted-foreground">{rule.value.trim()}</span>
                )}
              </div>
            )}
            {applicationRule(rule) && detectedApps.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-[11px] text-muted-foreground">{tr('选择已识别应用：')}</span>
                {detectedApps.map(app => {
                  const picked = android
                    ? (app.executable || app.path || '')
                    : (rule.matcher === 'processPath' ? (app.path || app.executable || '') : (app.executable || app.path || ''))
                  return picked ? (
                    <Button key={(app.executable ?? '') + ':' + (app.path ?? '')} type="button" size="sm" className="h-6 px-2 text-xs"
                      variant={rule.value === picked ? 'subtle' : 'outline'}
                      onClick={() => patch(i, { value: picked })}>{app.name || picked}</Button>
                  ) : null
                })}
              </div>
            )}
            {applicationRule(rule) && (rule.hostMatcher ? (
              <div className="grid grid-cols-[124px_minmax(0,1fr)] gap-2">
                <AirSelect label={tr('限定目标方式')} value={rule.hostMatcher}
                  options={[{ value: 'all', label: tr('整个应用') }, { value: 'domainSuffix', label: tr('域名及子域名') }, { value: 'domain', label: tr('完整域名') }, { value: 'ip', label: tr('IP 或网段') }]}
                  onChange={value => patch(i, { hostMatcher: value === 'all' ? undefined : value as PolicyHostMatcher, hostValue: value === 'all' ? undefined : rule.hostValue ?? '' })} />
                <Input aria-label={tr('限定域名或 IP')} placeholder={tr('限定域名或 IP')} value={rule.hostValue ?? ''} onChange={event => patch(i, { hostValue: event.target.value })} />
              </div>
            ) : (
              <div className="flex items-center justify-between gap-3">
                <span className="shrink-0 text-xs text-muted-foreground">{tr('限定目标方式')}</span>
                <div className="min-w-0 flex-1 max-w-[220px]">
                  <AirSelect label={tr('限定目标方式')} value="all"
                    options={[{ value: 'all', label: tr('整个应用') }, { value: 'domainSuffix', label: tr('域名及子域名') }, { value: 'domain', label: tr('完整域名') }, { value: 'ip', label: tr('IP 或网段') }]}
                    onChange={value => patch(i, { hostMatcher: value === 'all' ? undefined : value as PolicyHostMatcher, hostValue: value === 'all' ? undefined : rule.hostValue ?? '' })} />
                </div>
              </div>
            ))}
            <div className="flex items-center justify-between gap-3">
              <span className="shrink-0 text-xs text-muted-foreground">{tr('出站方式')}</span>
              <div className="min-w-0 flex-1 max-w-[220px]">
                <AirSelect label={tr('出站方式')} value={matchedTargetIdx >= 0 ? String(matchedTargetIdx) : ''}
                  options={targets.map((item, index) => ({ value: String(index), label: item.label }))}
                  onChange={value => {
                    const target = targets[Number(value)]?.target
                    if (target) patch(i, { target })
                  }} />
              </div>
            </div>
          </div>
        })}
        {footerActions}
      </div>
    ))}
  </div>
}
