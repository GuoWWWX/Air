import { LanguagePicker } from '@/shared/i18n/LanguagePicker'
import { savePreviewLanguage, tr } from '@/shared/i18n/messages'
import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState } from 'react'

let savedSettingsScrollTop = 0
import { Activity, ArrowDown, ArrowUp, Check, FileCode2, GitBranch, Globe, Info, Monitor, Moon, Network, Palette, Plug, Plus, RefreshCw, Save, Search, Settings, Sun, Trash2, Waypoints } from 'lucide-react'
import { LayoutGroup, motion } from 'motion/react'
import { AirSelect } from '@/shared/ui/AirSelect'
import { Button } from '@/shared/ui/button'
import { EditorSearchBar, useEditorSearch } from '@/shared/ui/EditorSearchBar'
import { Input } from '@/shared/ui/input'
import { showMessage } from '@/shared/ui/message'
import logo from '@/assets/air-m1.svg'
import { native, onAndroid } from './bridge'
import { compileRule, configSource, defaultRouting, parseSettings, ruleMatchers, validateRouting, type HostMatcher, type MobileRouting, type RouteRule, type RouteTarget } from './configuration'
import { compile, ruleSourceId, type Library, type Theme } from './model'
import { SettingSwitch, type NetworkPage } from './network-settings'
import { Row, Tag } from './ui'
import { Field } from './workflows'
import type { Model } from './views'

const ConfigCodeEditor = lazy(() => import('@/shared/ui/ConfigCodeEditor').then(module => ({ default: module.ConfigCodeEditor })))

export type SettingsPage = 'theme' | NetworkPage | 'routing' | 'kernel' | 'configFile' | 'about'
export const themeNames: Record<Theme, string> = { get system() { return tr('跟随系统') }, get light() { return tr('浅色') }, get dark() { return tr('深色') } }
export const settingsTitles: Record<SettingsPage, string> = {
  get theme() { return tr('主题') }, get dns() { return tr('DNS 设置') }, get tun() { return tr('虚拟网卡（TUN）') }, get inbound() { return tr('代理接入') }, get routing() { return tr('分流规则') },
  get kernel() { return tr('诊断内核') }, get configFile() { return tr('配置文件') }, get monitoring() { return tr('后台监测') }, get about() { return tr('关于') },
}
const settingsRows = [
  { page: 'dns', icon: Globe, get description() { return tr('主 DNS、加密解析、分域 DNS 与 Fake-IP') } },
  { page: 'tun', icon: Network, get description() { return tr('协议栈、MTU、DNS 接管与绕过网段') } },
  { page: 'inbound', icon: Plug, get description() { return tr('本地端口、局域网共享与 IPv6') } },
  { page: 'routing', icon: Waypoints, get description() { return tr('按域名、IP 网段或应用包名选择出站') } },
  { page: 'kernel', icon: Settings, get description() { return tr('检查 Android 内置 Mihomo 内核') } },
  { page: 'configFile', icon: FileCode2, get description() { return tr('编辑和校验 Air 的 YAML 配置') } },
] as const

export function SettingsIndex({ library, open }: { library: Library; open: (page: SettingsPage) => void }) {
  const scrollRef = useRef<HTMLElement>(null)

  useLayoutEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = savedSettingsScrollTop
  }, [])

  return <main
    ref={scrollRef}
    onScroll={e => { savedSettingsScrollTop = e.currentTarget.scrollTop }}
    className="page-scroll settings"
  >
    <section><h2>{tr("外观")}</h2><div className="panel settings-panel">
      <Row icon={Palette} title={settingsTitles.theme} description={tr("选择浅色、深色或跟随系统外观")}
        value={themeNames[library.theme]} onClick={() => open('theme')} />
      <LanguagePicker variant="mobile" embedded save={code => onAndroid ? native('chooseLanguage', { code }) : savePreviewLanguage(code)}
        importPack={onAndroid ? async () => {
          const file = await native<{ text: string } | null>('file')
          if (!file) return false
          await native('importLanguage', { text: file.text })
          return true
        } : undefined} />
    </div></section>
    <section><h2>{tr("代理配置")}</h2><div className="panel settings-panel">
      {settingsRows.map(({ page, icon, description }) =>
        <Row key={page} icon={icon} title={settingsTitles[page]} description={description} onClick={() => open(page)} />)}
    </div></section>
    <section><h2>{tr("监测")}</h2><div className="panel settings-panel">
      <Row icon={Activity} title={settingsTitles.monitoring} description={tr("自动刷新节点可用率和延迟")}
        value={library.monitoring ? tr('已开启') : tr('已关闭')} onClick={() => open('monitoring')} />
    </div></section>
    <section aria-label={settingsTitles.about}><div className="panel settings-panel">
      <Row icon={Info} title={settingsTitles.about} description={tr("Air Proxy 版本、软件更新与作者 GitHub")} onClick={() => open('about')} />
    </div></section>
  </main>
}

