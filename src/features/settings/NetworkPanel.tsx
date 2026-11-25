import { tr } from '@/shared/i18n/messages'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { ChevronDown, Plus, Trash2 } from 'lucide-react'
import { air, type NetworkDocument, type SubscriptionSource } from '@/platform/desktop/air'
import { defaultNetwork, type NetworkSettings } from '@/shared/proxy/network'
import { AirSelect } from '@/shared/ui/AirSelect'
import { Button } from '@/shared/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/shared/ui/card'
import { Input } from '@/shared/ui/input'
import { Label } from '@/shared/ui/label'
import { showMessage } from '@/shared/ui/message'
import { Switch } from '@/shared/ui/switch'
import { Textarea } from '@/shared/ui/textarea'

export type NetworkPage = 'dns' | 'tun' | 'inbound' | 'monitoring'
const pageKeys = {
  dns: ['nameserver', 'defaultNameserver', 'directNameserver', 'proxyServerNameserver', 'fallback', 'fallbackDomains', 'domainDns', 'respectRules', 'enhancedMode', 'fakeIpFilter', 'dnsIpv6', 'useSystemHosts', 'hosts', 'directFollowPolicy', 'dnsCacheAlgorithm'],
  tun: ['tunStack', 'tunMtu', 'bypassLan', 'strictRoute', 'dnsHijack', 'routeExcludeAddress'],
  inbound: ['mixedPort', 'systemProxyBypass', 'allowLan', 'ipv6', 'tcpConcurrent', 'blockQuic'],
  monitoring: ['probeUrl', 'probeStatus', 'probeIntervalMinutes'],
} as const satisfies Record<NetworkPage, readonly (keyof NetworkSettings)[]>
const dohPreset = ['https://223.5.5.5/dns-query', 'https://doh.pub/dns-query']
type KeysOf<T> = { [K in keyof NetworkSettings]: NetworkSettings[K] extends T ? K : never }[keyof NetworkSettings]

function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return <Card className="gap-4 p-4">
    <CardHeader className="flex-col items-start gap-1"><CardTitle>{title}</CardTitle>{hint && <CardDescription>{hint}</CardDescription>}</CardHeader>
    <CardContent className="gap-4">{children}</CardContent>
  </Card>
}

function cleanSettings(values: NetworkSettings): NetworkSettings {
  const cleaned = { ...values }
  for (const key of ['nameserver', 'defaultNameserver', 'directNameserver', 'proxyServerNameserver', 'fallback', 'fallbackDomains', 'fakeIpFilter', 'routeExcludeAddress', 'systemProxyBypass', 'hosts'] as const) {
    cleaned[key] = values[key].map(v => v.trim()).filter(Boolean)
  }
  cleaned.domainDns = values.domainDns.map(({domain, server}) => ({ domain: domain.trim(), server: server.trim() }))
  cleaned.probeUrl = values.probeUrl.trim()
  return cleaned
}

let cachedNetworkDoc: NetworkDocument | undefined

