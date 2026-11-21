import { useEffect, useRef, useState } from 'react'
import { Activity, ArrowDown, ArrowUp, Check, ExternalLink, FileCode2, GitBranch, Globe, Info, Monitor, Moon, Network, Palette, Plug, Plus, RefreshCw, Save, Settings, Sun, Trash2, Waypoints } from 'lucide-react'
import { LayoutGroup, motion } from 'motion/react'
import { AirSelect } from '@/shared/ui/AirSelect'
import { Button } from '@/shared/ui/button'
import { Input } from '@/shared/ui/input'
import { showMessage } from '@/shared/ui/message'
import { ConfigCodeEditor } from '@/shared/ui/ConfigCodeEditor'
import logo from '@/assets/air-m1.svg'
import { native } from './bridge'
import { compileRule, configSource, defaultRouting, parseSettings, ruleMatchers, validateRouting, type MobileRouting, type RouteRule, type RouteTarget } from './configuration'
import { compile, type Library, type Theme } from './model'
import { SettingSwitch, type NetworkPage } from './network-settings'
import { Row, Tag } from './ui'
import { Field } from './workflows'
import type { Model } from './views'

export type SettingsPage = 'theme' | NetworkPage | 'routing' | 'kernel' | 'configFile' | 'about'
export const themeNames: Record<Theme, string> = { system: '跟随系统', light: '浅色', dark: '深色' }
export const settingsTitles: Record<SettingsPage, string> = {
  theme: '主题', dns: 'DNS 设置', tun: '虚拟网卡（TUN）', inbound: '代理接入', routing: '分流规则',
  kernel: '诊断内核', configFile: '配置文件', monitoring: '后台监测', about: '关于',
}
const settingsRows = [
  { page: 'dns', icon: Globe, description: '主 DNS、加密解析、分域 DNS 与 Fake-IP' },
  { page: 'tun', icon: Network, description: '协议栈、MTU、DNS 接管与绕过网段' },
  { page: 'inbound', icon: Plug, description: '本地端口、局域网共享与 IPv6' },
  { page: 'routing', icon: Waypoints, description: '按域名、IP 网段或应用包名选择出站' },
  { page: 'kernel', icon: Settings, description: '检查 Android 内置 Mihomo 内核' },
  { page: 'configFile', icon: FileCode2, description: '编辑和校验 Air 的 YAML 配置' },
] as const

export function SettingsIndex({ library, open }: { library: Library; open: (page: SettingsPage) => void }) {
  return <main className="page-scroll settings">
    <section><h2>外观</h2><div className="panel settings-panel">
      <Row icon={Palette} title={settingsTitles.theme} description="选择浅色、深色或跟随系统外观"
        value={themeNames[library.theme]} onClick={() => open('theme')} />
    </div></section>
    <section><h2>代理配置</h2><div className="panel settings-panel">
      {settingsRows.map(({ page, icon, description }) =>
        <Row key={page} icon={icon} title={settingsTitles[page]} description={description} onClick={() => open(page)} />)}
    </div></section>
    <section><h2>监测</h2><div className="panel settings-panel">
      <Row icon={Activity} title={settingsTitles.monitoring} description="自动刷新节点可用率和延迟"
        value={library.monitoring ? '已开启' : '已关闭'} onClick={() => open('monitoring')} />
    </div></section>
    <div className="panel settings-panel">
      <Row icon={Info} title={settingsTitles.about} description="Air 版本、软件更新与作者 GitHub" onClick={() => open('about')} />
    </div>
  </main>
}

