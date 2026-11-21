import { parseDocument, stringify } from 'yaml'
import type { ProxyMode } from '@/shared/proxy/state'
import { compileRule, defaultMobileNetwork, defaultRouting, dnsConfiguration, ipPrefix, localHostRecords, type MobileNetwork, type MobileRouting, type RouteTarget } from './configuration'

import { repairSubscriptionNames, subscriptionLabel } from '@/shared/proxy/subscription-name'

export type Mode = ProxyMode
export type Theme = 'system' | 'light' | 'dark'
export type Policy = 'select' | 'url-test' | 'fallback' | 'load-balance'
export type Choice = { type: 'node' | 'group' | 'chain'; id: string }
export type Proxy = Record<string, unknown> & { name: string; type: string; server: string; port: number }

export interface Subscription {
  baseName?: string
  autoName?: boolean
  autoUpdate?: boolean
  intervalHours?: number
  customHours?: number | null
  attempted?: number
  refreshError?: string
  extension?: import('@/shared/proxy/subscription-extension').SubscriptionExtension
  extendedYaml?: string
  id: string
  name: string
  url?: string
  yaml: string
  original: string
  edited?: boolean
  updated: number
  usage?: string
}
export interface SubscriptionDownload {
  text: string
  profileTitle?: string
  usage?: string
  intervalHours?: number
}

export function remoteSubscriptionName(url: string, requested: string, sources: Subscription[], title?: string, previous?: Subscription) {
  const host = new URL(url).hostname
  const oldHost = previous?.url ? new URL(previous.url).hostname : undefined
  const oldBase = previous?.baseName ?? previous?.name
  const manual = requested.trim() || (previous && !(previous.autoName ?? (oldBase === oldHost)) ? oldBase : undefined)
  const base = manual || title || (host === oldHost && oldBase) || host
  return { ...subscriptionLabel(base, sources, previous), autoName: !manual }
}

export interface Node {
  id: string
  sourceId: string
  config: Proxy
}
export interface Group {
  id: string
  name: string
  type: Policy
  sourceId?: string
  automatic?: { sourceId: string; maxDelay: number; limit: number }
  members: string[]
}
export interface Chain { id: string; name: string; hops: string[] }
export interface ProbeSample { at: number; delay: number }
export interface Library {
  sources: Subscription[]
  nodes: Node[]
  groups: Group[]
  chains: Chain[]
  probes: Record<string, ProbeSample[]>
  edits: Record<string, Proxy>
  hiddenNodes: string[]
  choice?: Choice
  sourceFilter: string[]
  mode: Mode
  theme: Theme
  view: 'cards' | 'list'
  network: MobileNetwork
  routing: MobileRouting
  monitoring: boolean
}

export const defaultLibrary: Library = {
  sources: [], nodes: [], groups: [], chains: [], probes: {}, edits: {}, hiddenNodes: [], sourceFilter: [],
  mode: 'rule', theme: 'system', view: 'cards', network: defaultMobileNetwork, routing: defaultRouting, monitoring: false,
}

export function restoreLibrary(saved: Partial<Library> & {
  dnsServers?: string[]; dnsMode?: 'redir-host' | 'fake-ip'; ipv6?: boolean; probeUrl?: string; inheritSource?: string
}): Library {
  const { dnsServers, dnsMode, ipv6, probeUrl, inheritSource, network, routing, ...current } = saved
  const library: Library = {
    ...defaultLibrary,
    ...current,
    network: {
      ...defaultMobileNetwork,
      ...(dnsServers?.length && { nameserver: dnsServers }),
      ...(dnsMode && { enhancedMode: dnsMode }),
      ...(ipv6 !== undefined && { ipv6 }),
      ...(probeUrl && { probeUrl }),
      ...network,
    },
    routing: { ...defaultRouting, subscriptionId: inheritSource || null, ...routing },
  }
  const editedNodes = [...Object.keys(library.edits), ...library.hiddenNodes]
  library.sources = repairSubscriptionNames(library.sources).map(source => ({
    ...source, autoUpdate: Boolean(source.url) && (source.autoUpdate ??
      (!source.edited && !editedNodes.some(id => id.startsWith(source.id + '/')))),
  }))
  return { ...library, routing: reconcileRouting(library, readLibrary(library)) }
}

