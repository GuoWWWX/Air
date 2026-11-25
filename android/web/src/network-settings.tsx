import { tr } from '@/shared/i18n/messages'
import { useState, type ReactNode } from 'react'
import { ChevronDown, Plus, RefreshCw, Save, Trash2 } from 'lucide-react'
import { formatDateTime } from '@/shared/lib/utils'
import { AirSelect } from '@/shared/ui/AirSelect'
import { Button } from '@/shared/ui/button'
import { Input } from '@/shared/ui/input'
import { showMessage } from '@/shared/ui/message'
import { Switch } from '@/shared/ui/switch'
import { Textarea } from '@/shared/ui/textarea'
import { native } from './bridge'
import { defaultMobileNetwork, validateNetwork, type MobileNetwork } from './configuration'
import { compile, yamlProfile, type Library } from './model'
import { Field } from './workflows'

export type NetworkPage = 'dns' | 'tun' | 'inbound' | 'monitoring'
type ListKey = { [K in keyof MobileNetwork]: MobileNetwork[K] extends string[] ? K : never }[keyof MobileNetwork]
type FlagKey = { [K in keyof MobileNetwork]: MobileNetwork[K] extends boolean ? K : never }[keyof MobileNetwork]

const pageFields = {
  dns: ['nameserver', 'defaultNameserver', 'directNameserver', 'proxyServerNameserver', 'fallback', 'fallbackDomains',
    'domainDns', 'enhancedMode', 'fakeIpFilter', 'respectRules', 'dnsIpv6', 'useSystemHosts', 'hosts', 'directFollowPolicy', 'dnsCacheAlgorithm'],
  tun: ['tunStack', 'tunMtu', 'dnsHijack', 'bypassLan', 'routeExcludeAddress'],
  inbound: ['mixedPort', 'allowLan', 'ipv6', 'tcpConcurrent', 'blockQuic'],
  monitoring: ['probeUrl', 'probeStatus', 'probeIntervalMinutes'],
} as const satisfies Record<NetworkPage, readonly (keyof MobileNetwork)[]>

function lines(text: string) {
  return text.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return <section className="panel settings-form">
    <h2 className="settings-form-title">{title}</h2>
    {children}
  </section>
}

export function SettingSwitch({ label, hint, value, onChange, disabled }: {
  label: string; hint?: string; value: boolean; onChange: (value: boolean) => void; disabled?: boolean
}) {
  return <label className="settings-switch">
    <span><strong>{label}</strong>{hint && <small>{hint}</small>}</span>
    <Switch aria-label={label} checked={value} onCheckedChange={onChange} disabled={disabled} />
  </label>
}

interface Props {
  page: NetworkPage
  library: Library
  busy: boolean
  sdk: number
  backgroundResult?: { checked: number; available: number; at: number; error?: string }
  save: (network: MobileNetwork, monitoring: boolean) => void
}

