import { validateRuleLibrary } from '@/shared/proxy/rule-library'
import { tr } from '@/shared/i18n/messages'
import { parseDocument, stringify } from 'yaml'
import { defaultNetwork, type NetworkSettings } from '@/shared/proxy/network'

export type MobileNetwork = Omit<NetworkSettings, 'strictRoute' | 'systemProxyBypass'>
const { strictRoute: _windowsOnly, systemProxyBypass: _windowsBypass, ...baseNetwork } = defaultNetwork
export const defaultMobileNetwork: MobileNetwork = {
  ...baseNetwork,
  ipv6: false,
  dnsIpv6: false,
  tunStack: 'gvisor',
  probeIntervalMinutes: 15,
}

export type RouteTarget =
  | { kind: 'selected' | 'direct' | 'reject' | 'subscription' }
  | { kind: 'node' | 'group' | 'chain'; id: string }
export type RuleMatcher = 'domain' | 'domainSuffix' | 'ip' | 'processName'
export type HostMatcher = 'domain' | 'domainSuffix' | 'ip'
export interface RouteRule {
  resumeOnEnable?: boolean
  enabled: boolean
  matcher: RuleMatcher
  value: string
  hostMatcher?: HostMatcher
  hostValue?: string
  target: RouteTarget
}
export interface MobileRouting {
  ruleLibrary?: import('@/shared/proxy/rule-library').RuleLibrary
  fallback: RouteTarget
  rules: RouteRule[]
}
export const defaultRouting: MobileRouting = {
  fallback: { kind: 'subscription' }, rules: [],
}

// Older versions saved "selected" as the default alongside a manually bound source.
export function routingFallback(saved: object, fallback: RouteTarget): RouteTarget {
  return fallback.kind === 'selected' && ('subscriptionId' in saved || 'inheritRules' in saved)
    ? defaultRouting.fallback : fallback
}

export const ruleMatchers = [
  { value: 'domain', get label() { return tr('完整域名') }, example: 'intranet.example.com' },
  { value: 'domainSuffix', get label() { return tr('域名及子域名') }, example: 'example.com' },
  { value: 'ip', get label() { return tr('IP 或网段') }, example: '10.0.0.0/8' },
  { value: 'processName', get label() { return tr('应用包名') }, example: 'com.android.chrome' },
] as const

function isIp(value: string): boolean {
  if (value.includes(':')) {
    try { return new URL(`http://[${value}]/`).hostname.startsWith('[') } catch { return false }
  }
  const parts = value.split('.')
  return parts.length === 4 && parts.every(piece => /^\d{1,3}$/.test(piece) && Number(piece) <= 255)
}

export function ipPrefix(value: string): string | undefined {
  const [address, prefix, ...rest] = value.split('/')
  if (rest.length || !isIp(address)) return
  const bits = address.includes(':') ? 128 : 32
  if (prefix === undefined) return `${address}/${bits}`
  if (/^\d{1,3}$/.test(prefix) && Number(prefix) <= bits) return `${address}/${Number(prefix)}`
}

function validDomain(value: string): boolean {
  return value.length <= 253 && value.split('.').every(part => /^[\p{L}\p{N}_-]{1,63}$/u.test(part))
}

function compileHostClause(matcher: HostMatcher, rawValue: string): string | undefined {
  const value = rawValue.trim()
  if (!value || value.includes(',')) return
  if (matcher === 'ip') {
    const prefix = ipPrefix(value)
    return prefix ? `${prefix.includes(':') ? 'IP-CIDR6' : 'IP-CIDR'},${prefix},no-resolve` : undefined
  }
  if (validDomain(value)) return `${matcher === 'domain' ? 'DOMAIN' : 'DOMAIN-SUFFIX'},${value}`
}