export type VpnStatus = {
  phase: 'idle' | 'starting' | 'running' | 'stopping' | 'error'
  error?: string; startedAt: number; port?: number
  traffic: { up?: number; down?: number }
  totals?: { up?: number; down?: number }
}
export type ExitInfo = { ip: string; country?: string; city?: string; region?: string; org?: string }
export type Connection = {
  id: string; upload: number; download: number; start: string; rule: string; rulePayload: string; chains: string[]
  closed?: boolean
  appName?: string
  appIcon?: string
  metadata: { host?: string; destinationIP?: string; destinationPort?: number | string; process?: string; processPath?: string; network?: string }
}

const protocols = new Set(['http', 'socks5', 'ss', 'ssr', 'vmess', 'vless', 'trojan', 'hysteria', 'hysteria2', 'tuic', 'anytls', 'snell', 'wireguard'])
const groupPolicies = new Set(['select', 'url-test', 'fallback', 'load-balance'])
const builtin = new Set(['DIRECT', 'REJECT', 'REJECT-DROP', 'PASS'])
const nodeFields = new Set(('name type server port ports mport udp udp-over-tcp udp-over-tcp-version ip-version tfo mptcp smux ' +
  'network uuid alterId alter-id cipher security flow packet-encoding xudp packet-addr global-padding ' +
  'authenticated-length tls servername sni skip-cert-verify fingerprint client-fingerprint alpn ech-opts reality-opts ' +
  'ws-opts grpc-opts h2-opts http-opts username password obfs obfs-password auth auth-str protocol protocol-param ' +
  'obfs-param up down up-speed down-speed initial-stream-receive-window max-stream-receive-window disable-mtu-discovery ' +
  'hop-interval heartbeat request-timeout reduce-rtt fast-open max-open-streams congestion-controller udp-relay-mode ' +
  'version plugin plugin-opts headers private-key public-key pre-shared-key ip ipv6 reserved mtu remote-dns-resolve ' +
  'dns allowed-ips peers amnezia-wg-option').split(' '))

export const id = () => crypto.randomUUID()
export const nodeLabel = (node: Node) => node.config.name
export const protocol = (node: Node) => node.config.type === 'http' && node.config.tls ? 'HTTPS' : node.config.type.toUpperCase()

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function subscriptionProbeTarget(profile: Record<string, unknown>) {
  const groups = profile['proxy-groups']
  if (!Array.isArray(groups)) return
  for (const item of groups) {
    const group = record(item)
    if (!['url-test', 'fallback', 'load-balance'].includes(String(group.type)) || typeof group.url !== 'string') continue
    let url: URL
    try { url = new URL(group.url) } catch { continue }
    if (url.protocol !== 'https:' || !url.hostname || url.username || url.password) continue
    const status = String(group['expected-status'] ?? '')
    const expected = /^\d+$/.test(status) && Number(status) >= 100 && Number(status) <= 599
      ? String(Number(status)) : url.pathname.endsWith('/generate_204') ? '204' : '200-299'
    return { url: url.href, expected }
  }
}

export function yamlProfile(text: string) {
  if (new TextEncoder().encode(text).length > 8 * 1024 * 1024) throw new Error('订阅文件超过 8 MB')
  const doc = parseDocument(text)
  if (doc.errors.length) throw new Error(doc.errors[0].message)
  const profile = record(doc.toJS({ maxAliasCount: 50 }))
  if (profile.hosts != null && (typeof profile.hosts !== 'object' || Array.isArray(profile.hosts))) {
    throw new Error('订阅 hosts 必须是域名到地址的映射')
  }
  if (!Array.isArray(profile.proxies) || profile.proxies.length === 0) throw new Error('未找到 Clash YAML 节点')
  const nodes: Proxy[] = []
  const names = new Set<string>()
  let skipped = 0
  for (const raw of profile.proxies) {
    const row = record(raw)
    const { name, type, server } = row
    const port = Number(row.port)
    if (typeof name !== 'string' || !name.trim() || typeof type !== 'string' || !protocols.has(type) ||
        typeof server !== 'string' || !server.trim() || !Number.isInteger(port) || port < 1 || port > 65535 || names.has(name)) {
      skipped++
      continue
    }
    names.add(name)
    const config = Object.fromEntries(Object.entries(row).filter(([key]) => nodeFields.has(key)))
    nodes.push({ ...config, name, type, server: server.trim(), port })
  }
  if (!nodes.length) throw new Error('这份订阅没有 Air 支持的节点')
  return { profile, nodes, skipped }
}