const themeIcons = { system: Monitor, light: Sun, dark: Moon }
export function ThemeSettings({ value, onChange }: { value: Theme; onChange: (theme: Theme) => void }) {
  return <main className="page-scroll">
    <div className="theme-options" role="group" aria-label={tr("主题模式")}>
      <LayoutGroup id="android-theme">
        {(['system', 'light', 'dark'] as const).map(option => {
          const Icon = themeIcons[option]
          const active = value === option
          return <motion.button key={option} type="button" className="theme-option" whileTap={{ scale: 0.96 }}
            aria-pressed={active} onClick={() => onChange(option)}>
            {active && <motion.span className="theme-indicator" layoutId="selection" aria-hidden
              transition={{ type: 'spring', stiffness: 520, damping: 38 }} />}
            <span className="theme-preview" data-appearance={option}><span /><span /><span /></span>
            <span className="theme-name"><Icon size={14} />{themeNames[option]}{active && <Check size={14} />}</span>
          </motion.button>
        })}
      </LayoutGroup>
    </div>
  </main>
}

function targetKey(target: RouteTarget) { return 'id' in target ? target.kind + ':' + target.id : target.kind }

export function RoutingSettings({ library, model, busy, sdk, save }: {
  library: Library; model: Model; busy: boolean; sdk: number; save: (routing: MobileRouting) => void
}) {
  const [draft, setDraft] = useState(library.routing)
  const [preview, setPreview] = useState<string[]>()
  const sourceNames = new Map(library.sources.map(source => [source.id, source.name]))
  const sourceName = sourceNames.get(ruleSourceId(library, model))
  const targets: { target: RouteTarget; label: string; disabled?: boolean }[] = [
    { target: { kind: 'selected' }, label: tr('当前所选出口') },
    { target: { kind: 'direct' }, label: tr('直连') },
    { target: { kind: 'reject' }, label: tr('拒绝连接') },
    { target: { kind: 'subscription' }, label: tr('沿用订阅默认出口') },
    ...model.groups.map(group => ({ target: { kind: 'group' as const, id: group.id }, label: group.name })),
    ...library.chains.map(chain => ({ target: { kind: 'chain' as const, id: chain.id }, label: tr('链式出口 · ') + chain.name })),
    ...model.nodes.map(node => ({
      target: { kind: 'node' as const, id: node.id },
      label: `${node.config.name} (${node.sourceId === 'custom' ? tr('自定义节点') : (sourceNames.get(node.sourceId) ?? '')})`,
    })),
  ]
  function change(next: MobileRouting) { setDraft(next); setPreview(undefined) }
  function patch(index: number, fields: Partial<RouteRule>) {
    change({ ...draft, rules: draft.rules.map((rule, i) => i === index ? { ...rule, ...fields } : rule) })
  }
  function reorder(from: number, to: number) {
    const rules = [...draft.rules]
    const [rule] = rules.splice(from, 1)
    rules.splice(to, 0, rule)
    change({ ...draft, rules })
  }
  function check() {
    validateRouting(draft)
    const compiled = compile({ ...library, routing: draft }, model)
    const choices = [draft.fallback, ...draft.rules.filter(rule => rule.enabled).map(rule => rule.target)]
    if (choices.some(target => 'id' in target && !compiled.byId.has(target.id))) throw new Error(tr('有规则指向不可用的分组或链路'))
    if (sdk < 29 && draft.rules.some(rule => rule.enabled && rule.matcher === 'processName')) throw new Error(tr('按应用包名分流需要 Android 10 或更新版本'))
    return compiled.plan.config.rules
  }
  function selectTarget(label: string, value: RouteTarget, onChange: (value: RouteTarget) => void) {
    const options = targets.map(({ target, label, disabled }) => ({ value: targetKey(target), label, disabled }))
    if (!options.some(option => option.value === targetKey(value))) {
      options.push({ value: targetKey(value), label: tr('出站已不可用'), disabled: true })
    }
    return <div className="field"><span>{label}</span><AirSelect label={label} value={targetKey(value)} options={options} onChange={key => {
      const selected = targets.find(item => targetKey(item.target) === key)
      if (selected) onChange(selected.target)
    }} /></div>
  }
  return <form className="page-form" onSubmit={event => {
    event.preventDefault()
    try { check(); save(draft) }
    catch (failure) { showMessage({ type: 'error', title: errorText(failure) }) }
  }}>
    <main className="page-scroll">
      <fieldset disabled={busy} className="settings-fields">
        <section className="panel settings-form">
          <h2 className="settings-form-title">{tr("订阅规则与默认出口")}</h2>
          <div className="field"><span>{tr("订阅规则来源")}</span><strong>{sourceName ?? tr('无')}</strong></div>
          <p className="fine-print">{tr('先匹配自定义规则，再匹配当前节点所属订阅的规则。')}</p>
          {selectTarget(tr('默认出口'), draft.fallback, fallback => change({ ...draft, fallback }))}
        </section>
        <section className="panel settings-form">
          <div className="section-title"><h2 className="settings-form-title">{tr("自定义规则")}</h2>
            <Button type="button" size="sm" variant="outline" onClick={() => change({ ...draft, rules: [
              ...draft.rules, { enabled: true, matcher: 'domainSuffix', value: '', target: { kind: 'direct' } },
            ] })}><Plus data-icon="inline-start" />{tr("添加规则")}</Button>
          </div>
          <p className="fine-print">{tr("从上到下匹配，先匹配的规则优先。")}</p>
          {draft.rules.map((rule, index) => <div className={rule.enabled ? 'settings-rule' : 'settings-rule opacity-65'} key={index}>
            <div className="flex min-w-0 items-center justify-between gap-1">
              <div className="flex min-w-0 items-center gap-2">
                <SettingSwitch label={tr('规则 ') + (index + 1)} value={rule.enabled} onChange={enabled => patch(index, { enabled })} />
                {rule.matcher === 'processName' && rule.hostMatcher && <Tag tone="blue">{tr('复合规则')}</Tag>}
              </div>
              <div className="flex shrink-0 items-center gap-0.5">
                <Button type="button" size="icon-sm" variant="ghost" aria-label={tr("上移")} disabled={!index} onClick={() => reorder(index, index - 1)}><ArrowUp /></Button>
                <Button type="button" size="icon-sm" variant="ghost" aria-label={tr("下移")} disabled={index === draft.rules.length - 1} onClick={() => reorder(index, index + 1)}><ArrowDown /></Button>
                <Button type="button" size="icon-sm" variant="ghost" className="text-destructive" aria-label={tr("删除规则")}
                  onClick={() => change({ ...draft, rules: draft.rules.filter((_, i) => i !== index) })}><Trash2 /></Button>
              </div>
            </div>
            <div className="field"><span>{tr("匹配方式")}</span><AirSelect label={tr("匹配方式")} value={rule.matcher}
              options={ruleMatchers.map(option => ({ ...option, disabled: option.value === 'processName' && sdk < 29 }))}
              onChange={matcher => patch(index, { matcher, value: '', ...(matcher !== 'processName' ? { hostMatcher: undefined, hostValue: undefined } : {}) })} /></div>
            <Field label={tr("匹配值")}><Input value={rule.value} placeholder={ruleMatchers.find(option => option.value === rule.matcher)?.example}
              onChange={event => patch(index, { value: event.target.value })} spellCheck={false} /></Field>
            {rule.matcher === 'processName' && (
              <>
                <div className="field"><span>{tr("限定目标（可选，按域名分流）")}</span><AirSelect label={tr("限定目标方式")} value={rule.hostMatcher ?? 'none'}
                  options={[
                    { value: 'none', label: tr('不限（整个应用）') },
                    { value: 'domainSuffix', label: tr('域名及子域名') },
                    { value: 'domain', label: tr('完整域名') },
                    { value: 'ip', label: tr('IP 或网段') },
                  ]}
                  onChange={next => patch(index, next === 'none' ? { hostMatcher: undefined, hostValue: undefined } : { hostMatcher: next as HostMatcher, hostValue: rule.hostValue ?? '' })} /></div>
                {rule.hostMatcher && (
                  <Field label={tr("限定域名或 IP")}>
                    <Input
                      value={rule.hostValue ?? ''}
                      placeholder={rule.hostMatcher === 'ip' ? '10.0.0.0/8' : 'example.com'}
                      onChange={event => patch(index, { hostValue: event.target.value })}
                      spellCheck={false}
                    />
                  </Field>
                )}
              </>
            )}
            {selectTarget(tr('出站方式'), rule.target, target => patch(index, { target }))}
            <small className="fine-print break-all">{compileRule(rule, '…')}</small>
          </div>)}
        </section>
        <Button type="button" variant="outline" onClick={() => {
          try { setPreview(check()) }
          catch (failure) { showMessage({ type: 'error', title: errorText(failure) }) }
        }}><GitBranch data-icon="inline-start" />{tr("预览生效规则")}</Button>
        {preview && <pre className="effective-preview whitespace-pre-wrap break-all">{preview.join('\n')}</pre>}
      </fieldset>
    </main>
    <footer className="page-action settings-footer">
      <Button type="button" variant="outline" disabled={busy} onClick={() => { change(defaultRouting); showMessage({ type: 'info', title: tr('已恢复默认规则，点击保存后生效') }) }}>{tr("恢复默认")}</Button>
      <Button type="submit" variant="default" className="flex-1" disabled={busy}><Save data-icon="inline-start" />{tr("保存规则")}</Button>
    </footer>
  </form>
}