export function compileRule(rule: RouteRule, target: string): string | undefined {
  const value = rule.value.trim()
  if (!rule.enabled || !value || value.includes(',')) return
  const hostVal = rule.hostValue?.trim() ?? ''
  if (rule.hostMatcher && hostVal) {
    if (rule.matcher !== 'processName') return
    if (!/^[a-zA-Z0-9_]+(?:\.[a-zA-Z0-9_]+)*$/.test(value)) return
    const hostClause = compileHostClause(rule.hostMatcher, hostVal)
    return hostClause ? `AND,((PROCESS-NAME,${value}),(${hostClause})),${target}` : undefined
  }
  if (rule.hostMatcher || hostVal) return
  if (rule.matcher === 'ip') {
    const prefix = ipPrefix(value)
    return prefix ? `${prefix.includes(':') ? 'IP-CIDR6' : 'IP-CIDR'},${prefix},${target},no-resolve` : undefined
  }
  if (rule.matcher === 'processName') {
    return /^[a-zA-Z0-9_]+(?:\.[a-zA-Z0-9_]+)*$/.test(value) ? `PROCESS-NAME,${value},${target}` : undefined
  }
  if (validDomain(value)) return `${rule.matcher === 'domain' ? 'DOMAIN' : 'DOMAIN-SUFFIX'},${value},${target}`
}

function resolver(value: string, bootstrap = false) {
  if (value === 'system' || isIp(value)) return true
  if (/^(?:(?:[\w.-]+|\[[\da-f:]+\]):\d+)$/i.test(value)) {
    if (!bootstrap) return true
    const host = value.slice(0, value.lastIndexOf(':')).replace(/^\[|\]$/g, '')
    return isIp(host)
  }
  try {
    const url = new URL(value)
    if (!['https:', 'tls:', 'quic:', 'tcp:', 'udp:', 'dhcp:', 'rcode:'].includes(url.protocol) || !url.hostname) return false
    if (!bootstrap) return true
    return ['https:', 'tls:', 'quic:', 'tcp:', 'udp:'].includes(url.protocol) && isIp(url.hostname.replace(/^\[|\]$/g, ''))
  } catch { return false }
}

function numeric(value: number | null, min: number, max: number, label: string, nullable = false) {
  if (nullable && value === null) return
  if (value === null || !Number.isInteger(value) || value < min || value > max) throw new Error(tr("{0}需在 {1} 到 {2} 之间", label, min, max))
}

export function validateNetwork(settings: MobileNetwork) {
  if (!settings.nameserver.length) throw new Error(tr('请至少填写一个主 DNS'))
  if (settings.respectRules && !settings.proxyServerNameserver.length) throw new Error(tr('DNS 遵循分流规则时请填写节点 DNS'))
  for (const value of settings.defaultNameserver) {
    if (!resolver(value, true)) throw new Error(tr('引导 DNS 需使用 IP 地址 · ') + value)
  }
  for (const value of [
    ...settings.nameserver, ...settings.directNameserver,
    ...settings.proxyServerNameserver, ...settings.fallback, ...settings.domainDns.map(row => row.server),
  ]) {
    if (!resolver(value)) throw new Error(tr('无效的 DNS 地址 · ') + value)
  }
  if (settings.domainDns.some(row => !validDomain(row.domain.replace(/^[+*]\./, '')))) throw new Error(tr('分域 DNS 中有无效域名'))
  if (new Set(settings.domainDns.map(row => row.domain)).size !== settings.domainDns.length) throw new Error(tr('分域 DNS 域名不能重复'))
  if (settings.hosts.some(line => {
    const [ip, ...names] = line.split(/\s+/)
    return !isIp(ip) || !names.length || names.some(name => !validDomain(name))
  })) throw new Error(tr('Air Proxy 本地 hosts 每行需填一个 IP 和至少一个域名'))
  if (settings.routeExcludeAddress.some(value => !ipPrefix(value))) throw new Error(tr('绕过 TUN 的网段格式无效'))
  if (!['gvisor', 'system', 'mixed'].includes(settings.tunStack)) throw new Error(tr('虚拟网卡协议栈无效'))
  if (!['auto', 'redir-host', 'fake-ip'].includes(settings.enhancedMode)) throw new Error(tr('DNS 解析模式无效'))
  if (!['auto', 'lru', 'arc'].includes(settings.dnsCacheAlgorithm)) throw new Error(tr('DNS 缓存算法无效'))
  numeric(settings.tunMtu, 1280, 9000, 'MTU', true)
  numeric(settings.mixedPort, 1, 65535, tr('混合端口'), true)
  if (settings.allowLan && settings.mixedPort === null) throw new Error(tr('允许局域网连接前请设置混合端口'))
  numeric(settings.probeIntervalMinutes, 15, 1440, tr('后台测速间隔'))
  numeric(settings.probeStatus, 100, 599, tr('预期 HTTP 状态码'))
  const test = new URL(settings.probeUrl)
  if (test.protocol !== 'https:' && test.protocol !== 'http:') throw new Error(tr('测试地址需使用 HTTP 或 HTTPS'))
}

