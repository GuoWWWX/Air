import { useEffect, useRef, useState } from 'react'
import { parseDocument, stringify } from 'yaml'
import { tr } from '@/shared/i18n/messages'
import { emptyRuleLibrary, setBinding, dropBinding, validateRuleLibrary, type RuleLibrary, type RuleProfile, type UserRuleSet } from '@/shared/proxy/rule-library'
import { Button } from './button'
import { Input } from './input'
import { showMessage } from './message'
import { Select, SelectContent, SelectGroup, SelectGroupLabel, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from './select'
import { Textarea } from './textarea'
import type { RuleOverlay } from './GlobalRuleList'

export interface RuleSourceOption { id: string; name: string }
export interface LibrarySource extends RuleSourceOption { updated?: number; read: () => Promise<RuleProfile> }

const DEFAULT_BINDING = '__default__'
const EMPTY_OWNER = '__empty__'

export function RuleBindingPicker({ sources, catalog, value, change, disabled }: {
  sources: RuleSourceOption[]; catalog?: RuleLibrary; value: string; change: (next: string) => void; disabled?: boolean
}) {
  const subscriptionSources = sources.filter(s => s.id !== 'custom')
  const sets = catalog?.sets ?? []
  const items = [
    { value: DEFAULT_BINDING, label: tr('跟随默认') },
    { value: 'none', label: tr('不使用规则集') },
    ...subscriptionSources.map(s => ({ value: 'subscription:' + s.id, label: s.name })),
    ...sets.map(s => ({ value: 'user:' + s.id, label: s.name })),
  ]
  const current = value || DEFAULT_BINDING
  const stale = Boolean(value && !items.some(item => item.value === value))
  if (stale) items.push({ value, label: tr('不可用') })

  return <div className="field flex min-w-0 flex-col gap-1.5">
    <span className="text-xs font-medium text-foreground">{tr('分流规则')}</span>
    <Select
      items={items}
      value={current}
      disabled={disabled}
      modal={false}
      onValueChange={next => {
        if (typeof next !== 'string') return
        if (stale && next === value) return
        change(next === DEFAULT_BINDING ? '' : next)
      }}
    >
      <SelectTrigger aria-label={tr('分流规则')}>
        <SelectValue placeholder={tr('跟随默认')} className="truncate" />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          <SelectItem value={DEFAULT_BINDING} label={tr('跟随默认')}>{tr('跟随默认')}</SelectItem>
          <SelectItem value="none" label={tr('不使用规则集')}>{tr('不使用规则集')}</SelectItem>
        </SelectGroup>
        {subscriptionSources.length > 0 && (
          <>
            <SelectSeparator />
            <SelectGroup>
              <SelectGroupLabel>{tr('订阅自带规则')}</SelectGroupLabel>
              {subscriptionSources.map(s => (
                <SelectItem key={s.id} value={'subscription:' + s.id} label={s.name}>{s.name}</SelectItem>
              ))}
            </SelectGroup>
          </>
        )}
        {sets.length > 0 && (
          <>
            <SelectSeparator />
            <SelectGroup>
              <SelectGroupLabel>{tr('用户自建规则')}</SelectGroupLabel>
              {sets.map(s => (
                <SelectItem key={s.id} value={'user:' + s.id} label={s.name}>{s.name}</SelectItem>
              ))}
            </SelectGroup>
          </>
        )}
        {stale && (
          <>
            <SelectSeparator />
            <SelectGroup>
              <SelectItem value={value} disabled label={tr('不可用')}>{tr('不可用')}</SelectItem>
            </SelectGroup>
          </>
        )}
      </SelectContent>
    </Select>
  </div>
}

export function readRuleProfile(input: unknown): RuleProfile {
  const profile = (Array.isArray(input) ? { rules: input } : input) as RuleProfile
  if (!profile || typeof profile !== 'object') throw new Error(tr('规则集格式无效'))
  if (profile.rules !== undefined && (!Array.isArray(profile.rules) || profile.rules.some(line => typeof line !== 'string' || !line.trim().includes(',')))) throw new Error(tr('规则集格式无效'))
  const providers = profile['rule-providers']
  if (providers && (typeof providers !== 'object' || Array.isArray(providers))) throw new Error(tr('规则集格式无效'))
  const groups = profile['proxy-groups']
  if (groups && (!Array.isArray(groups) || groups.some(g => !g || typeof g.name !== 'string' || typeof g.type !== 'string' || (g.proxies && (!Array.isArray(g.proxies) || g.proxies.some(n => typeof n !== 'string')))))) throw new Error(tr('规则集格式无效'))
  return { rules: profile.rules ?? [], ...(providers && { 'rule-providers': providers }),
    ...(groups?.length && { 'proxy-groups': groups }) }
}
export function profileYaml(yaml: string) {
  const doc = parseDocument(yaml)
  if (doc.errors.length) throw doc.errors[0]
  return readRuleProfile(doc.toJS({ maxAliasCount: 100 }))
}

type Draft = { id?: string; name: string; yaml: string; readOnly?: boolean }
export function RuleLibraryManager({ catalog = emptyRuleLibrary, sources, owners, save, overlay, importYaml, exportYaml }: {
  catalog?: RuleLibrary; sources: LibrarySource[]; owners: Record<string, string>; save: (next: RuleLibrary) => Promise<boolean>; overlay: RuleOverlay; importYaml?: () => Promise<string | null>; exportYaml: (name: string, yaml: string) => void | Promise<unknown>
}) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<Draft>()
  const [confirm, setConfirm] = useState<UserRuleSet>()
  const [owner, setOwner] = useState<string>()
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(false)
  const [profiles, setProfiles] = useState<Record<string, RuleProfile>>({})
  const [failures, setFailures] = useState<Record<string, string>>({})
  const fileInputRef = useRef<HTMLInputElement>(null)
  const revision = JSON.stringify(sources.map(s => [s.id, s.updated]))
  useEffect(() => {
    if (!open) return
    let live = true
    setProfiles({}); setFailures({})
    for (const s of sources) void s.read().then(profile => {
      if (live) setProfiles(prev => ({ ...prev, [s.id]: profile }))
    }).catch(e => { if (live) setFailures(prev => ({ ...prev, [s.id]: String(e) })) })
    return () => { live = false }
  }, [open, revision])
  const close = () => { if (!busy) { setDraft(undefined); setConfirm(undefined); setOwner(undefined); setQuery(''); setOpen(false) } }
  const refs = (ref: string) => Object.entries(catalog.bindings).filter(([, value]) => value === ref).map(([key]) => owners[key] ?? key)
  async function store(next: RuleLibrary) {
    setBusy(true)
    try { validateRuleLibrary(next); if (await save(next)) { setDraft(undefined); setConfirm(undefined) } }
    catch (error) { showMessage({ type: 'error', title: String(error instanceof Error ? error.message : error) }) }
    finally { setBusy(false) }
  }
  const details = (key: string) => {
    const names = refs(key)
    return names.length ? <small className="block break-words text-muted-foreground">{tr('绑定对象')} · {names.join('、')}</small> : null
  }
  const ownerGroups = (['subscription', 'group', 'node', 'chain'] as const).map((kind, i) => ({
    kind,
    label: [tr('订阅'), tr('分组'), tr('节点'), tr('链路')][i],
    items: Object.entries(owners)
      .filter(([key, name]) => key.startsWith(kind + ':') && (key === owner || name.toLowerCase().includes(query.toLowerCase())))
      .map(([value, label]) => ({ value, label })),
  })).filter(group => group.items.length > 0)
  const ownerItems = [
    { value: EMPTY_OWNER, label: tr('请选择') },
    ...ownerGroups.flatMap(group => group.items),
  ]

  return <><Button type="button" size="sm" variant="outline" className="justify-self-start self-start" onClick={() => setOpen(true)}>{tr('分流规则库')}</Button>
    {open && overlay(tr('分流规则库'), close, <div className="grid min-w-0 gap-3 text-sm">
      {owner !== undefined ? <>
        <Input aria-label={tr('搜索绑定对象')} placeholder={tr('搜索绑定对象')} value={query} onChange={e => setQuery(e.target.value)} />
        <div className="field flex min-w-0 flex-col gap-1.5">
          <span className="text-xs font-medium text-foreground">{tr('绑定对象')}</span>
          <Select
            items={ownerItems}
            value={owner || EMPTY_OWNER}
            disabled={busy}
            modal={false}
            onValueChange={next => {
              if (typeof next === 'string') setOwner(next === EMPTY_OWNER ? '' : next)
            }}
          >
            <SelectTrigger aria-label={tr('绑定对象')}>
              <SelectValue placeholder={tr('请选择')} className="truncate" />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value={EMPTY_OWNER} label={tr('请选择')}>{tr('请选择')}</SelectItem>
              </SelectGroup>
              {ownerGroups.map(group => (
                <SelectGroup key={group.kind}>
                  <SelectSeparator />
                  <SelectGroupLabel>{group.label}</SelectGroupLabel>
                  {group.items.map(item => (
                    <SelectItem key={item.value} value={item.value} label={item.label}>{item.label}</SelectItem>
                  ))}
                </SelectGroup>
              ))}
            </SelectContent>
          </Select>
        </div>
        {owner && <RuleBindingPicker sources={sources} catalog={catalog} value={catalog.bindings[owner] ?? ''} disabled={busy}
          change={value => void store(setBinding(catalog, owner, value))} />}
        <div className="flex justify-end"><Button type="button" size="sm" variant="outline" onClick={() => setOwner(undefined)}>{tr('返回')}</Button></div></>
      : confirm ? <><p>{tr('删除「{0}」后，关联对象将跟随默认规则。', confirm.name)}</p>{details('user:' + confirm.id)}
        <div className="flex items-center justify-end gap-2">
          <Button type="button" variant="outline" onClick={() => setConfirm(undefined)}>{tr('取消')}</Button>
          <Button type="button" variant="destructive" disabled={busy} onClick={() => void store(dropBinding(catalog, 'user:' + confirm.id))}>{tr('确认删除')}</Button>
        </div></>
      : draft ? <>
        <Input aria-label={tr('规则集名称')} readOnly={draft.readOnly} value={draft.name} placeholder={tr('规则集名称')} onChange={e => setDraft({ ...draft, name: e.target.value })} />
        <Textarea aria-label={tr('规则集 YAML')} className="min-h-56 font-mono text-xs" spellCheck={false}
          readOnly={draft.readOnly} value={draft.yaml} onChange={e => setDraft({ ...draft, yaml: e.target.value })} />
        <div className="flex flex-wrap items-center gap-2">
          {!draft.readOnly && <Button type="button" size="sm" variant="default" disabled={busy || !draft.name.trim()} onClick={() => {
            try {
              const doc = parseDocument(draft.yaml)
              if (doc.errors.length) throw doc.errors[0]
              const raw = doc.toJS({ maxAliasCount: 100 })
              if (!Array.isArray(raw) && !Array.isArray(raw?.rules)) throw new Error(tr('rules 需要是规则列表'))
              const set = { id: draft.id ?? crypto.randomUUID(), name: draft.name.trim(), profile: readRuleProfile(raw) }
              void store({ ...catalog, sets: draft.id ? catalog.sets.map(s => s.id === set.id ? set : s) : [...catalog.sets, set] })
            } catch (e) { showMessage({ type: 'error', title: String(e) }) }
          }}>{tr('保存')}</Button>}
          <Button type="button" size="sm" variant="outline" onClick={() => void navigator.clipboard.writeText(draft.yaml).then(() => showMessage({ type: 'success', title: tr('已复制') })).catch(e => showMessage({ type: 'error', title: String(e) }))}>{tr('复制 YAML')}</Button>
          <Button type="button" size="sm" variant="outline" onClick={() => void Promise.resolve(exportYaml(draft.name || 'rules', draft.yaml)).catch(e => showMessage({ type: 'error', title: String(e) }))}>{tr('导出 YAML')}</Button>
          {!draft.readOnly && <>
            <input ref={fileInputRef} type="file" accept=".yaml,.yml,.txt" className="sr-only" onChange={async e => {
              const file = e.target.files?.[0]
              e.target.value = ''
              if (file) try {
                const text = await file.text()
                setDraft(current => current && { ...current, yaml: text })
              } catch (error) { showMessage({ type: 'error', title: String(error) }) }
            }} />
            <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => {
              if (importYaml) {
                void importYaml().then(text => {
                  if (text !== null) setDraft(current => current && { ...current, yaml: text })
                }).catch(error => showMessage({ type: 'error', title: String(error) }))
              } else {
                fileInputRef.current?.click()
              }
            }}>{tr('导入 YAML')}</Button>
          </>}
          <Button type="button" size="sm" variant="ghost" className="ml-auto" onClick={() => setDraft(undefined)}>{tr('返回')}</Button>
        </div></> : <>
        <div className="flex items-center justify-between gap-2">
          <h3 className="font-semibold">{tr('订阅自带规则')}</h3>
          <Button type="button" size="sm" variant="outline" onClick={() => setOwner('')}>{tr('管理绑定')}</Button>
        </div>
        {sources.map(s => <div key={s.id} className="rounded-md border border-border p-2">
          <div className="flex items-center gap-2"><button type="button" disabled={!profiles[s.id]} className="min-w-0 flex-1 truncate text-left" onClick={() => setDraft({ name: s.name, yaml: stringify(profiles[s.id]), readOnly: true })}>{s.name}</button>
            <small>{profiles[s.id] && tr('{0} 条规则', profiles[s.id].rules.length)}</small>
            <Button type="button" size="sm" variant="outline" disabled={!profiles[s.id]} onClick={() => setDraft({ name: tr('{0} 副本', s.name), yaml: stringify(profiles[s.id]) })}>{tr('克隆')}</Button></div>
          {s.updated ? <small className="text-muted-foreground">{new Date(s.updated).toLocaleString()}</small> : null}{failures[s.id]}{details('subscription:' + s.id)}
        </div>)}
        <div className="flex items-center justify-between"><h3 className="font-semibold">{tr('用户自建规则')}</h3><Button type="button" size="sm" onClick={() => setDraft({ name: '', yaml: 'rules: []\n' })}>{tr('新建')}</Button></div>
        {catalog.sets.map(set => <div key={set.id} className="rounded-md border border-border p-2"><div className="flex items-center gap-2">
          <button type="button" className="min-w-0 flex-1 truncate text-left" onClick={() => setDraft({ id: set.id, name: set.name, yaml: stringify(set.profile) })}>{set.name}</button>
          <small>{tr('{0} 条规则', set.profile.rules.length)}</small><Button type="button" size="sm" variant="ghost" onClick={() => setConfirm(set)}>{tr('删除')}</Button></div>{details('user:' + set.id)}</div>)}
      </>}
    </div>)}</>
}