export function readLibrary(library: Library) {
  const profiles = new Map<string, ReturnType<typeof yamlProfile>>()
  const nodes: Node[] = [...library.nodes]
  const groups: Group[] = [...library.groups]
  for (const source of library.sources) {
    const parsed = yamlProfile(source.extendedYaml ?? source.yaml)
    profiles.set(source.id, parsed)
    const sourceNodes = parsed.nodes
      .map(config => ({ id: source.id + '/' + config.name, sourceId: source.id, config }))
      .filter(node => !library.hiddenNodes.includes(node.id))
    nodes.push(...sourceNodes.map(node => ({ ...node, config: library.edits[node.id] ?? node.config })))
    const imported = parsed.profile['proxy-groups']
    if (!Array.isArray(imported)) continue
    const groupRows = imported.map(record).filter(group => typeof group.name === 'string' && groupPolicies.has(String(group.type)))
    const names = new Map(groupRows.map(row => [row.name as string, row]))
    const valid = new Set(sourceNodes.map(node => node.config.name))
    const flatten = (name: string, seen: Set<string>): string[] => {
      if (valid.has(name)) return [source.id + '/' + name]
      if (seen.has(name)) return []
      const children = names.get(name)?.proxies
      if (!Array.isArray(children)) return []
      const next = new Set(seen).add(name)
      return [...new Set(children.filter((child): child is string => typeof child === 'string').flatMap(child => flatten(child, next)))]
    }
    for (const [name, group] of names) {
      const members = flatten(name, new Set())
      if (members.length) groups.push({ id: source.id + ':group:' + name, name, sourceId: source.id, type: group.type as Policy, members })
    }
  }
  return { profiles, nodes, groups }
}

export function stats(samples: ProbeSample[] | undefined) {
  const day = (samples ?? []).filter(sample => Date.now() - sample.at < 86_400_000)
  const good = day.filter(sample => sample.delay > 0)
  return {
    latest: day.at(-1)?.delay,
    average: good.length ? Math.round(good.reduce((sum, sample) => sum + sample.delay, 0) / good.length) : undefined,
    percent: day.length ? Math.round(100 * good.length / day.length) : undefined,
  }
}

export function membersOf(group: Group, model: ReturnType<typeof readLibrary>, library: Library): Node[] {
  const rule = group.automatic
  if (!rule) return group.members.flatMap(id => model.nodes.find(node => node.id === id) ?? [])
  return model.nodes.filter(node => {
    const delay = stats(library.probes[node.id]).latest
    return (!rule.sourceId || node.sourceId === rule.sourceId) && delay !== undefined && delay > 0 && delay <= rule.maxDelay
  }).sort((a, b) => (stats(library.probes[a.id]).latest ?? 0) - (stats(library.probes[b.id]).latest ?? 0)).slice(0, rule.limit)
}