export function localHostRecords(settings: MobileNetwork) {
  return Object.fromEntries(settings.hosts.flatMap(line => {
    const [ip, ...names] = line.split(/\s+/)
    return names.map(name => [name.toLowerCase(), ip] as const)
  }))
}

const defaultDirectNameserver = [
  'https://223.5.5.5/dns-query',
  'https://120.53.53.53/dns-query',
  '223.5.5.5',
  '119.29.29.29',
]

const defaultFakeIpFilter = [
  '+.lan',
  '+.local',
  '+.localdomain',
  'geosite:private',
  'geosite:cn',
  'geosite:connectivity-check',
  '+.msftconnecttest.com',
  '+.msftncsi.com',
  'localhost.ptlogin2.qq.com',
  'localhost.sec.qq.com',
  'localhost.work.weixin.qq.com',
  'time.*.com',
  'ntp.*.com',
  '+.ntp.org.cn',
  'stun.*.*',
  'stun.*.*.*',
  '+.stun.*.*',
  '+.stun.*.*.*',
  '+.srv.nintendo.net',
  '+.stun.playstation.net',
  'xbox.*.microsoft.com',
  'xnotify.xboxlive.com',
  '+.battlenet.com.cn',
  '+.wotgame.cn',
  '+.wggames.cn',
  '+.wowsgame.cn',
]

export function dnsConfiguration(settings: MobileNetwork, hosts: Record<string, unknown> = localHostRecords(settings)) {
  const hasHosts = Object.keys(hosts).length > 0
  const defaultNameserver = settings.defaultNameserver.length > 0
    ? settings.defaultNameserver
    : ['223.5.5.5', '119.29.29.29', '1.1.1.1']
  const directNameserver = settings.directNameserver.length > 0
    ? settings.directNameserver
    : settings.respectRules
      ? defaultDirectNameserver
      : []
  const nameserverPolicy: Record<string, string | string[]> = {}
  if (settings.respectRules && directNameserver.length > 0) {
    nameserverPolicy['geosite:cn,private'] = directNameserver
  }
  for (const row of settings.domainDns) {
    nameserverPolicy[row.domain] = row.server
  }
  const hasPolicy = Object.keys(nameserverPolicy).length > 0
  const dns = {
    enable: true,
    ipv6: settings.ipv6 && settings.dnsIpv6,
    nameserver: settings.nameserver,
    'use-system-hosts': settings.useSystemHosts,
    'respect-rules': settings.respectRules,
    ...(settings.enhancedMode !== 'auto' && { 'enhanced-mode': settings.enhancedMode }),
    'fake-ip-range': '198.18.0.1/16',
    'fake-ip-filter': settings.fakeIpFilter.length ? settings.fakeIpFilter : defaultFakeIpFilter,
    'default-nameserver': defaultNameserver,
    ...(settings.proxyServerNameserver.length > 0 && { 'proxy-server-nameserver': settings.proxyServerNameserver }),
    ...(directNameserver.length > 0 && {
      'direct-nameserver': directNameserver,
      'direct-nameserver-follow-policy': settings.directFollowPolicy,
    }),
    ...(settings.dnsCacheAlgorithm !== 'auto' && { 'cache-algorithm': settings.dnsCacheAlgorithm }),
    ...(hasPolicy && { 'nameserver-policy': nameserverPolicy }),
    ...(settings.fallback.length > 0 && { fallback: settings.fallback, 'fallback-filter': { geoip: settings.fallbackDomains.length === 0, domain: settings.fallbackDomains } }),
    ...(hasHosts && { 'use-hosts': true }),
  }
  return { dns, ...(hasHosts && { hosts }) }
}

export function configSource(network: MobileNetwork, routing: MobileRouting, monitoring: boolean) {
  return stringify({ network, routing, monitoring })
}

function map(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(name + tr(' 需要是一个键值配置'))
  return value as Record<string, unknown>
}

