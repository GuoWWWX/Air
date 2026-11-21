import { parseDocument, stringify } from 'yaml'
import { defaultNetwork, type NetworkSettings } from '@/shared/proxy/network'

export type MobileNetwork = Omit<NetworkSettings, 'strictRoute' | 'systemProxyBypass'>
const { strictRoute: _windowsOnly, systemProxyBypass: _windowsBypass, ...baseNetwork } = defaultNetwork
export const defaultMobileNetwork: MobileNetwork = { ...baseNetwork, probeIntervalMinutes: 15 }

export type RouteTarget =
  | { kind: 'selected' | 'direct' | 'reject' | 'subscription' }
  | { kind: 'group' | 'chain'; id: string }
export type RuleMatcher = 'domain' | 'domainSuffix' | 'ip' | 'processName'
export interface RouteRule {
  enabled: boolean
  matcher: RuleMatcher
  value: string
  target: RouteTarget
}
export interface MobileRouting {
  subscriptionId: string | null
  inheritRules: boolean
  fallback: RouteTarget
  rules: RouteRule[]
}
export const defaultRouting: MobileRouting = {
  subscriptionId: null, inheritRules: true, fallback: { kind: 'selected' }, rules: [],
}

export const ruleMatchers = [
  { value: 'domain', label: '完整域名', example: 'intranet.example.com' },
  { value: 'domainSuffix', label: '域名及子域名', example: 'example.com' },
  { value: 'ip', label: 'IP 或网段', example: '10.0.0.0/8' },
  { value: 'processName', label: '应用包名', example: 'com.android.chrome' },
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

export function compileRule(rule: RouteRule, target: string): string | undefined {
  const value = rule.value.trim()
  if (!rule.enabled || !value || value.includes(',')) return
  if (rule.matcher === 'ip') {
    const prefix = ipPrefix(value)
    return prefix ? `${prefix.includes(':') ? 'IP-CIDR6' : 'IP-CIDR'},${prefix},${target},no-resolve` : undefined
  }
  if (rule.matcher === 'processName') {
    return /^[a-zA-Z0-9_]+(?:\.[a-zA-Z0-9_]+)*$/.test(value) ? `PROCESS-NAME,${value},${target}` : undefined
  }
  if (validDomain(value)) return `${rule.matcher === 'domain' ? 'DOMAIN' : 'DOMAIN-SUFFIX'},${value},${target}`
}

function resolver(value: string) {
  if (value === 'system' || isIp(value)) return true
  if (/^(?:(?:[\w.-]+|\[[\da-f:]+\]):\d+)$/i.test(value)) return true
  try {
    const url = new URL(value)
    return ['https:', 'tls:', 'quic:', 'tcp:', 'udp:', 'dhcp:', 'rcode:'].includes(url.protocol) && Boolean(url.hostname)
  } catch { return false }
}

function numeric(value: number | null, min: number, max: number, label: string, nullable = false) {
  if (nullable && value === null) return
  if (value === null || !Number.isInteger(value) || value < min || value > max) throw new Error(`${label}需在 ${min} 到 ${max} 之间`)
}

export function validateNetwork(settings: MobileNetwork) {
  if (!settings.nameserver.length) throw new Error('请至少填写一个主 DNS')
  if (settings.respectRules && !settings.proxyServerNameserver.length) throw new Error('DNS 遵循分流规则时请填写节点 DNS')
  for (const value of [
    ...settings.nameserver, ...settings.defaultNameserver, ...settings.directNameserver,
    ...settings.proxyServerNameserver, ...settings.fallback, ...settings.domainDns.map(row => row.server),
  ]) {
    if (!resolver(value)) throw new Error('无效的 DNS 地址 · ' + value)
  }
  if (settings.domainDns.some(row => !validDomain(row.domain.replace(/^[+*]\./, '')))) throw new Error('分域 DNS 中有无效域名')
  if (new Set(settings.domainDns.map(row => row.domain)).size !== settings.domainDns.length) throw new Error('分域 DNS 域名不能重复')
  if (settings.hosts.some(line => {
    const [ip, ...names] = line.split(/\s+/)
    return !isIp(ip) || !names.length || names.some(name => !validDomain(name))
  })) throw new Error('Air 本地 hosts 每行需填一个 IP 和至少一个域名')
  if (settings.routeExcludeAddress.some(value => !ipPrefix(value))) throw new Error('绕过 TUN 的网段格式无效')
  if (!['gvisor', 'system', 'mixed'].includes(settings.tunStack)) throw new Error('虚拟网卡协议栈无效')
  if (!['auto', 'redir-host', 'fake-ip'].includes(settings.enhancedMode)) throw new Error('DNS 解析模式无效')
  if (!['auto', 'lru', 'arc'].includes(settings.dnsCacheAlgorithm)) throw new Error('DNS 缓存算法无效')
  numeric(settings.tunMtu, 1280, 9000, 'MTU', true)
  numeric(settings.mixedPort, 1, 65535, '混合端口', true)
  if (settings.allowLan && settings.mixedPort === null) throw new Error('允许局域网连接前请设置混合端口')
  numeric(settings.probeIntervalMinutes, 15, 1440, '后台测速间隔')
  numeric(settings.probeStatus, 100, 599, '预期 HTTP 状态码')
  const test = new URL(settings.probeUrl)
  if (test.protocol !== 'https:' && test.protocol !== 'http:') throw new Error('测试地址需使用 HTTP 或 HTTPS')
}

export function localHostRecords(settings: MobileNetwork) {
  return Object.fromEntries(settings.hosts.flatMap(line => {
    const [ip, ...names] = line.split(/\s+/)
    return names.map(name => [name.toLowerCase(), ip] as const)
  }))
}

export function dnsConfiguration(settings: MobileNetwork, hosts: Record<string, unknown> = localHostRecords(settings)) {
  const hasHosts = Object.keys(hosts).length > 0
  const dns = {
    enable: true,
    ipv6: settings.ipv6 && settings.dnsIpv6,
    nameserver: settings.nameserver,
    'use-system-hosts': settings.useSystemHosts,
    'respect-rules': settings.respectRules,
    ...(settings.enhancedMode !== 'auto' && { 'enhanced-mode': settings.enhancedMode }),
    'fake-ip-range': '198.19.64.1/20',
    'fake-ip-filter': settings.fakeIpFilter.length ? settings.fakeIpFilter : ['+.lan', '+.local'],
    ...(settings.defaultNameserver.length > 0 && { 'default-nameserver': settings.defaultNameserver }),
    ...(settings.proxyServerNameserver.length > 0 && { 'proxy-server-nameserver': settings.proxyServerNameserver }),
    ...(settings.directNameserver.length > 0 && {
      'direct-nameserver': settings.directNameserver, 'direct-nameserver-follow-policy': settings.directFollowPolicy,
    }),
    ...(settings.dnsCacheAlgorithm !== 'auto' && { 'cache-algorithm': settings.dnsCacheAlgorithm }),
    ...(settings.domainDns.length > 0 && { 'nameserver-policy': Object.fromEntries(settings.domainDns.map(row => [row.domain, row.server])) }),
    ...(settings.fallback.length > 0 && { fallback: settings.fallback, 'fallback-filter': { geoip: false, domain: settings.fallbackDomains } }),
    ...(hasHosts && { 'use-hosts': true }),
  }
  return { dns, ...(hasHosts && { hosts }) }
}

export function configSource(network: MobileNetwork, routing: MobileRouting, monitoring: boolean) {
  return stringify({ network, routing, monitoring })
}

function map(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(name + ' 需要是一个键值配置')
  return value as Record<string, unknown>
}

function routeTarget(value: unknown, name: string): RouteTarget {
  const target = map(value, name)
  switch (target.kind) {
    case 'selected': case 'direct': case 'reject': case 'subscription':
      return { kind: target.kind }
    case 'group': case 'chain':
      if (typeof target.id === 'string' && target.id) return { kind: target.kind, id: target.id }
  }
  throw new Error(name + ' 的出站无效')
}

export function validateRouting(routing: MobileRouting) {
  if (routing.fallback.kind === 'subscription' && !routing.subscriptionId) throw new Error('请先选择订阅规则来源')
  for (const [index, rule] of routing.rules.entries()) {
    if (rule.enabled && !compileRule(rule, 'DIRECT')) throw new Error(`规则 ${index + 1} 的匹配值格式无效`)
  }
}

export function parseSettings(text: string) {
  if (new TextEncoder().encode(text).length > 1024 * 1024) throw new Error('配置文件超过 1 MB')
  const doc = parseDocument(text)
  if (doc.errors[0]) throw new Error(doc.errors[0].message)
  const source = map(doc.toJS({ maxAliasCount: 50 }), 'Air 配置')
  if (Object.keys(source).some(key => !['network', 'routing', 'monitoring'].includes(key))) throw new Error('Air 配置只支持 network、routing 和 monitoring')
  const rawNetwork = map(source.network ?? {}, 'network')
  for (const [key, value] of Object.entries(rawNetwork)) {
    if (!Object.hasOwn(defaultMobileNetwork, key)) throw new Error('未知网络配置项 · ' + key)
    const sample = defaultMobileNetwork[key as keyof MobileNetwork]
    if (key === 'domainDns') {
      if (!Array.isArray(value) || value.some(row => !row || typeof row.domain !== 'string' || typeof row.server !== 'string')) {
        throw new Error('domainDns 每项需要 domain 和 server')
      }
    } else if (Array.isArray(sample) ? !Array.isArray(value) || value.some(item => typeof item !== 'string')
      : sample === null ? value !== null && typeof value !== 'number' : typeof sample !== typeof value) {
      throw new Error('网络配置类型无效 · ' + key)
    }
  }
  const network = { ...defaultMobileNetwork, ...rawNetwork }
  const rawRouting = map(source.routing ?? {}, 'routing')
  if (rawRouting.subscriptionId != null && typeof rawRouting.subscriptionId !== 'string') throw new Error('subscriptionId 必须是订阅 ID')
  if (rawRouting.inheritRules != null && typeof rawRouting.inheritRules !== 'boolean') throw new Error('inheritRules 必须是布尔值')
  if (rawRouting.rules !== undefined && !Array.isArray(rawRouting.rules)) throw new Error('rules 需要是规则列表')
  const routing: MobileRouting = {
    subscriptionId: rawRouting.subscriptionId as string | null | undefined ?? null,
    inheritRules: rawRouting.inheritRules !== false,
    fallback: routeTarget(rawRouting.fallback ?? defaultRouting.fallback, '默认出口'),
    rules: (rawRouting.rules as unknown[] | undefined ?? []).map((value, index) => {
      const name = '规则 ' + (index + 1)
      const rule = map(value, name)
      if (typeof rule.enabled !== 'boolean' || typeof rule.value !== 'string' || !ruleMatchers.some(item => item.value === rule.matcher)) {
        throw new Error(name + ' 的格式无效')
      }
      return { enabled: rule.enabled, value: rule.value, matcher: rule.matcher as RuleMatcher, target: routeTarget(rule.target, name) }
    }),
  }
  if (source.monitoring != null && typeof source.monitoring !== 'boolean') throw new Error('monitoring 必须是布尔值')
  validateNetwork(network)
  validateRouting(routing)
  return { network, routing, monitoring: source.monitoring === true }
}