function reconcileRouting(library: Library, model: ReturnType<typeof readLibrary>): MobileRouting {
  const { routing } = library
  const removedSource = routing.subscriptionId !== null && !model.profiles.has(routing.subscriptionId)
  const subscriptionId = removedSource ? null : routing.subscriptionId
  const groups = new Map(model.groups.map(group => [group.id, group]))
  const nodeIds = new Set(model.nodes.map(node => node.id))
  const chains = new Set(library.chains.filter(chain =>
    chain.hops.length >= 2 && chain.hops.every(id => nodeIds.has(id))).map(chain => chain.id))
  const reject: RouteTarget = { kind: 'reject' }

  function keepTarget(target: RouteTarget): RouteTarget {
    if (target.kind === 'subscription' && subscriptionId === null) return reject
    if (target.kind === 'chain' && !chains.has(target.id)) return reject
    if (target.kind === 'group') {
      const group = groups.get(target.id)
      if (!group) return reject
      if (group.automatic) {
        const source = group.automatic.sourceId
        if (source && !model.profiles.has(source)) return reject
      } else if (!group.members.some(id => nodeIds.has(id))) return reject
    }
    return target
  }

  return {
    subscriptionId, inheritRules: !removedSource && routing.inheritRules,
    fallback: keepTarget(routing.fallback),
    rules: routing.rules.map(rule => ({ ...rule, target: keepTarget(rule.target) })),
  }
}

export function withoutSubscription(library: Library, sourceId: string): Library {
  const localIds = new Set(library.nodes.filter(node => node.sourceId === sourceId).map(node => node.id))
  const keepNode = (id: string) => !localIds.has(id) && !id.startsWith(sourceId + '/')
  const next: Library = {
    ...library,
    sources: library.sources.filter(source => source.id !== sourceId),
    sourceFilter: library.sourceFilter.filter(id => id !== sourceId),
    nodes: library.nodes.filter(node => node.sourceId !== sourceId),
    groups: library.groups.filter(group => group.sourceId !== sourceId)
      .map(group => ({ ...group, members: group.members.filter(keepNode) })),
    edits: Object.fromEntries(Object.entries(library.edits).filter(([id]) => keepNode(id))),
    probes: Object.fromEntries(Object.entries(library.probes).filter(([id]) => keepNode(id))),
    hiddenNodes: library.hiddenNodes.filter(keepNode),
  }
  const model = readLibrary(next)
  return { ...next, routing: reconcileRouting(next, model), choice: selection(next, model) }
}

export function selection(library: Library, model: ReturnType<typeof readLibrary>) {
  const candidate = library.choice
  if (candidate?.type === 'node' && model.nodes.some(node => node.id === candidate.id)) return candidate
  if (candidate?.type === 'group' && model.groups.some(g => g.id === candidate.id && membersOf(g, model, library).length)) return candidate
  if (candidate?.type === 'chain' && library.chains.some(chain => chain.id === candidate.id &&
      chain.hops.length >= 2 && chain.hops.every(id => model.nodes.some(node => node.id === id)))) return candidate
  return model.nodes[0] ? { type: 'node' as const, id: model.nodes[0].id } : undefined
}

export function selectionName(choice: Choice | undefined, model: ReturnType<typeof readLibrary>, library: Library) {
  if (choice?.type === 'node') return model.nodes.find(node => node.id === choice.id)?.config.name
  if (choice?.type === 'group') return model.groups.find(group => group.id === choice.id)?.name
  if (choice?.type === 'chain') return library.chains.find(chain => chain.id === choice.id)?.name
  return undefined
}

const supportedRules = new Set(['DOMAIN', 'DOMAIN-SUFFIX', 'DOMAIN-KEYWORD', 'DOMAIN-REGEX', 'IP-CIDR', 'IP-CIDR6', 'GEOIP', 'GEOSITE', 'DST-PORT', 'NETWORK', 'PROCESS-NAME'])

