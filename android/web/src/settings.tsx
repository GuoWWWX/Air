import { Sheet } from './ui'
import { RuleLibraryManager, readRuleProfile } from '@/shared/ui/RuleLibraryManager'
import { downloadSubscription } from '@/shared/proxy/subscription-extension'
import { GlobalRuleList, type AppIdentity } from '@/shared/ui/GlobalRuleList'
import { LanguagePicker } from '@/shared/i18n/LanguagePicker'
import { diagnostic, savePreviewLanguage, tr, useLanguage } from '@/shared/i18n/messages'
import { selectLocalizedNotes } from '@/shared/i18n/releaseNotes'
import { formatBytes, formatRate } from '@/shared/lib/utils'
import { lazy, Suspense, type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react'

let savedSettingsScrollTop = 0
import { Activity, ArrowDown, ArrowDownToLine, ArrowUp, Check, FileCode2, GitBranch, Globe, Info, Monitor, Moon, Network, Palette, Pause, Play, Plug, Plus, RefreshCw, Save, Search, Settings, Sun, Trash2, Waypoints } from 'lucide-react'
import { LayoutGroup, motion } from 'motion/react'
import { AirSelect } from '@/shared/ui/AirSelect'
import { Button } from '@/shared/ui/button'
import { EditorSearchBar, useEditorSearch } from '@/shared/ui/EditorSearchBar'
import { Input } from '@/shared/ui/input'
import { showMessage } from '@/shared/ui/message'
import logo from '@/assets/air-m1.svg'
import { native, onAndroid } from './bridge'
import { compileRule, configSource, defaultRouting, parseSettings, ruleMatchers, validateRouting, type HostMatcher, type MobileRouting, type RouteRule, type RouteTarget } from './configuration'
import { compile, resolvedRuleSet, selection, selectionName, type Library, type Theme } from './model'
import { SettingSwitch, type NetworkPage } from './network-settings'
import { Row, Tag } from './ui'
import { Field } from './workflows'
import type { Model } from './views'

const ConfigCodeEditor = lazy(() => import('@/shared/ui/ConfigCodeEditor').then(module => ({ default: module.ConfigCodeEditor })))
const ReleaseNotes = lazy(() => import('@/shared/ui/ReleaseNotes'))

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
  { page: 'configFile', icon: FileCode2, get description() { return tr('编辑和校验 Air Proxy 的 YAML 配置') } },
] as const