export function ConfigSettings({ library, busy, save }: {
  library: Library; busy: boolean; save: (patch: ReturnType<typeof parseSettings>) => void
}) {
  const text = configSource(library.network, library.routing, library.monitoring)
  const [draft, setDraft] = useState(text)
  const [revision, setRevision] = useState(0)
  const [errors, setErrors] = useState(0)
  const [cursor, setCursor] = useState([1, 1])
  const editor = useRef<{ checkForSave: () => string | undefined }>(null)
  const search = useEditorSearch(draft, { enableShortcut: true, resetKey: revision })
  return <>
    <main className="page-scroll yaml-page">
      <div className="section-title">
        <strong>{tr("Air 配置 YAML")}</strong>
        <div className="flex shrink-0 items-center gap-1.5">
          <Tag tone={errors ? 'red' : 'gray'}>{errors ? tr("{0} 处语法错误", errors) : tr("第 {0} 行，第 {1} 列", cursor[0], cursor[1])}</Tag>
          <Button type="button" size="icon-sm" variant={search.open ? 'subtle' : 'outline'} aria-label={tr('查找配置内容')} aria-pressed={search.open} onClick={search.toggleSearch}>
            <Search />
          </Button>
        </div>
      </div>
      <EditorSearchBar {...search.barProps} compact />
      <Suspense fallback={<div className="air-config-editor min-h-0 flex-1" aria-busy="true" />}>
        <ConfigCodeEditor key={revision} ref={editor} initialText={draft} search={search.searchState} onEdit={setDraft}
          onSyntaxCount={setErrors} onCursor={(line, column) => setCursor([line, column])} />
      </Suspense>
    </main>
    <footer className="page-action settings-footer">
      <Button type="button" variant="outline" disabled={busy} onClick={() => {
        setDraft(text); setRevision(value => value + 1); setErrors(0)
        showMessage({ type: 'success', title: tr('配置已重新读取') })
      }}><RefreshCw data-icon="inline-start" />{tr("重新读取")}</Button>
      <Button type="button" variant="default" className="flex-1" disabled={busy || draft === text} onClick={() => {
        try {
          const syntax = editor.current?.checkForSave()
          if (syntax) throw new Error(syntax)
          save(parseSettings(draft))
        } catch (failure) { showMessage({ type: 'error', title: errorText(failure) }) }
      }}><Save data-icon="inline-start" />{tr("保存")}</Button>
    </footer>
  </>
}