export function compile(library: Library, model = readLibrary(library)) {
  const { network, routing } = library
  const byId = new Map<string, string>()
  const sourceTargets = new Map([...model.profiles].map(([id, parsed]) => [id, subscriptionProbeTarget(parsed.profile)]))
  const probeTargets: Record<string, { url: string; expected: string }> = {}
  const labels: Record<string, string> = { DIRECT: '直连', REJECT: '拒绝' }
  const proxies: Array<Record<string, unknown>> = model.nodes.map((node, i) => {
    const name = 'AirNode-' + (i + 1)
    byId.set(node.id, name)
    const target = sourceTargets.get(node.sourceId)
    if (target) probeTargets[name] = target
    labels[name] = node.config.name
    return { ...node.config, name }
  })
  const proxyGroups: Array<Record<string, unknown>> = []
  model.groups.forEach((group, i) => {
    const members = membersOf(group, model, library).map(node => byId.get(node.id)!)
    if (!members.length) return
    const name = 'AirGroup-' + (i + 1)
    byId.set(group.id, name)
    labels[name] = group.name
    proxyGroups.push({ name, type: group.type, proxies: members, url: network.probeUrl,
      'expected-status': String(network.probeStatus), interval: 300, lazy: true })
  })
  library.chains.forEach((chain, i) => {
    const nodes = chain.hops.map(id => model.nodes.find(node => node.id === id))
    if (nodes.length < 2 || nodes.some(node => !node)) return
    let dialer: string | undefined
    nodes.forEach((node, hop) => {
      const name = 'AirChain-' + (i + 1) + '-' + (hop + 1)
      proxies.push({ ...node!.config, name, ...(dialer ? { 'dialer-proxy': dialer } : {}) })
      labels[name] = node!.config.name
      dialer = name
    })
    if (dialer) byId.set(chain.id, dialer)
  })
  const choice = selection(library, model)
  const active = (choice && byId.get(choice.id)) ?? (library.mode === 'direct' ? 'DIRECT' : 'REJECT')
  proxyGroups.push({ name: 'GLOBAL', type: 'select', proxies: [active] })
  const subscriptionId = routing.subscriptionId ?? ''
  const source = model.profiles.get(subscriptionId)?.profile
  const lookup = new Map<string, string>()
  for (const node of model.nodes.filter(node => node.sourceId === subscriptionId)) {
    lookup.set(node.id.slice(node.sourceId.length + 1), byId.get(node.id)!)
  }
  for (const group of model.groups.filter(group => group.sourceId === subscriptionId)) {
    const name = byId.get(group.id)
    if (name) lookup.set(group.name, name)
  }
  const lookupPolicy = (policy: string) => lookup.get(policy) ?? (builtin.has(policy) ? policy : undefined)
  let subscriptionDefault: string | undefined
  const inherited: string[] = []
  if (Array.isArray(source?.rules)) {
    for (const entry of source.rules) {
      if (typeof entry !== 'string') continue
      const [type, key, policy, hint] = entry.split(',').map(part => part.trim())
      if (type === 'MATCH' && key) subscriptionDefault = lookupPolicy(key)
      if (!supportedRules.has(type) || !key || !policy) continue
      const target = lookupPolicy(policy)
      if (target) inherited.push([type, key, target, ...(hint === 'no-resolve' ? [hint] : [])].join(','))
    }
  }
  function routeTarget(target: RouteTarget): string {
    switch (target.kind) {
      case 'direct': return 'DIRECT'
      case 'reject': return 'REJECT'
      case 'subscription': return subscriptionDefault ?? active
      case 'group': case 'chain': return byId.get(target.id) ?? 'REJECT'
      case 'selected': return active
    }
  }
  const custom = routing.rules.map(rule => compileRule(rule, routeTarget(rule.target))).filter((rule): rule is string => Boolean(rule))
  const rules = [...custom, ...(routing.inheritRules ? inherited : []), 'MATCH,' + routeTarget(routing.fallback)]
  const localHosts = localHostRecords(network)
  const hostSources = new Map([...model.profiles].filter(([, parsed]) => Object.keys(record(parsed.profile.hosts)).length))
  const tables: { hosts: Record<string, unknown>; conflicts: string[] }[] = []
  const scopeIds = new Map<string, number>()
  const byProxy: Record<string, number> = {}
  function scope(sourceIds: string[]) {
    const ids = [...new Set(sourceIds.filter(id => hostSources.has(id)))].sort()
    const key = JSON.stringify(ids)
    const cached = scopeIds.get(key)
    if (cached !== undefined) return cached
    const hosts: Record<string, unknown> = Object.create(null)
    const conflicts = new Set<string>()
    for (const id of ids) {
      for (const [name, addresses] of Object.entries(record(hostSources.get(id)!.profile.hosts))) {
        const domain = name.toLowerCase()
        if (Object.hasOwn(hosts, domain) && JSON.stringify(hosts[domain]) !== JSON.stringify(addresses)) conflicts.add(domain)
        hosts[domain] = addresses
      }
    }
    const index = tables.push({ hosts, conflicts: [...conflicts] }) - 1
    scopeIds.set(key, index)
    return index
  }
  const emptyScope = scope([])
  const outboundSources = new Map<string, string[]>()
  if (hostSources.size) {
    const nodeSources = new Map(model.nodes.map(node => [node.id, node.sourceId]))
    for (const node of model.nodes) outboundSources.set(node.id, [node.sourceId])
    for (const group of model.groups) outboundSources.set(group.id,
      membersOf(group, model, library).map(node => node.sourceId).concat(group.sourceId ?? []))
    for (const chain of library.chains) outboundSources.set(chain.id, chain.hops.flatMap(id => nodeSources.get(id) ?? []))
    for (const [id, alias] of byId) {
      const index = scope(outboundSources.get(id) ?? [])
      if (index !== emptyScope) byProxy[alias] = index
    }
  }
  const usedSources = [subscriptionId, ...(choice ? outboundSources.get(choice.id) ?? [] : [])]
  for (const target of [routing.fallback, ...routing.rules.filter(rule => rule.enabled).map(rule => rule.target)]) {
    if ('id' in target) usedSources.push(...outboundSources.get(target.id) ?? [])
  }
  const activeScope = scope(usedSources)
  const config = {
    mode: library.mode,
    ipv6: network.ipv6,
    'tcp-concurrent': network.tcpConcurrent,
    'mixed-port': network.mixedPort ?? 0,
    'allow-lan': network.allowLan,
    'bind-address': network.allowLan ? '*' : '127.0.0.1',
    'find-process-mode': 'always',
    profile: { 'store-selected': false, 'store-fake-ip': false },
    proxies,
    'proxy-groups': proxyGroups,
    rules,
    ...dnsConfiguration(network, { ...tables[activeScope].hosts, ...localHosts }),
  }
  const tunnel = {
    stack: network.tunStack, mtu: network.tunMtu ?? 1400, dnsHijack: network.dnsHijack,
    exclusions: network.routeExcludeAddress.map(ipPrefix).filter((value): value is string => Boolean(value)),
  }
  return { plan: { config, ipv6: network.ipv6, tunnel, select: { GLOBAL: active }, localHosts, probeTargets,
    ...(hostSources.size > 0 && { hostScopes: { tables, byProxy, active: activeScope } }),
  }, byId, labels, choice }
}