function routeTarget(value: unknown, name: string): RouteTarget {
  const target = map(value, name)
  switch (target.kind) {
    case 'selected': case 'direct': case 'reject': case 'subscription':
      return { kind: target.kind }
    case 'node': case 'group': case 'chain':
      if (typeof target.id === 'string' && target.id) return { kind: target.kind, id: target.id }
  }
  throw new Error(name + tr(' 的出站无效'))
}

export function validateRouting(routing: MobileRouting) {
  if (routing.ruleLibrary) validateRuleLibrary(routing.ruleLibrary)
  for (const [index, rule] of routing.rules.entries()) {
    if (rule.enabled && !compileRule(rule, 'DIRECT')) throw new Error(tr("规则 {0} 的匹配值格式无效", index + 1))
  }
}

export function parseSettings(text: string) {
  if (new TextEncoder().encode(text).length > 1024 * 1024) throw new Error(tr('配置文件超过 1 MB'))
  const doc = parseDocument(text)
  if (doc.errors[0]) throw new Error(doc.errors[0].message)
  const source = map(doc.toJS({ maxAliasCount: 50 }), tr('Air Proxy 配置'))
  if (Object.keys(source).some(key => !['network', 'routing', 'monitoring'].includes(key))) throw new Error(tr('Air Proxy 配置只支持 network、routing 和 monitoring'))
  const rawNetwork = map(source.network ?? {}, 'network')
  for (const [key, value] of Object.entries(rawNetwork)) {
    if (!Object.hasOwn(defaultMobileNetwork, key)) throw new Error(tr('未知网络配置项 · ') + key)
    const sample = defaultMobileNetwork[key as keyof MobileNetwork]
    if (key === 'domainDns') {
      if (!Array.isArray(value) || value.some(row => !row || typeof row.domain !== 'string' || typeof row.server !== 'string')) {
        throw new Error(tr('domainDns 每项需要 domain 和 server'))
      }
    } else if (Array.isArray(sample) ? !Array.isArray(value) || value.some(item => typeof item !== 'string')
      : sample === null ? value !== null && typeof value !== 'number' : typeof sample !== typeof value) {
      throw new Error(tr('网络配置类型无效 · ') + key)
    }
  }
  const network = { ...defaultMobileNetwork, ...rawNetwork }
  const rawRouting = map(source.routing ?? {}, 'routing')
  if (rawRouting.rules !== undefined && !Array.isArray(rawRouting.rules)) throw new Error(tr('rules 需要是规则列表'))
  if (rawRouting.ruleLibrary !== undefined) validateRuleLibrary(rawRouting.ruleLibrary)
  const routing: MobileRouting = {
    ...(rawRouting.ruleLibrary && { ruleLibrary: rawRouting.ruleLibrary }),
    fallback: routingFallback(rawRouting, routeTarget(rawRouting.fallback ?? defaultRouting.fallback, tr('默认出口'))),
    rules: (rawRouting.rules as unknown[] | undefined ?? []).map((value, index) => {
      const name = tr('规则 ') + (index + 1)
      const rule = map(value, name)
      if (typeof rule.enabled !== 'boolean' || typeof rule.value !== 'string' || !ruleMatchers.some(item => item.value === rule.matcher)) {
        throw new Error(name + tr(' 的格式无效'))
      }
      const hostMatcher = rule.hostMatcher
      const hostValue = rule.hostValue
      if (hostMatcher !== undefined && (typeof hostMatcher !== 'string' || !['domain', 'domainSuffix', 'ip'].includes(hostMatcher))) {
        throw new Error(name + tr(' 的格式无效'))
      }
      if (hostValue !== undefined && typeof hostValue !== 'string') {
        throw new Error(name + tr(' 的格式无效'))
      }
      return {
        enabled: rule.enabled,
        ...(rule.resumeOnEnable === true && { resumeOnEnable: true }),
        value: rule.value,
        matcher: rule.matcher as RuleMatcher,
        ...(hostMatcher ? { hostMatcher: hostMatcher as HostMatcher } : {}),
        ...(typeof hostValue === 'string' && hostValue ? { hostValue } : {}),
        target: routeTarget(rule.target, name),
      }
    }),
  }
  if (source.monitoring != null && typeof source.monitoring !== 'boolean') throw new Error(tr('monitoring 必须是布尔值'))
  validateNetwork(network)
  validateRouting(routing)
  return { network, routing, monitoring: source.monitoring === true }
}