export function NetworkPanel({ page, kernelPath, sources = [] }: { page: NetworkPage; kernelPath?: string | null; sources?: SubscriptionSource[] }) {
  const [doc, setDoc] = useState<NetworkDocument | undefined>(() => cachedNetworkDoc)
  const [draft, setDraft] = useState<NetworkSettings | undefined>(() => cachedNetworkDoc?.settings)
  const [loadError, setLoadError] = useState('')
  const [needsReload, setNeedsReload] = useState(false)
  const [saving, setSaving] = useState(false)
  const [domain, setDomain] = useState('www.baidu.com')
  const [testUpstream, setTestUpstream] = useState('all')
  const [testing, setTesting] = useState(false)
  const [result, setResult] = useState('')
  const [reload, setReload] = useState(0)
  const [sourceId, setSourceId] = useState('')
  const [importing, setImporting] = useState(false)
  const docRef = useRef(doc)
  const draftRef = useRef(draft)
  const lastReloadRef = useRef(reload)
  docRef.current = doc
  draftRef.current = draft
  const subscriptions = sources.filter(s => s.details?.kind !== 'custom')
  const selectedSource = subscriptions.find(s => s.id === sourceId) ?? subscriptions[0]
  useEffect(() => {
    let current = true
    const forced = reload !== lastReloadRef.current
    lastReloadRef.current = reload
    setLoadError('')
    if (forced) {
      setNeedsReload(false)
      setResult('')
      setTestUpstream('all')
    }
    air.networkSettings().then(data => {
      cachedNetworkDoc = data
      if (!current) return
      const prevDoc = docRef.current
      const prevDraft = draftRef.current
      const hasUnsavedEdits = Boolean(
        prevDoc && prevDraft && JSON.stringify(prevDraft) !== JSON.stringify(prevDoc.settings),
      )
      if (!forced && hasUnsavedEdits) {
        if (prevDoc && prevDoc.revision !== data.revision) setNeedsReload(true)
        return
      }
      if (forced || !prevDoc || prevDoc.revision !== data.revision) {
        setDoc(data)
        setDraft(data.settings)
      }
      setNeedsReload(false)
    }).catch(err => {
      if (!current) return
      const text = err instanceof Error ? err.message : String(err)
      if (!docRef.current) setLoadError(text)
      showMessage({ type: 'error', title: text })
    })
    return () => { current = false }
  }, [reload])

  function update<K extends keyof NetworkSettings>(key: K, value: NetworkSettings[K]) {
    setDraft(prev => prev && { ...prev, [key]: value })
    setNeedsReload(false)
    setResult('')
    if (key === 'nameserver') setTestUpstream('all')
  }
  const readAgain = <Button type="button" variant="outline" onClick={() => setReload(v => v + 1)}>{tr("重新读取")}</Button>
  if (!doc || !draft) return <div role="status" className="flex items-center gap-3 text-sm">{loadError || tr('正在读取设置…')}{loadError && readAgain}</div>
  const values = draft
  const dirty = JSON.stringify(draft) !== JSON.stringify(doc.settings)

  function list(key: KeysOf<string[]>, title: string, hint: string, placeholder?: string) {
    return <div className="flex flex-col gap-1.5">
      <Label htmlFor={key}>{title}</Label>
      <Textarea id={key} aria-describedby={key + '-hint'} spellCheck={false} rows={2} className="mono" placeholder={placeholder}
        value={values[key].join('\n')} onChange={e => update(key, e.target.value.split('\n'))} />
      <p id={key + '-hint'} className="text-xs text-muted-foreground">{hint}</p>
    </div>
  }
  function toggle(key: KeysOf<boolean>, title: string, hint: string, disabled = false) {
    return <div className="flex items-center justify-between gap-4">
      <div><Label htmlFor={key}>{title}</Label><p className="mt-1 text-xs text-muted-foreground">{hint}</p></div>
      <Switch id={key} checked={values[key]} onCheckedChange={v => update(key, v)} disabled={disabled} />
    </div>
  }
  function optionalNumber(key: 'mixedPort' | 'tunMtu', title: string, min: number, max: number, hint: string) {
    return <div className="flex flex-col gap-1.5"><Label htmlFor={key}>{title}</Label>
      <Input id={key} type="number" min={min} max={max} step={1} value={values[key] ?? ''} placeholder={tr("自动")}
        onChange={e => update(key, e.target.value === '' ? null : Number(e.target.value))} />
      <p className="text-xs text-muted-foreground">{hint}</p></div>
  }
  async function save() {
    if (!doc || saving) return
    setNeedsReload(false)
    setSaving(true)
    try {
      const next = await air.saveNetworkSettings(cleanSettings(values), doc.revision)
      cachedNetworkDoc = next
      setDoc(next)
      setDraft(next.settings)
      showMessage({
        type: 'success',
        title: page === 'monitoring' ? tr('已保存，下次测速时使用') : tr('已保存，运行中的代理将自动应用'),
      })
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err)
      if (text === tr('配置文件已更新，请重新读取后再保存')) setNeedsReload(true)
      showMessage({ type: 'error', title: text })
    }
    finally { setSaving(false) }
  }
  async function testDns() {
    if (!kernelPath || testing) return
    setTesting(true)
    setResult('')
    try {
      const settings = cleanSettings(values)
      if (testUpstream !== 'all') {
        settings.nameserver = [testUpstream]
        settings.domainDns = []
        settings.fallback = []
        settings.fallbackDomains = []
        settings.hosts = []
        settings.useSystemHosts = false
      }
      const answer = await air.testDns(kernelPath, settings, domain.trim())
      const summary = answer.addresses.join('、') + ' · ' + answer.elapsedMs + ' ms'
      setResult(summary)
      showMessage({ type: 'success', title: tr("DNS 解析成功 · {0} ms", answer.elapsedMs), description: answer.addresses.join('、') })
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err)
      setResult(text)
      showMessage({ type: 'error', title: tr('DNS 解析失败'), description: text })
    }
    finally { setTesting(false) }
  }

  async function importResolvers() {
    if (!selectedSource || importing) return
    setImporting(true)
    setResult('')
    try {
      const lists = await air.subscriptionResolvers(selectedSource.id)
      setDraft(current => current && { ...current, ...lists })
      setTestUpstream('all')
      showMessage({
        type: 'success',
        title: tr("已从「{0}」填入 {1} 项 DNS 列表", selectedSource.name, Object.keys(lists).length),
        description: tr('可检查后保存'),
      })
    } catch (err) {
      showMessage({ type: 'error', title: err instanceof Error ? err.message : String(err) })
    }
    finally { setImporting(false) }
  }

  return <form className="flex flex-col gap-3" onSubmit={e => { e.preventDefault(); void save() }}>
    <fieldset disabled={saving || testing || importing} className="flex min-w-0 flex-col gap-3">
      {page === 'dns' && <>
        <Section title={tr("解析服务器")} hint={tr("每行填写一个地址。支持系统 DNS、普通 DNS、DoH、DoT 和 DoQ。")}>
          {list('nameserver', tr('主 DNS（Nameserver）'), tr('用于常规域名查询。下方预设只替换这一项。'), 'system')}
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" type="button" size="sm" onClick={() => update('nameserver', [...dohPreset])}>{tr("阿里和腾讯 DoH")}</Button>
            <Button variant="ghost" type="button" size="sm" onClick={() => update('nameserver', ['system'])}>{tr("使用系统 DNS")}</Button>
          </div>
          {list('defaultNameserver', tr('引导 DNS（Default Nameserver）'), tr('解析 DNS 服务器自身的域名。留空使用内核默认，可填写 IP 或基于 IP 的加密 DNS。'), '223.5.5.5')}
          {list('directNameserver', tr('直连 DNS（Direct Nameserver）'), tr('用于直连出口，留空沿用主解析策略。'))}
          {list('proxyServerNameserver', tr('节点 DNS（Proxy Server Nameserver）'), tr('用于解析节点服务器地址，留空沿用主解析策略。'))}
          {selectedSource && <div className="flex flex-col gap-2">
            <Label>{tr("从订阅读取解析服务器")}</Label>
            <div className="flex items-center gap-2">
              <AirSelect
                label={tr("DNS 来源订阅")}
                value={selectedSource.id}
                onChange={setSourceId}
                className="w-auto min-w-0 flex-1"
                options={subscriptions.map(s => ({ value: s.id, label: s.name }))}
              />
              <Button variant="outline" type="button" className="shrink-0" onClick={() => void importResolvers()}>{tr("读取 DNS 地址")}</Button>
            </div>
            <p className="text-xs text-muted-foreground">{tr("读取此订阅 YAML 中填写的服务器列表。检查后保存即可应用到 Air Proxy。")}</p>
          </div>}
        </Section>
        <details className="air-card-surface group rounded-[11px] border border-border bg-card p-4 shadow-(--shadow-card)">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-2 text-sm font-semibold text-foreground select-none [&::-webkit-details-marker]:hidden">
            <span>{tr("高级 DNS 设置")}</span>
            <ChevronDown className="size-4 shrink-0 text-muted-foreground transition-transform duration-150 group-open:rotate-180" />
          </summary>
          <div className="mt-4 flex flex-col gap-5">
            {toggle('respectRules', tr('DNS 连接遵循分流规则'), tr('启用时需要单独指定节点 DNS。'))}
            {toggle('dnsIpv6', tr('返回 IPv6 解析结果'), values.ipv6 ? tr('允许 DNS 返回 AAAA 记录。') : tr('请先在「代理接入」中启用 IPv6。'), !values.ipv6)}
            {toggle('useSystemHosts', tr('读取系统 hosts'), tr('解析时使用 Windows hosts 文件中的本地记录。'))}
            {list('hosts', tr('Air Proxy 本地 hosts'), tr('每行填写 IP 和域名，用空格分隔。同一个 IP 可以对应多个域名。'), '192.168.1.10 nas.home')}
            {toggle('directFollowPolicy', tr('直连 DNS 遵循分域策略'), tr('填写直连 DNS 后，可让指定域名继续使用下方的分域 DNS。'), !values.directNameserver.some(v => v.trim()))}
            <div className="flex flex-col gap-1.5"><Label>{tr("DNS 缓存算法")}</Label>
              <AirSelect label={tr("DNS 缓存算法")} value={values.dnsCacheAlgorithm} onChange={v => update('dnsCacheAlgorithm', v)}
                options={[{ value: 'auto', label: tr('内核默认') }, { value: 'lru', label: tr('LRU · 保留最近查询') }, { value: 'arc', label: tr('ARC · 兼顾查询频率') }]} /></div>
            <div className="flex flex-col gap-1.5"><Label>{tr("解析模式")}</Label>
              <AirSelect label={tr("解析模式")} value={values.enhancedMode} onChange={v => update('enhancedMode', v)}
                options={[{ value:'auto', label:tr('内核默认') }, { value:'redir-host', label:tr('真实 IP（Redir-Host）') }, { value:'fake-ip', label:tr('虚拟 IP（Fake-IP）') }]} /></div>
            {values.enhancedMode !== 'redir-host' && list('fakeIpFilter', tr('Fake-IP 排除域名'), tr('Fake-IP 模式下，这些域名返回真实 IP。'), '+.lan')}
            {list('fallback', tr('备用 DNS（Fallback）'), tr('主解析失败或命中备用域名时使用。'))}
            {list('fallbackDomains', tr('使用备用 DNS 的域名'), tr('每行一个域名，可用 +.example.com 匹配其子域名。'))}
            <div className="flex flex-col gap-2"><Label>{tr("分域 DNS")}</Label>
              <p className="text-xs text-muted-foreground">{tr("指定域名使用专属 DNS，例如让公司域名走内网 DNS。")}</p>
              {values.domainDns.map((row, index) => <div key={index} className="flex flex-wrap items-center gap-2">
                {(['domain', 'server'] as const).map((field) => <Input key={field} className="min-w-32 flex-1" required
                  aria-label={(field === 'domain' ? tr('域名 ') : tr('DNS 地址 ')) + (index + 1)} spellCheck={false}
                  placeholder={field === 'domain' ? '+.corp.example' : '10.0.0.53'} value={row[field]}
                  onChange={e => update('domainDns', values.domainDns.map((item, i) => i === index ? { ...item, [field]: e.target.value } : item))} />)}
                <Button type="button" size="icon" variant="ghost" aria-label={tr('移除分域 DNS ') + (index + 1)} onClick={() => update('domainDns', values.domainDns.filter((_, i) => i !== index))}><Trash2 /></Button>
              </div>)}
              <Button className="self-start" variant="outline" type="button" size="sm" onClick={() => update('domainDns', [...values.domainDns, { domain: '', server: '' }])}><Plus data-icon="inline-start" />{tr("添加域名")}</Button>
            </div>
          </div>
        </details>
        <Section title={tr("测试 DNS 解析")} hint={tr("通过当前网络直接测试本页填写的 DNS，使用独立内核，无需启动代理。")}>
          <div className="flex flex-col gap-1.5">
            <Label>{tr("测试范围")}</Label>
            <AirSelect label={tr("测试范围")} value={testUpstream}
              onChange={v => { setTestUpstream(v); setResult('') }}
              options={[{ value: 'all', label: tr('按当前解析策略') }, ...Array.from(new Set(values.nameserver.map(v => v.trim()).filter(Boolean))).map(v => ({ value: v, label: v }))]} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="dns-test-domain">{tr("测试域名")}</Label>
            <div className="flex items-center gap-2">
              <Input id="dns-test-domain" className="min-w-0 flex-1" value={domain} onChange={e => { setDomain(e.target.value); setResult('') }} />
              <Button type="button" variant="outline" className="shrink-0" disabled={!kernelPath || !domain.trim()} onClick={() => void testDns()}>{testing ? tr('测试中…') : tr('测试解析')}</Button>
            </div>
          </div>
          {(!kernelPath || result) && <p role="status" className="break-words text-sm">{result || tr('请先在「诊断内核」选择 Mihomo。')}</p>}
        </Section>
      </>}
      {page === 'tun' && <Section title="Air-TUN" hint={tr("虚拟网卡使用管理员权限运行，在仪表盘或托盘开启。")}>
        <div className="flex flex-col gap-1.5"><Label>{tr("协议栈")}</Label><AirSelect label={tr("协议栈")} value={values.tunStack} onChange={v => update('tunStack', v)}
          options={[{value:'gvisor', label:'gVisor'}, {value:'system', label:tr('系统（System）')}, {value:'mixed', label:tr('混合（Mixed）')}]} /></div>
        {optionalNumber('tunMtu', tr('最大传输单元（MTU）'), 1280, 9000, tr('单位为字节，留空由内核决定。'))}
        {toggle('dnsHijack', tr('接管 DNS 请求'), tr('将经过 TUN 的 TCP 和 UDP 53 端口查询交给 Air Proxy 解析。'))}
        {toggle('bypassLan', tr('绕过局域网私网'), tr('默认绕过 10/8、172.16/12、192.168/16 等局域网私网，不接管内网设备和本地路由。'))}
        {toggle('strictRoute', tr('严格路由'), tr('收紧 Windows 的路由和 DNS 限制（默认关闭，以兼容双网卡、自定义静态路由及其他 VPN）。'))}
        {list('routeExcludeAddress', tr('绕过 TUN 的网段'), tr('每行一个额外绕过的 IPv4 或 IPv6 网段，例如使用公网地址的内网设备或特定公司网段。'), '192.168.50.0/24')}
      </Section>}
      {page === 'inbound' && <Section title={tr("本地代理与网络")}>
        {optionalNumber('mixedPort', tr('HTTP / SOCKS 混合端口'), 1, 65535, tr('留空时优先使用 7890。如已占用，Air Proxy 会使用空闲端口，并在 7890 释放后接收该端口的本地 TCP 代理连接。'))}
        {toggle('allowLan', tr('允许局域网连接'), tr('允许 IPv4 私网设备使用本机的代理端口，仅在信任的网络中开启。'))}
        {list('systemProxyBypass', tr('Windows 系统代理绕过列表'), tr('默认已自动绕过本机与局域网地址，此处填写需要额外绕过的地址或通配符，每行一个。'), '<local>\n*.lan')}
        {toggle('ipv6', tr('允许 IPv6'), tr('允许代理内核使用 IPv6 网络。关闭时也会禁用 AAAA 解析。'))}
        {toggle('tcpConcurrent', tr('TCP 并发连接'), tr('同时尝试域名对应的多个 IP，使用最先成功的连接。'))}
        {toggle('blockQuic', tr('拦截代理 QUIC（UDP 443）'), tr('默认关闭以兼容游戏和语音；仅在节点 UDP 不稳导致网页/视频加载缓慢时开启，强制代理流量回落 TCP（不影响直连与国内规则）。'))}
      </Section>}
      {page === 'monitoring' && <Section title={tr("延迟测试目标")} hint={tr("节点卡片、顶栏和后台测速使用同一目标。")}>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="probeIntervalMinutes">{tr("后台测速间隔（分钟）")}</Label>
          <Input id="probeIntervalMinutes" type="number" required min={1} max={1440} value={values.probeIntervalMinutes || ''} onChange={e => update('probeIntervalMinutes', Number(e.target.value))} />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="probeUrl">{tr("测试地址")}</Label>
          <Input id="probeUrl" type="url" required value={values.probeUrl} onChange={e => update('probeUrl', e.target.value)} />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="probeStatus">{tr("预期 HTTP 状态码")}</Label>
          <Input id="probeStatus" type="number" required min={100} max={599} value={values.probeStatus || ''} onChange={e => update('probeStatus', Number(e.target.value))} />
        </div>
      </Section>}
      <p className="text-xs text-muted-foreground">{page === 'monitoring' ? tr('保存后从下次测速开始生效。') : tr('保存后立即应用到运行中的代理；未启动时会在下次启动生效。')}</p>
      {needsReload && <div className="flex items-center gap-2 text-xs text-muted-foreground"><span>{tr("配置已被外部修改")}</span>{readAgain}</div>}
      <div className="flex items-center justify-between gap-3">
        <Button type="button" variant="ghost" onClick={() => {
          const defaults = Object.fromEntries(pageKeys[page].map(key => [key, structuredClone(defaultNetwork[key])]))
          setDraft({ ...values, ...defaults }); setNeedsReload(false); setResult(''); setTestUpstream('all')
          showMessage({ type: 'info', title: tr('已恢复本页默认值，点击保存后生效') })
        }}>{tr("恢复本页默认值")}</Button>
        <Button type="submit" variant="default" disabled={!dirty || saving}>{saving ? tr('正在保存…') : tr('保存设置')}</Button>
      </div>
    </fieldset>
  </form>
}