export function canStart(library: Library, choice?: Choice) {
  if (choice || library.mode === 'direct') return true
  if (library.mode !== 'rule') return false
  return ['direct', 'reject'].includes(library.routing.fallback.kind)
    || library.routing.rules.some(rule => rule.enabled && ['direct', 'reject'].includes(rule.target.kind))
}

export function usage(source: Subscription) {
  const fields = new Map((source.usage ?? '').split(';').map(part => {
    const [key, value] = part.trim().split('=')
    return [key, Number(value)]
  }))
  const total = fields.get('total') ?? 0
  const used = (fields.get('download') ?? 0) + (fields.get('upload') ?? 0)
  const date = fields.get('expire') ?? 0
  return { total, used, expire: date > 0 ? date * 1000 : 0 }
}

export function bytes(value: number) {
  if (value < 1024) return value + ' B'
  if (value < 1024 ** 2) return (value / 1024).toFixed(1) + ' KB'
  if (value < 1024 ** 3) return (value / 1024 ** 2).toFixed(1) + ' MB'
  return (value / 1024 ** 3).toFixed(2) + ' GB'
}

export function formatDuration(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  return [Math.floor(seconds / 3600), Math.floor((seconds % 3600) / 60), seconds % 60].map(n => String(n).padStart(2, '0')).join(':')
}

export function effectiveYaml(library: Library, sourceId?: string) {
  if (!sourceId) return stringify(compile(library).plan.config)
  const routing: MobileRouting = { ...library.routing, subscriptionId: sourceId, inheritRules: true, fallback: { kind: 'subscription' } }
  return stringify(compile({ ...library, routing }).plan.config)
}