export function SettingsIndex({ library, open, update }: {
  library: Library; open: (page: SettingsPage) => void; update?: AndroidUpdateState
}) {
  const scrollRef = useRef<HTMLElement>(null)
  const hasVisibleUpdate = Boolean(
    update?.version && !update.ignored && update.phase !== 'idle' && update.phase !== 'current',
  )

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
      <Row
        icon={Info}
        title={settingsTitles.about}
        description={tr("Air Proxy 版本、软件更新与作者 GitHub")}
        badge={hasVisibleUpdate && update?.version ? (
          <span className="inline-flex items-center gap-1">
            <span className="settings-update-dot" aria-hidden="true" />
            <Tag tone="blue">
              {update.phase === 'ready'
                ? tr('待安装')
                : update.phase === 'paused'
                  ? tr('已暂停')
                  : `v${update.version}`}
            </Tag>
          </span>
        ) : undefined}
        onClick={() => open('about')}
      />
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

const sheetOverlay = (title: string, close: () => void, content: ReactNode) => (
  <Sheet open title={title} close={close}><div className="sheet-form">{content}</div></Sheet>
)

export function RoutingSettings({ library, model, busy, sdk, save, apps }: {
  library: Library; model: Model; busy: boolean; sdk: number; apps: AppIdentity[]; save: (routing: MobileRouting) => Promise<boolean>
}) {
  const [draft, setDraft] = useState(library.routing)
  const [preview, setPreview] = useState<string[]>()
  const [resolvedApps, setResolvedApps] = useState<Record<string, AppIdentity>>({})
  const [queriedPkg, setQueriedPkg] = useState('')
  const requestedPkgsRef = useRef(new Set<string>())
  const mountedRef = useRef(true)
  useEffect(() => () => { mountedRef.current = false }, [])
  const pkgQueries = [...new Set([
    ...draft.rules.filter(rule => rule.matcher === 'processName').map(rule => rule.value.trim()),
    queriedPkg.trim(),
  ].filter(Boolean))].sort().join('\n')
  useEffect(() => {
    if (!onAndroid || !pkgQueries) return
    const missing = pkgQueries.split('\n').filter(pkg => !requestedPkgsRef.current.has(pkg))
    if (!missing.length) return
    for (const pkg of missing) requestedPkgsRef.current.add(pkg)
    void native<Record<string, { name: string; icon?: string }>>('applications', { packages: missing })
      .then(result => {
        if (!mountedRef.current || !result) return
        const entries = Object.entries(result)
        if (!entries.length) return
        setResolvedApps(prev => {
          const next = { ...prev }
          for (const [pkg, info] of entries) {
            if (info?.name) next[pkg] = { executable: pkg, name: info.name, icon: info.icon }
          }
          return next
        })
      })
      .catch(() => {
        for (const pkg of missing) requestedPkgsRef.current.delete(pkg)
      })
  }, [pkgQueries])
  const sourceNames = new Map(library.sources.map(source => [source.id, source.name]))
  const reference = resolvedRuleSet({ ...library, routing: draft }, model)
  const sourceName = reference.startsWith('subscription:') ? sourceNames.get(reference.slice(13))
    : draft.ruleLibrary?.sets.find(set => 'user:' + set.id === reference)?.name
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
          <div className="field"><span>{tr("当前生效规则集")}</span><strong>{selectionName(selection(library,model),model,library) ?? tr('无')} → {sourceName ?? tr('无')}</strong></div>
          <RuleLibraryManager catalog={draft.ruleLibrary} overlay={sheetOverlay}
            sources={library.sources.map(s => ({ id: s.id, name: s.name, updated: s.updated,
              read: async () => readRuleProfile(model.profiles.get(s.id)?.profile) }))}
            owners={Object.fromEntries([...library.sources.map(s => ['subscription:' + s.id, s.name]),
              ...model.nodes.map(n => ['node:' + n.id, n.config.name]), ...library.groups.map(g => ['group:' + g.id, g.name]),
              ...library.chains.map(c => ['chain:' + c.id, c.name])])}
            save={async ruleLibrary => { const next = { ...draft, ruleLibrary }; if (!await save(next)) return false; change(next); return true }}
            importYaml={onAndroid ? async () => (await native<{ text?: string } | null>('file', { type: 'yaml' }))?.text ?? null : undefined}
            exportYaml={(name, text) => onAndroid ? native('export', { name: name + '.yaml', text }) : downloadSubscription(name, text)} />
          {selectTarget(tr('默认出口'), draft.fallback, fallback => change({ ...draft, fallback }))}
        </section>
        <section className="panel settings-form">
          <GlobalRuleList<RouteRule> android rules={draft.rules} apps={[...Object.values(resolvedApps), ...apps]}
            onInspectApp={setQueriedPkg}
            matchers={ruleMatchers.map(item => ({ ...item, disabled: item.value === 'processName' && sdk < 29 }))}
            targets={targets} newRule={() => ({ enabled: true, matcher: 'domainSuffix', value: '', target: { kind: 'direct' } })}
            overlay={sheetOverlay}
            save={async rules => {
              const next = { ...draft, rules }
              validateRouting(next)
              if (!await save(next)) return false
              change(next)
              return true
            }} />
        </section>
        <Button type="button" variant="outline" onClick={() => {
          try { setPreview(check()) }
          catch (failure) { showMessage({ type: 'error', title: errorText(failure) }) }
        }}><GitBranch data-icon="inline-start" />{tr("预览生效规则")}</Button>
        {preview && <pre className="effective-preview whitespace-pre-wrap break-all">{tr('全局规则 → 基础网络保障 → {0} → 默认出口', sourceName ?? tr('国内直连兜底')) + '\n\n' + preview.join('\n')}</pre>}
      </fieldset>
    </main>
    <footer className="page-action settings-footer">
      <Button type="button" variant="outline" disabled={busy} onClick={() => { change({ ...defaultRouting, ruleLibrary: draft.ruleLibrary }); showMessage({ type: 'info', title: tr('已恢复默认规则，点击保存后生效') }) }}>{tr("恢复默认")}</Button>
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
        <strong>{tr("Air Proxy 配置 YAML")}</strong>
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
export type AndroidUpdatePhase =
  | 'idle'
  | 'checking'
  | 'current'
  | 'available'
  | 'preparing'
  | 'downloading'
  | 'paused'
  | 'ready'
  | 'installing'
  | 'interrupted'

export interface AndroidUpdateProgress {
  received: number
  total: number
  speed: number
  reused: number
  apkSize: number
}

export interface AndroidUpdateState {
  current: string
  phase: AndroidUpdatePhase
  version?: string | null
  notes?: string | null
  releaseUrl?: string | null
  url?: string | null
  downloadUrl?: string | null
  assetName?: string | null
  message?: string | null
  ignored: boolean
  progress: AndroidUpdateProgress
}

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

const GitHubMark = () => (
  <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
    <path d="M8 0C3.58 0 0 3.58 0 8a8.01 8.01 0 0 0 5.47 7.59c.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.65 7.65 0 0 1 2-.27c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
  </svg>
)

export function AndroidUpdatePanel({
  update,
  onOpenLink,
  onStart,
  onPause,
  onCancel,
  onIgnore,
  onInstall,
  onDismiss,
  notesMaxHeightClass = 'max-h-36',
  inSheet = false,
}: {
  update: AndroidUpdateState
  onOpenLink: (url: string) => void
  onStart: () => void
  onPause: () => void
  onCancel: () => void
  onIgnore: () => void
  onInstall: () => void
  onDismiss?: () => void
  notesMaxHeightClass?: string
  inSheet?: boolean
}) {
  const lang = useLanguage()
  if (!update.version) return null
  const { received, total, speed, reused } = update.progress
  const preparing = update.phase === 'preparing'
  const downloading = update.phase === 'downloading'
  const busy = preparing || downloading
  const paused = update.phase === 'paused'
  const ready = update.phase === 'ready'
  const installing = update.phase === 'installing'
  const interrupted = update.phase === 'interrupted'
  const showProgress = busy || paused || ready || installing || (interrupted && received > 0)
  const percent = total > 0 ? Math.min(100, Math.floor((received / total) * 100)) : 0
  const localizedNotes = update.notes ? selectLocalizedNotes(update.notes, lang.code) : ''
  const fallbackUrl = update.downloadUrl ?? update.releaseUrl ?? update.url ?? undefined

  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-1.5 min-w-0">
          <Tag tone="blue">v{update.version}</Tag>
          {reused > 0 && (
            <Tag tone="green">{tr('增量更新 · 已复用 {0}', formatBytes(reused))}</Tag>
          )}
          {update.ignored && update.phase === 'available' && (
            <Tag tone="gray">{tr('已忽略此版本')}</Tag>
          )}
        </div>
        {fallbackUrl && (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="shrink-0 text-muted-foreground"
            aria-label={tr('前往 GitHub 手动下载')}
            title={tr('前往 GitHub 手动下载')}
            onClick={() => onOpenLink(fallbackUrl)}
          >
            <GitHubMark />
          </Button>
        )}
      </div>

      {localizedNotes && (
        <div className={`${notesMaxHeightClass} overflow-y-auto rounded-[8px] border border-border bg-muted/40 p-2.5`}>
          {inSheet && <h3 className="mb-1 text-[11px] font-semibold text-muted-foreground">{tr('更新内容')}</h3>}
          <Suspense fallback={<p className="text-xs text-muted-foreground">{tr('正在加载更新说明…')}</p>}>
            <ReleaseNotes notes={localizedNotes} compact onOpenLink={onOpenLink} />
          </Suspense>
        </div>
      )}

      {showProgress && (
        <div className="mobile-update-progress" aria-label={tr('更新下载进度')}>
          <div className="mobile-update-progress-head">
            <span>
              {installing
                ? tr('正在拉起系统安装…')
                : ready
                  ? tr('已准备就绪')
                  : paused
                    ? tr('已暂停')
                    : preparing
                      ? tr('正在准备更新')
                      : interrupted
                        ? tr('下载中断')
                        : tr('正在下载更新')}
            </span>
            {total > 0 && <strong className="font-mono">{percent}%</strong>}
          </div>
          <div className="mobile-update-bar" role="progressbar" aria-valuemin={0} aria-valuemax={total || 100} aria-valuenow={total > 0 ? received : undefined}>
            <div
              className="mobile-update-bar-fill"
              data-indeterminate={total <= 0 ? 'true' : undefined}
              style={total > 0 ? { width: `${percent}%` } : undefined}
            />
          </div>
          <div className="mobile-update-progress-meta">
            <span>{total > 0 ? `${formatBytes(received)} / ${formatBytes(total)}` : tr('正在计算下载大小')}</span>
            <span>{downloading && speed > 0 ? formatRate(speed) : '—'}</span>
          </div>
        </div>
      )}

      {update.message && (
        <p role={interrupted ? 'alert' : 'status'} className={interrupted ? 'fine-print font-medium text-destructive' : 'fine-print'}>
          {diagnostic(update.message)}
        </p>
      )}

      {(() => {
        const primary = busy ? (
          <Button type="button" variant="default" disabled={!onAndroid} onClick={onPause}>
            <Pause data-icon="inline-start" />{tr('暂停')}
          </Button>
        ) : paused ? (
          <Button type="button" variant="default" disabled={!onAndroid} onClick={onStart}>
            <Play data-icon="inline-start" />{tr('继续下载')}
          </Button>
        ) : ready || installing ? (
          <Button type="button" variant="default" disabled={!onAndroid || installing} onClick={onInstall}>
            <ArrowDownToLine data-icon="inline-start" />
            {installing ? tr('正在拉起系统安装…') : tr('立即安装')}
          </Button>
        ) : interrupted ? (
          <Button type="button" variant="default" disabled={!onAndroid} onClick={onStart}>
            <RefreshCw data-icon="inline-start" />{tr('重试更新')}
          </Button>
        ) : (
          <Button type="button" variant="default" disabled={!onAndroid} onClick={onStart}>
            <ArrowDownToLine data-icon="inline-start" />{tr('立即更新')}
          </Button>
        )

        const secondary = busy || paused || ready || installing || interrupted ? (
          <Button type="button" variant="outline" disabled={!onAndroid || installing} onClick={onCancel}>
            {tr('取消')}
          </Button>
        ) : !update.ignored ? (
          <Button type="button" variant="outline" disabled={!onAndroid} onClick={onIgnore}>
            {tr('忽略此版本')}
          </Button>
        ) : null

        if (inSheet) {
          return (
            <div className="sheet-actions">
              {onDismiss && (
                <Button type="button" variant="ghost" className="mr-auto" disabled={installing} onClick={onDismiss}>
                  {tr('稍后')}
                </Button>
              )}
              <div className="ml-auto flex items-center gap-2">
                {secondary}
                {primary}
              </div>
            </div>
          )
        }

        return (
          <div className="flex flex-wrap items-center gap-2">
            {primary}
            {secondary}
          </div>
        )
      })()}
    </div>
  )
}

export function AboutSettings({
  info,
  update,
  onCheckUpdate,
  onStartUpdate,
  onPauseUpdate,
  onCancelUpdate,
  onIgnoreUpdate,
  onInstallUpdate,
}: {
  info: KernelInfo
  update: AndroidUpdateState
  onCheckUpdate: () => Promise<AndroidUpdateState | undefined>
  onStartUpdate: () => void
  onPauseUpdate: () => void
  onCancelUpdate: () => void
  onIgnoreUpdate: () => void
  onInstallUpdate: () => void
}) {
  const [checking, setChecking] = useState(false)
  function open(url: string) {
    if (!onAndroid) {
      window.open(url, '_blank', 'noopener,noreferrer')
      return
    }
    void native('openLink', { url }).catch(failure => showMessage({ type: 'error', title: errorText(failure) }))
  }
  const checkBusy = checking || update.phase === 'checking'
  const activeTransfer =
    update.phase === 'preparing' || update.phase === 'downloading' || update.phase === 'installing'
  const statusText = update.version
    ? `${tr('发现新版本 Air Proxy ')}${update.version}`
    : update.phase === 'current'
      ? tr('当前已是最新版本')
      : tr('查找并应用 GitHub 上的最新 Android 更新。')

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
          <GitHubMark />
        </Button>
      </div>
      <p className="about-desc">{tr("Air Proxy 是一个基于 Mihomo 的 Android 代理客户端，支持管理订阅与节点、配置分流规则与多跳链路，并查看延迟和实时连接。")}</p>
    </section>
    <section className="panel settings-form">
      <h2 className="settings-form-title">{tr("软件更新")}</h2>
      <p className="fine-print" role="status">{statusText}</p>
      {update.version ? (
        <AndroidUpdatePanel
          update={update}
          onOpenLink={open}
          onStart={onStartUpdate}
          onPause={onPauseUpdate}
          onCancel={onCancelUpdate}
          onIgnore={onIgnoreUpdate}
          onInstall={onInstallUpdate}
        />
      ) : (
        update.message && (
          <p role={update.phase === 'interrupted' ? 'alert' : 'status'} className={update.phase === 'interrupted' ? 'fine-print font-medium text-destructive' : 'fine-print'}>
            {diagnostic(update.message)}
          </p>
        )
      )}
      {!activeTransfer && (
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" disabled={checkBusy} onClick={async () => {
            setChecking(true)
            try {
              const next = await onCheckUpdate()
              if (next?.phase === 'interrupted') {
                showMessage({ type: 'error', title: diagnostic(next.message || tr('当前已是最新版本')) })
              } else {
                const msg = next?.version ? tr('发现新版本 Air Proxy ') + next.version : tr('当前已是最新版本')
                showMessage({ type: next?.version ? 'info' : 'success', title: msg })
              }
            } finally {
              setChecking(false)
            }
          }}>
            <RefreshCw data-icon="inline-start" className={checkBusy ? 'motion-safe:animate-spin' : undefined} />
            {checkBusy ? tr('正在检查更新…') : tr('检查更新')}
          </Button>
        </div>
      )}
    </section>
  </main>
}

function errorText(error: unknown) { return error instanceof Error ? error.message : String(error) }