export interface KernelInfo { version: string; appVersion: string; sdk: number; abi: string }
export interface UpdateCheck { current: string; version?: string; url?: string }

export function KernelSettings({ info, active, check }: { info: KernelInfo; active: boolean; check: () => Promise<void> }) {
  const [checking, setChecking] = useState(false)
  return <main className="page-scroll">
    <section className="panel settings-form">
      <div className="section-title"><h2 className="settings-form-title">Mihomo {info.version}</h2><Tag tone={active ? 'green' : 'gray'}>{active ? tr('运行中') : tr('内置内核')}</Tag></div>
      <p className="fine-print">{info.abi} · Android API {info.sdk}</p>
      <Button variant="outline" disabled={checking} onClick={async () => {
        setChecking(true)
        try {
          await check()
          showMessage({ type: 'success', title: tr('内核载入成功，当前配置校验通过') })
        } catch (failure) {
          showMessage({ type: 'error', title: errorText(failure) })
        } finally {
          setChecking(false)
        }
      }}><Activity data-icon="inline-start" className={checking ? 'motion-safe:animate-pulse' : undefined} />{checking ? tr('正在检测…') : tr('检测内核')}</Button>
    </section>
  </main>
}

export function AboutSettings({ info }: { info: KernelInfo }) {
  const [checking, setChecking] = useState(false)
  const [status, setStatus] = useState('')
  const [update, setUpdate] = useState<UpdateCheck>()
  function open(url: string) {
    if (!onAndroid) {
      window.open(url, '_blank', 'noopener,noreferrer')
      return
    }
    void native('openLink', { url }).catch(failure => showMessage({ type: 'error', title: errorText(failure) }))
  }
  useEffect(() => { setStatus('') }, [info.appVersion])
  return <main className="page-scroll">
    <section className="panel about">
      <div className="about-head">
        <img src={logo} alt="" />
        <div className="about-meta">
          <div className="about-title">
            <strong>Air Proxy</strong>
            <Tag tone="gray">v{info.appVersion}</Tag>
          </div>
          <span>{[`Mihomo ${info.version}`, info.abi, `Android API ${info.sdk}`].filter(Boolean).join(' · ')}</span>
        </div>
        <Button type="button" variant="outline" size="icon-sm" className="shrink-0" aria-label={tr("作者的 GitHub 主页")} title="GuoWWWX · GitHub"
          onClick={() => open('https://github.com/GuoWWWX')}>
          <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
            <path d="M8 0C3.58 0 0 3.58 0 8a8.01 8.01 0 0 0 5.47 7.59c.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.65 7.65 0 0 1 2-.27c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
          </svg>
        </Button>
      </div>
      <p className="about-desc">{tr("Air 是一个基于 Mihomo 的 Android 代理客户端，支持管理订阅与节点、配置分流规则与多跳链路，并查看延迟和实时连接。")}</p>
    </section>
    <section className="panel settings-form">
      <h2 className="settings-form-title">{tr("软件更新")}</h2>
      <p className="fine-print" role="status">{status || tr('查找 GitHub 上发布的 Android 安装包。')}</p>
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" disabled={checking} onClick={async () => {
          setChecking(true)
          try {
            const available = await native<UpdateCheck>('checkUpdate')
            setUpdate(available)
            const msg = available.version ? tr('发现新版本 Air Proxy ') + available.version : tr('当前已是最新版本')
            setStatus(msg)
            showMessage({ type: available.version ? 'info' : 'success', title: msg })
          } catch (failure) {
            showMessage({ type: 'error', title: errorText(failure) })
          } finally {
            setChecking(false)
          }
        }}><RefreshCw data-icon="inline-start" className={checking ? 'motion-safe:animate-spin' : undefined} />
          {checking ? tr('正在检查更新…') : tr('检查更新')}
        </Button>
        {update?.url && <Button variant="default" onClick={() => open(update.url!)}>{tr("查看更新")}</Button>}
      </div>
    </section>
  </main>
}

function errorText(error: unknown) { return error instanceof Error ? error.message : String(error) }