export function NetworkSettings({ page, library, busy, sdk, backgroundResult, save }: Props) {
  const [draft, setDraft] = useState(library.network)
  const [textLists, setTextLists] = useState<Partial<Record<ListKey, string>>>({})
  const [monitoring, setMonitoring] = useState(library.monitoring)
  const [domain, setDomain] = useState('example.com')
  const [upstream, setUpstream] = useState('all')
  const [sourceId, setSourceId] = useState(library.sources[0]?.id ?? '')
  const [result, setResult] = useState('')
  const [testing, setTesting] = useState(false)
  const values = { ...draft, ...Object.fromEntries(Object.entries(textLists).map(([key, text]) => [key, lines(text)])) }
  const tune = <K extends keyof MobileNetwork>(key: K, value: MobileNetwork[K]) => {
    setDraft(previous => ({ ...previous, [key]: value }))
    setResult('')
  }
  function setList(key: ListKey, value: string) {
    setTextLists(previous => ({ ...previous, [key]: value }))
    setResult('')
  }
  const list = (key: ListKey, label: string, placeholder?: string, disabled = false) => <Field label={label}>
    <Textarea rows={2} value={textLists[key] ?? draft[key].join('\n')} spellCheck={false} placeholder={placeholder}
      disabled={disabled} onChange={event => setList(key, event.target.value)} />
  </Field>
  const flag = (key: FlagKey, label: string, hint?: string, disabled = false) =>
    <SettingSwitch label={label} hint={hint} value={draft[key]} onChange={value => tune(key, value)} disabled={disabled} />
  function importResolvers() {
    const source = library.sources.find(source => source.id === sourceId)
    if (!source) return
    try {
      const config = yamlProfile(source.yaml).profile.dns
      const dns = config && typeof config === 'object' ? config as Record<string, unknown> : {}
      const fields = [
        ['nameserver', 'nameserver'], ['defaultNameserver', 'default-nameserver'],
        ['directNameserver', 'direct-nameserver'], ['proxyServerNameserver', 'proxy-server-nameserver'], ['fallback', 'fallback'],
      ] as const
      const imported = Object.fromEntries(fields.flatMap(([key, yamlKey]) => {
        const servers = dns[yamlKey]
        return Array.isArray(servers) && servers.length ? [[key, servers.map(String).join('\n')]] : []
      }))
      if (!Object.keys(imported).length) throw new Error(tr('这份订阅没有填写 DNS 服务器'))
      setTextLists(previous => ({ ...previous, ...imported }))
      showMessage({ type: 'success', title: tr('已读取订阅中的 DNS 地址'), description: tr('可检查后点击保存') })
    } catch (failure) { showMessage({ type: 'error', title: message(failure) }) }
  }

  async function testDns() {
    setResult('')
    setTesting(true)
    try {
      validateNetwork(values)
      if (!domain.trim()) throw new Error(tr('请填写测试域名'))
      const plan = compile({ ...library, network: values }).plan
      const answer = await native<{ addresses: string[]; elapsedMs: number }>('testDns', {
        plan, domain: domain.trim(), server: upstream === 'all' ? undefined : upstream,
      })
      const summary = answer.addresses.join('、') + ' · ' + answer.elapsedMs + ' ms'
      setResult(summary)
      showMessage({ type: 'success', title: tr("DNS 解析成功 · {0} ms", answer.elapsedMs), description: answer.addresses.join('、') })
    } catch (failure) {
      showMessage({ type: 'error', title: tr('DNS 解析失败'), description: message(failure) })
    }
    finally { setTesting(false) }
  }

  return <form className="page-form" onSubmit={event => {
    event.preventDefault()
    try { validateNetwork(values); save(values, monitoring) }
    catch (failure) { showMessage({ type: 'error', title: message(failure) }) }
  }}>
    <main className="page-scroll">
      <fieldset disabled={busy || testing} className="settings-fields">
        {page === 'dns' && <>
          <Section title={tr("解析服务器")}>
            {list('nameserver', tr('主 DNS（Nameserver）'), 'https://1.1.1.1/dns-query')}
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="outline" size="sm" onClick={() => setList('nameserver', 'https://223.5.5.5/dns-query\nhttps://doh.pub/dns-query')}>{tr("阿里和腾讯 DoH")}</Button>
              <Button type="button" variant="ghost" size="sm" onClick={() => setList('nameserver', 'system')}>{tr("使用系统 DNS")}</Button>
            </div>
            {list('defaultNameserver', tr('引导 DNS（Default Nameserver）'), '223.5.5.5')}
            {list('directNameserver', tr('直连 DNS（Direct Nameserver）'))}
            {list('proxyServerNameserver', tr('节点 DNS（Proxy Server Nameserver）'))}
            {library.sources.length > 0 && <>
              <div className="field"><span>{tr("DNS 来源订阅")}</span><AirSelect label={tr("DNS 来源订阅")} value={sourceId} onChange={setSourceId}
                options={library.sources.map(source => ({ value: source.id, label: source.name }))} /></div>
              <Button type="button" variant="outline" onClick={importResolvers}>{tr("读取 DNS 地址")}</Button>
            </>}
          </Section>
          <details className="panel settings-form group">
            <summary className="settings-form-title flex cursor-pointer list-none items-center justify-between gap-2 select-none [&::-webkit-details-marker]:hidden">
              <span>{tr("高级 DNS 设置")}</span>
              <ChevronDown size={16} className="shrink-0 text-muted-foreground transition-transform duration-150 group-open:rotate-180" />
            </summary>
            <div className="settings-fields mt-2">
              {flag('respectRules', tr('DNS 连接遵循分流规则'), tr('启用时需要填写节点 DNS。'))}
              {flag('dnsIpv6', tr('返回 IPv6 解析结果'), tr('允许 DNS 返回 AAAA 记录。'), !draft.ipv6)}
              {flag('useSystemHosts', tr('读取系统 hosts'))}
              {list('hosts', tr('Air Proxy 本地 hosts'), '192.168.1.10 nas.home')}
              {flag('directFollowPolicy', tr('直连 DNS 遵循分域策略'), undefined, !values.directNameserver.length)}
              <div className="field"><span>{tr("DNS 缓存算法")}</span><AirSelect label={tr("DNS 缓存算法")}
                value={draft.dnsCacheAlgorithm} onChange={value => tune('dnsCacheAlgorithm', value)}
                options={[{ value: 'auto', label: tr('内核默认') }, { value: 'lru', label: tr('LRU · 保留最近查询') }, { value: 'arc', label: tr('ARC · 兼顾查询频率') }]} /></div>
              <div className="field"><span>{tr("解析模式")}</span><AirSelect label={tr("解析模式")}
                value={draft.enhancedMode} onChange={value => tune('enhancedMode', value)}
                options={[{ value: 'auto', label: tr('内核默认') }, { value: 'redir-host', label: tr('真实 IP（Redir-Host）') }, { value: 'fake-ip', label: tr('虚拟 IP（Fake-IP）') }]} /></div>
              {draft.enhancedMode !== 'redir-host' && list('fakeIpFilter', tr('Fake-IP 排除域名'), '+.lan')}
              {list('fallback', tr('备用 DNS（Fallback）'))}
              {list('fallbackDomains', tr('使用备用 DNS 的域名'), '+.example.com')}
              <div className="field"><span>{tr("分域 DNS")}</span>
                {draft.domainDns.map((entry, index) => <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] items-center gap-1.5" key={index}>
                  {(['domain', 'server'] as const).map(key => <Input key={key} required aria-label={(key === 'domain' ? tr('域名 ') : tr('DNS 地址 ')) + (index + 1)}
                    value={entry[key]} placeholder={key === 'domain' ? '+.corp.example' : '10.0.0.53'}
                    onChange={event => tune('domainDns', draft.domainDns.map((row, i) => i === index ? { ...row, [key]: event.target.value } : row))} />)}
                  <Button type="button" variant="ghost" size="icon" aria-label={tr('移除分域 DNS ') + (index + 1)}
                    onClick={() => tune('domainDns', draft.domainDns.filter((_, i) => i !== index))}><Trash2 /></Button>
                </div>)}
                <Button type="button" variant="outline" onClick={() => tune('domainDns', [...draft.domainDns, { domain: '', server: '' }])}>
                  <Plus data-icon="inline-start" />{tr("添加域名")}</Button>
              </div>
            </div>
          </details>
          <Section title={tr("测试 DNS 解析")}>
            <div className="field"><span>{tr("测试范围")}</span><AirSelect label={tr("测试范围")} value={upstream} onChange={setUpstream}
              options={[{ value: 'all', label: tr('按当前解析策略') }, ...[...new Set(values.nameserver)].map(value => ({ value, label: value }))]} /></div>
            <Field label={tr("测试域名")}><Input value={domain} onChange={event => { setDomain(event.target.value); setResult('') }} /></Field>
            <Button type="button" variant="outline" disabled={!domain.trim()} onClick={() => void testDns()}>
              {testing && <RefreshCw data-icon="inline-start" className="motion-safe:animate-spin" />}
              {testing ? tr('测试中…') : tr('测试解析')}
            </Button>
            {result && <p role="status" className="break-words text-sm">{result}</p>}
          </Section>
        </>}
        {page === 'tun' && <Section title="Air-TUN">
          <div className="field"><span>{tr("协议栈")}</span><AirSelect label={tr("协议栈")} value={draft.tunStack} onChange={value => tune('tunStack', value)}
            options={[{ value: 'gvisor', label: 'gVisor' }, { value: 'system', label: tr('系统（System）') }, { value: 'mixed', label: tr('混合（Mixed）') }]} /></div>
          <Field label={tr("最大传输单元（MTU）")}><Input type="number" min={1280} max={9000} placeholder="9000"
            value={draft.tunMtu ?? ''} onChange={event => tune('tunMtu', event.target.value ? Number(event.target.value) : null)} /></Field>
          {flag('dnsHijack', tr('接管 DNS 请求'), tr('把 Android 系统 DNS 查询交给 Air Proxy 解析。'))}
          {flag('bypassLan', tr('绕过局域网私网'), tr('自动跳过常见局域网网段，让内网设备和本地服务直连不经 VPN。'))}
          {list('routeExcludeAddress', tr('绕过 TUN 的网段'), '192.168.50.0/24', sdk < 33)}
          {sdk < 33 && <small className="fine-print">{tr("绕过网段需要 Android 13 或更新版本。")}</small>}
        </Section>}
        {page === 'inbound' && <Section title={tr("本地代理与网络")}>
          <Field label={tr("HTTP / SOCKS 混合端口")}><Input type="number" min={1} max={65535} placeholder={tr("留空时关闭本地代理端口")}
            value={draft.mixedPort ?? ''} onChange={event => tune('mixedPort', event.target.value ? Number(event.target.value) : null)} /></Field>
          {flag('allowLan', tr('允许局域网连接'), tr('开启后，同一网络中的设备可连接该端口。'))}
          {flag('ipv6', tr('允许 IPv6'))}
          {flag('tcpConcurrent', tr('TCP 并发连接'), tr('同时尝试域名对应的多个 IP。'))}
          {flag('blockQuic', tr('拦截境外 UDP 443'), tr('仅在规则模式的默认代理出口生效。支持回退的应用可改用 TCP，只支持 UDP 443 的服务可能无法连接。'))}
        </Section>}
        {page === 'monitoring' && <>
          <Section title={tr("后台监测")}>
            <SettingSwitch label={tr("后台定时测速")} hint={tr("由 Android 在网络可用时安排，间隔至少 15 分钟。")} value={monitoring} onChange={setMonitoring} />
            {backgroundResult && (
              <p
                role="status"
                className={backgroundResult.error ? 'text-xs font-medium text-destructive' : 'fine-print'}
              >
                {backgroundResult.error ||
                  tr("最近监测 {0} · {1} / {2} 可用", formatDateTime(backgroundResult.at), backgroundResult.available, backgroundResult.checked)}
              </p>
            )}
          </Section>
          <Section title={tr("延迟测试目标")}>
            <Field label={tr("后台测速间隔（分钟）")}><Input type="number" required min={15} max={1440}
              value={draft.probeIntervalMinutes || ''} onChange={event => tune('probeIntervalMinutes', Number(event.target.value))} /></Field>
            <Field label={tr("测试地址")}><Input type="url" required value={draft.probeUrl} onChange={event => tune('probeUrl', event.target.value)} /></Field>
            <Field label={tr("预期 HTTP 状态码")}><Input type="number" required min={100} max={599}
              value={draft.probeStatus || ''} onChange={event => tune('probeStatus', Number(event.target.value))} /></Field>
          </Section>
        </>}
      </fieldset>
    </main>
    <footer className="page-action settings-footer">
      <Button type="button" variant="outline" disabled={busy || testing} onClick={() => {
        const defaults = Object.fromEntries(pageFields[page].map(key => [key, defaultMobileNetwork[key]]))
        setDraft(previous => ({ ...previous, ...defaults })); setTextLists({}); setResult('')
        if (page === 'monitoring') setMonitoring(false)
        showMessage({ type: 'info', title: tr('已恢复本页默认值，点击保存后生效') })
      }}>{tr("恢复默认")}</Button>
      <Button type="submit" variant="default" className="flex-1" disabled={busy || testing}><Save data-icon="inline-start" />{tr("保存")}</Button>
    </footer>
  </form>
}

function message(error: unknown) { return error instanceof Error ? error.message : String(error) }
