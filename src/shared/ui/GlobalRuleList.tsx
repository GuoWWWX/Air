import { useState, type ReactNode } from 'react'
import { ArrowDown, ArrowUp, ChevronRight, Plus, Trash2 } from 'lucide-react'
import { tr } from '@/shared/i18n/messages'
import { applicationRule, moveRuleRow, replaceRuleRows, ruleRows, type RuleRow } from '@/shared/proxy/rule-rows'
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
  matchers: readonly { value: R['matcher']; label: string; disabled?: boolean }[]
  targets: { target: R['target']; label: string }[]
  newRule: () => R
  overlay: RuleOverlay
  save: (rules: R[]) => Promise<boolean>
}

export function GlobalRuleList<R extends PolicyRuleLike>({ rules, android, apps, matchers, targets, newRule, overlay, save }: Props<R>) {
  const rows = ruleRows(rules, android)
  const [edit, setEdit] = useState<{ indices: number[]; entries: R[]; original: R[] }>()
  const [busy, setBusy] = useState(false)
  const [drag, setDrag] = useState<RuleRow>()
  const targetIndex = (target: R['target']) => targets.findIndex(item => {
    return Object.entries(target).every(([key, value]) => Reflect.get(item.target, key) === value)
  })
  const label = (rule: R) => targets[targetIndex(rule.target)]?.label ?? tr('不可用')
  const open = (indices: number[], entries: R[]) => setEdit({ indices, entries, original: rules })
  const patch = (i: number, fields: Partial<PolicyRuleLike>) => setEdit(current => current && ({
    ...current, entries: current.entries.map((rule, at) => i === at ? { ...rule, ...fields } : rule),
  }))
  function reorder(index: number, delta: number) {
    if (!edit) return
    const entries = [...edit.entries]
    entries.splice(index + delta, 0, ...entries.splice(index, 1))
    setEdit({ ...edit, entries })
  }
  async function persist(next: R[], close = false) {
    if (busy) return
    setBusy(true)
    try {
      if (await save(next) && close) setEdit(undefined)
    } catch (error) {
      showMessage({ type: 'error', title: String(error instanceof Error ? error.message : error) })
    } finally { setBusy(false) }
  }
  function finish() {
    if (!edit) return
    if (JSON.stringify(edit.original) !== JSON.stringify(rules)) {
      showMessage({ type: 'error', title: tr('规则已变更，请重新打开') })
      return
    }
    for (const rule of edit.entries) {
      if (!rule.enabled) continue
      const error = rule.hostMatcher ? validatePolicyHostValue(rule.hostMatcher, rule.hostValue ?? '') : undefined
      if (error || !rule.value.trim()) {
        showMessage({ type: 'error', title: error ?? tr('请填写匹配值') })
        return
      }
    }
    void persist(replaceRuleRows(rules, edit.indices, edit.entries), true)
  }
  const addRelated = (exception: boolean) => {
    if (!edit?.entries[0]) return
    const base = { ...edit.entries[0], enabled: true, hostMatcher: exception ? 'domainSuffix' as const : undefined, hostValue: exception ? '' : undefined }
    setEdit({ ...edit, entries: exception ? [base, ...edit.entries] : [...edit.entries, base] })
  }
  const detail = edit?.entries[0]
  return <div className="flex min-w-0 flex-col gap-2">
    <div className="flex items-center justify-between gap-2"><h2 className="text-sm font-semibold">{tr('自定义规则')}</h2>
      <Button type="button" size="sm" variant="secondary" onClick={() => open([], [newRule()])}><Plus />{tr('添加规则')}</Button></div>
    {rows.map((row, position) => {
      const entries = row.indices.map(i => rules[i])
      const first = entries[0]
      const main = entries.find(rule => !rule.hostMatcher)
      const identity = row.application ? apps.find(app => entries.some(rule =>
        [app.executable, app.path].some(value => value && (android ? value === rule.value : value.toLowerCase() === rule.value.toLowerCase())))) : undefined
      const count = entries.filter(rule => rule.hostMatcher).length
      return <div key={row.key} className="flex min-w-0 items-center gap-1 rounded-md border border-border px-2 py-1"
        onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); if (drag && drag.key !== row.key) void persist(moveRuleRow(rules, drag, row)); setDrag(undefined) }}>
        <button type="button" draggable={!android} onDragStart={() => setDrag(row)} onDragEnd={() => setDrag(undefined)}
          className="flex min-w-0 flex-1 items-center gap-2 py-1.5 text-left" onClick={() => open(row.indices, entries)}>
          <span className="min-w-0 flex-1">
            {row.application ? <ConnectionApp name={identity?.name || first.value || tr('应用')} icon={identity?.icon} executable={first.value} />
              : <span className="block truncate text-sm font-medium" title={first.value}>{position + 1}. {first.value}</span>}
            <small className="block truncate text-muted-foreground">{row.application ? first.value + ' · ' + tr('{0} 条例外', count) : matchers.find(item => item.value === first.matcher)?.label}</small>
          </span>
          <Badge variant="accent" className="max-w-[32%] truncate">{main ? label(main) : tr('按域名细分')}</Badge><ChevronRight size={14} />
        </button>
        <Switch size="sm" aria-label={tr('启用规则')} disabled={busy} checked={entries.some(rule => rule.enabled)}
          onCheckedChange={enabled => void persist(rules.map((r, i) => row.indices.includes(i) ? { ...r, enabled } : r))} />
      </div>
    })}
    {edit && overlay(detail && applicationRule(detail) ? tr('软件分流详情') : tr('规则详情'), () => { if (!busy) setEdit(undefined) }, <div className="grid min-w-0 gap-3">
      {edit.entries.map((rule, i) => <div key={i} className="grid gap-2 rounded-md border border-border p-3">
        <div className="flex items-center gap-2"><strong className="flex-1 text-sm">{applicationRule(rule) ? rule.hostMatcher ? tr('域名或 IP 例外') : tr('整个应用') : tr('匹配方式')}</strong>
          <Switch size="sm" aria-label={tr('启用规则')} checked={rule.enabled} onCheckedChange={enabled => patch(i, { enabled })} />
          <Button type="button" size="icon-sm" variant="ghost" aria-label={tr('上移')} disabled={!i} onClick={() => reorder(i, -1)}><ArrowUp /></Button>
          <Button type="button" size="icon-sm" variant="ghost" aria-label={tr('下移')} disabled={i === edit.entries.length - 1} onClick={() => reorder(i, 1)}><ArrowDown /></Button>
          <Button type="button" size="icon-sm" variant="ghost" aria-label={tr('删除规则')} onClick={() => setEdit({ ...edit, entries: edit.entries.filter((_, at) => i !== at) })}><Trash2 /></Button></div>
        <AirSelect label={tr('匹配方式')} value={rule.matcher} options={matchers} onChange={matcher => patch(i, { matcher, hostMatcher: undefined, hostValue: undefined })} />
        <Input aria-label={tr('匹配值')} value={rule.value} placeholder={tr('匹配值')} onChange={event => patch(i, { value: event.target.value })} />
        {applicationRule(rule) && <AirSelect label={tr('限定目标方式')} value={rule.hostMatcher ?? 'all'}
          options={[{ value:'all', label:tr('整个应用') }, { value:'domainSuffix', label:tr('域名及子域名') }, { value:'domain', label:tr('完整域名') }, { value:'ip', label:tr('IP 或网段') }]}
          onChange={value => patch(i, {hostMatcher: value === 'all' ? undefined : value as PolicyHostMatcher, hostValue: value === 'all' ? undefined : rule.hostValue ?? ''})} />}
        {rule.hostMatcher && <Input aria-label={tr('限定域名或 IP')} placeholder={tr('限定域名或 IP')} value={rule.hostValue ?? ''} onChange={event => patch(i, { hostValue:event.target.value })} />}
        <AirSelect label={tr('出站方式')} value={String(targetIndex(rule.target))}
          options={[...(applicationRule(rule) && !rule.hostMatcher ? [{ value:'inherit', label:tr('保持订阅规则') }] : []),
            ...targets.map((item, index) => ({value:String(index),label:item.label}))]}
          onChange={value => value === 'inherit' ? setEdit({ ...edit, entries: edit.entries.filter((_, at) => i !== at) }) : patch(i, {target:targets[Number(value)].target})} />
      </div>)}
      {detail && applicationRule(detail) && <div className="flex flex-wrap gap-2">
        {!edit.entries.some(rule => !rule.hostMatcher) && <Button type="button" size="sm" variant="outline" onClick={() => addRelated(false)}>{tr('添加应用默认出站')}</Button>}
        <Button type="button" size="sm" variant="outline" onClick={() => addRelated(true)}><Plus />{tr('添加域名或 IP 例外')}</Button></div>}
      {!!edit.indices.length && <div className="flex items-center gap-2">{([-1, 1] as const).map(step => {
        const index = rows.findIndex(row => row.indices[0] === edit.indices[0])
        const other = rows[index + step]
        return <Button key={step} type="button" size="sm" variant="outline" disabled={!other || busy || JSON.stringify(edit.entries) !== JSON.stringify(edit.indices.map(i => rules[i]))}
          onClick={() => void persist(moveRuleRow(rules, rows[index], other), true)}>{step < 0 ? tr('提高优先级') : tr('降低优先级')}</Button>
      })}</div>}
      <Button type="button" disabled={busy} onClick={finish}>{tr('保存')}</Button>
    </div>)}
  </div>
}