const themeIcons = { system: Monitor, light: Sun, dark: Moon }
export function ThemeSettings({ value, onChange }: { value: Theme; onChange: (theme: Theme) => void }) {
  return <main className="page-scroll">
    <div className="theme-options" role="group" aria-label="主题模式">
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
  const targets: { target: RouteTarget; label: string; disabled?: boolean }[] = [
    { target: { kind: 'selected' }, label: '当前所选出口' },
    { target: { kind: 'direct' }, label: '直连' },
    { target: { kind: 'reject' }, label: '拒绝连接' },
    { target: { kind: 'subscription' }, label: '沿用订阅默认出口', disabled: !draft.subscriptionId },
    ...model.groups.map(group => ({ target: { kind: 'group' as const, id: group.id }, label: group.name })),
    ...library.chains.map(chain => ({ target: { kind: 'chain' as const, id: chain.id }, label: '链式出口 · ' + chain.name })),
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
    if (choices.some(target => 'id' in target && !compiled.byId.has(target.id))) throw new Error('有规则指向不可用的分组或链路')
    if (choices.some(target => target.kind === 'subscription') && !model.profiles.has(draft.subscriptionId ?? '')) {
      throw new Error('请选择可用的订阅规则来源')
    }
    if (sdk < 29 && draft.rules.some(rule => rule.enabled && rule.matcher === 'processName')) throw new Error('按应用包名分流需要 Android 10 或更新版本')
    return compiled.plan.config.rules
  }
  function selectTarget(label: string, value: RouteTarget, onChange: (value: RouteTarget) => void) {
    const options = targets.map(({ target, label, disabled }) => ({ value: targetKey(target), label, disabled }))
    if (!options.some(option => option.value === targetKey(value))) {
      options.push({ value: targetKey(value), label: '出站已不可用', disabled: true })
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
          <h2 className="settings-form-title">订阅规则与默认出口</h2>
          <div className="field"><span>订阅规则来源</span><AirSelect label="订阅规则来源" value={draft.subscriptionId ?? 'none'}
            onChange={value => change({ ...draft, subscriptionId: value === 'none' ? null : value })}
            options={[{ value: 'none', label: '无' }, ...library.sources.map(source => ({ value: source.id, label: source.name }))]} /></div>
          {selectTarget('默认出口', draft.fallback, fallback => change({ ...draft, fallback }))}
          <SettingSwitch label="在自定义规则之后匹配该订阅的规则" value={draft.inheritRules}
            onChange={inheritRules => change({ ...draft, inheritRules })} />
        </section>
        <section className="panel settings-form">
          <div className="section-title"><h2 className="settings-form-title">自定义规则</h2>
            <Button type="button" size="sm" variant="outline" onClick={() => change({ ...draft, rules: [
              ...draft.rules, { enabled: true, matcher: 'domainSuffix', value: '', target: { kind: 'direct' } },
            ] })}><Plus data-icon="inline-start" />添加规则</Button>
          </div>
          <p className="fine-print">从上到下匹配，先匹配的规则优先。</p>
          {draft.rules.map((rule, index) => <div className="settings-rule" key={index}>
            <div className="flex items-center justify-between gap-1">
              <SettingSwitch label={'规则 ' + (index + 1)} value={rule.enabled} onChange={enabled => patch(index, { enabled })} />
              <div className="flex items-center gap-0.5">
                <Button type="button" size="icon-sm" variant="ghost" aria-label="上移" disabled={!index} onClick={() => reorder(index, index - 1)}><ArrowUp /></Button>
                <Button type="button" size="icon-sm" variant="ghost" aria-label="下移" disabled={index === draft.rules.length - 1} onClick={() => reorder(index, index + 1)}><ArrowDown /></Button>
                <Button type="button" size="icon-sm" variant="ghost" aria-label="删除规则"
                  onClick={() => change({ ...draft, rules: draft.rules.filter((_, i) => i !== index) })}><Trash2 /></Button>
              </div>
            </div>
            <div className="field"><span>匹配方式</span><AirSelect label="匹配方式" value={rule.matcher}
              options={ruleMatchers.map(option => ({ ...option, disabled: option.value === 'processName' && sdk < 29 }))}
              onChange={matcher => patch(index, { matcher, value: '' })} /></div>
            <Field label="匹配值"><Input value={rule.value} placeholder={ruleMatchers.find(option => option.value === rule.matcher)?.example}
              onChange={event => patch(index, { value: event.target.value })} spellCheck={false} /></Field>
            {selectTarget('出站方式', rule.target, target => patch(index, { target }))}
            <small className="fine-print">{compileRule(rule, '…')}</small>
          </div>)}
        </section>
        <Button type="button" variant="outline" onClick={() => {
          try { setPreview(check()); showMessage({ type: 'success', title: '规则预览已生成' }) }
          catch (failure) { showMessage({ type: 'error', title: errorText(failure) }) }
        }}><GitBranch data-icon="inline-start" />预览生效规则</Button>
        {preview && <pre className="effective-preview whitespace-pre-wrap break-all">{preview.join('\n')}</pre>}
      </fieldset>
    </main>
    <footer className="page-action settings-footer">
      <Button type="button" variant="outline" disabled={busy} onClick={() => { change(defaultRouting); showMessage({ type: 'info', title: '已恢复默认规则，点击保存后生效' }) }}>恢复默认</Button>
      <Button type="submit" className="flex-1" disabled={busy}><Save data-icon="inline-start" />保存规则</Button>
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
  return <>
    <main className="page-scroll yaml-page">
      <div className="section-title"><strong>Air 配置 YAML</strong><Tag tone={errors ? 'red' : 'gray'}>{errors ? `${errors} 处语法错误` : `第 ${cursor[0]} 行，第 ${cursor[1]} 列`}</Tag></div>
      <ConfigCodeEditor key={revision} ref={editor} initialText={draft} onEdit={setDraft}
        onSyntaxCount={setErrors} onCursor={(line, column) => setCursor([line, column])} />
    </main>
    <footer className="page-action settings-footer">
      <Button type="button" variant="outline" disabled={busy} onClick={() => {
        setDraft(text); setRevision(value => value + 1); setErrors(0)
        showMessage({ type: 'success', title: '配置已重新读取' })
      }}><RefreshCw data-icon="inline-start" />重新读取</Button>
      <Button type="button" className="flex-1" disabled={busy || draft === text} onClick={() => {
        try {
          const syntax = editor.current?.checkForSave()
          if (syntax) throw new Error(syntax)
          save(parseSettings(draft))
        } catch (failure) { showMessage({ type: 'error', title: errorText(failure) }) }
      }}><Save data-icon="inline-start" />保存</Button>
    </footer>
  </>
}

export interface KernelInfo { version: string; appVersion: string; sdk: number; abi: string }
export interface UpdateCheck { current: string; version?: string; url?: string }

export function KernelSettings({ info, active, check }: { info: KernelInfo; active: boolean; check: () => Promise<void> }) {
  const [checking, setChecking] = useState(false)
  return <main className="page-scroll">
    <section className="panel settings-form">
      <div className="section-title"><h2 className="settings-form-title">Mihomo {info.version}</h2><Tag tone={active ? 'green' : 'gray'}>{active ? '运行中' : '内置内核'}</Tag></div>
      <p className="fine-print">{info.abi} · Android API {info.sdk}</p>
      <Button variant="outline" disabled={checking} onClick={async () => {
        setChecking(true)
        try {
          await check()
          showMessage({ type: 'success', title: '内核载入成功，当前配置校验通过' })
        } catch (failure) {
          showMessage({ type: 'error', title: errorText(failure) })
        } finally {
          setChecking(false)
        }
      }}><Activity data-icon="inline-start" className={checking ? 'motion-safe:animate-pulse' : undefined} />{checking ? '正在检测…' : '检测内核'}</Button>
    </section>
  </main>
}

export function AboutSettings({ info }: { info: KernelInfo }) {
  const [checking, setChecking] = useState(false)
  const [status, setStatus] = useState('')
  const [update, setUpdate] = useState<UpdateCheck>()
  function open(url: string) {
    void native('openLink', { url }).catch(failure => showMessage({ type: 'error', title: errorText(failure) }))
  }
  useEffect(() => { setStatus('') }, [info.appVersion])
  return <main className="page-scroll">
    <section className="panel about">
      <img src={logo} alt="" />
      <div><strong>Air</strong><span>Android · {info.appVersion}</span></div>
      <Button type="button" variant="outline" size="icon" aria-label="作者的 GitHub 主页" onClick={() => open('https://github.com/GuoWWWX')}><ExternalLink /></Button>
    </section>
    <section className="panel settings-form">
      <h2 className="settings-form-title">软件更新</h2>
      <p className="fine-print" role="status">{status || '查找 GitHub 上发布的 Android 安装包。'}</p>
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" disabled={checking} onClick={async () => {
          setChecking(true)
          try {
            const available = await native<UpdateCheck>('checkUpdate')
            setUpdate(available)
            const msg = available.version ? '发现新版本 Air ' + available.version : '当前已是最新版本'
            setStatus(msg)
            showMessage({ type: available.version ? 'info' : 'success', title: msg })
          } catch (failure) {
            showMessage({ type: 'error', title: errorText(failure) })
          } finally {
            setChecking(false)
          }
        }}><RefreshCw data-icon="inline-start" className={checking ? 'motion-safe:animate-spin' : undefined} />
          {checking ? '正在检查更新…' : '检查更新'}
        </Button>
        {update?.url && <Button onClick={() => open(update.url!)}>查看更新</Button>}
      </div>
    </section>
  </main>
}

function errorText(error: unknown) { return error instanceof Error ? error.message : String(error) }
