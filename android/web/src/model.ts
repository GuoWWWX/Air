import { dropBinding, objectKey, resolveRules } from '@/shared/proxy/rule-library'
import { tr } from '@/shared/i18n/messages'
import { parseDocument, stringify } from 'yaml'
import type { ProxyMode } from '@/shared/proxy/state'
import { compileRule, defaultMobileNetwork, defaultRouting, dnsConfiguration, ipPrefix, localHostRecords, routingFallback, type MobileNetwork, type MobileRouting, type RouteTarget } from './configuration'

import { repairSubscriptionNames, subscriptionLabel } from '@/shared/proxy/subscription-name'

export type Mode = ProxyMode
export type Theme = 'system' | 'light' | 'dark'
export type Policy = 'select' | 'url-test' | 'fallback' | 'load-balance'
export type Choice = { type: 'node' | 'group' | 'chain'; id: string; groupId?: string }
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
export interface Chain { inheritExitRules?: boolean; id: string; name: string; hops: string[] }
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
  networkVersion?: number
  routing: MobileRouting
  monitoring: boolean
}

const mobileNetworkVersion = 3

export const defaultLibrary: Library = {
  sources: [], nodes: [], groups: [], chains: [], probes: {}, edits: {}, hiddenNodes: [], sourceFilter: [],
  mode: 'rule', theme: 'system', view: 'cards', network: defaultMobileNetwork, networkVersion: mobileNetworkVersion, routing: defaultRouting, monitoring: false,
}

export function restoreLibrary(saved: Partial<Library> & {
  dnsServers?: string[]; dnsMode?: 'redir-host' | 'fake-ip'; ipv6?: boolean; probeUrl?: string; inheritSource?: string
}): Library {
  const { dnsServers, dnsMode, ipv6, probeUrl, inheritSource, network, routing, ...current } = saved
  const mergedNetwork: MobileNetwork = {
    ...defaultMobileNetwork,
    ...(dnsServers?.length && { nameserver: dnsServers }),
    ...(dnsMode && { enhancedMode: dnsMode }),
    ...(ipv6 !== undefined && { ipv6 }),
    ...(probeUrl && { probeUrl }),
    ...network,
  }
  const legacyIpv6 = !saved.networkVersion && network?.tunStack === 'gvisor' && mergedNetwork.ipv6 && mergedNetwork.dnsIpv6
  const migrateStack = (saved.networkVersion ?? 0) < mobileNetworkVersion && mergedNetwork.tunStack === 'mixed'
  const resolvedNetwork: MobileNetwork = {
    ...mergedNetwork,
    ...(legacyIpv6 && { ipv6: false, dnsIpv6: false }),
    ...(migrateStack && { tunStack: defaultMobileNetwork.tunStack }),
  }
  const validSourceIds = new Set((current.sources ?? []).map(source => source.id))
  const resolvedSourceFilter =
    saved.sourceFilter === undefined
      ? (current.sources ?? []).map(source => source.id)
      : saved.sourceFilter.filter(id => validSourceIds.has(id))
  const library: Library = {
    ...defaultLibrary,
    ...current,
    sourceFilter: resolvedSourceFilter,
    networkVersion: mobileNetworkVersion,
    network: resolvedNetwork,
    routing: routing ? { ...(routing.ruleLibrary && { ruleLibrary: routing.ruleLibrary }), rules: routing.rules ?? [], fallback: routingFallback(routing, routing.fallback ?? defaultRouting.fallback) } : defaultRouting,
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
  upRate?: number; downRate?: number
  closed?: boolean
  firstSeenAt?: number
  closedAt?: number
  appName?: string
  appIcon?: string
  metadata: { host?: string; destinationIP?: string; destinationPort?: number | string; process?: string; processPath?: string; network?: string }
}

const protocols = new Set(['http', 'socks5', 'ss', 'ssr', 'vmess', 'vless', 'trojan', 'hysteria', 'hysteria2', 'tuic', 'anytls', 'snell', 'wireguard'])
const groupPolicies = new Set(['select', 'url-test', 'fallback', 'load-balance'])
const builtin = new Set(['DIRECT', 'REJECT', 'REJECT-DROP', 'PASS'])
const nodeFields = new Set(('name type server port ports mport udp udp-over-tcp udp-over-tcp-version ip-version tfo mptcp mux smux ' +
  'network uuid alterId alter-id cipher security flow packet-encoding xudp packet-addr global-padding ' +
  'authenticated-length tls servername sni skip-cert-verify fingerprint client-fingerprint alpn ech-opts reality-opts ' +
  'ws-opts grpc-opts h2-opts http-opts username password obfs obfs-password auth auth-str protocol protocol-param ' +
  'obfs-param up down up-speed down-speed initial-stream-receive-window max-stream-receive-window ' +
  'initial-connection-receive-window max-connection-receive-window disable-mtu-discovery hop-interval heartbeat ' +
  'request-timeout reduce-rtt fast-open max-open-streams congestion-controller udp-relay-mode ' +
  'idle-session-check-interval idle-session-timeout min-idle-session version plugin plugin-opts headers private-key ' +
  'public-key pre-shared-key ip ipv6 reserved mtu remote-dns-resolve dns allowed-ips peers amnezia-wg-option').split(' '))

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
  if (new TextEncoder().encode(text).length > 8 * 1024 * 1024) throw new Error(tr('订阅文件超过 8 MB'))
  const doc = parseDocument(text)
  if (doc.errors.length) throw new Error(doc.errors[0].message)
  const profile = record(doc.toJS({ maxAliasCount: 50 }))
  if (profile.hosts != null && (typeof profile.hosts !== 'object' || Array.isArray(profile.hosts))) {
    throw new Error(tr('订阅 hosts 必须是域名到地址的映射'))
  }
  if (!Array.isArray(profile.proxies) || profile.proxies.length === 0) throw new Error(tr('未找到 Clash YAML 节点'))
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
  if (!nodes.length) throw new Error(tr('这份订阅没有 Air 支持的节点'))
  return { profile, nodes, skipped }
}

const parsedSubscriptions = new WeakMap<Subscription, ReturnType<typeof yamlProfile>>()

export function readLibrary(library: Library) {
  const profiles = new Map<string, ReturnType<typeof yamlProfile>>()
  const nodes: Node[] = [...library.nodes]
  const groups: Group[] = [...library.groups]
  for (const source of library.sources) {
    let parsed = parsedSubscriptions.get(source)
    if (!parsed) {
      parsed = yamlProfile(source.extendedYaml ?? source.yaml)
      parsedSubscriptions.set(source, parsed)
    }
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
    const defaultBuiltinPolicy = (name: string, seen = new Set<string>()): string | undefined => {
      if (builtin.has(name)) return name
      const row = names.get(name)
      if (!row || seen.has(name) || !Array.isArray(row.proxies)) return
      const next = new Set(seen).add(name)
      const first = row.proxies.find((child): child is string => typeof child === 'string' && Boolean(child.trim()))?.trim()
      if (!first) return
      if (builtin.has(first)) return first
      return defaultBuiltinPolicy(first, next)
    }
    for (const [name, group] of names) {
      if (defaultBuiltinPolicy(name)) continue
      const members = flatten(name, new Set())
      if (members.length) groups.push({ id: source.id + ':group:' + name, name, sourceId: source.id, type: group.type as Policy, members })
    }
  }
  return { profiles, nodes, groups, nodesById: new Map(nodes.map(node => [node.id, node])) }
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
  if (!rule) return group.members.flatMap(id => model.nodesById.get(id) ?? [])
  return model.nodes.filter(node => {
    const delay = stats(library.probes[node.id]).latest
    return (!rule.sourceId || node.sourceId === rule.sourceId) && delay !== undefined && delay > 0 && delay <= rule.maxDelay
  }).sort((a, b) => (stats(library.probes[a.id]).latest ?? 0) - (stats(library.probes[b.id]).latest ?? 0)).slice(0, rule.limit)
}

function reconcileRouting(library: Library, model: ReturnType<typeof readLibrary>): MobileRouting {
  const { routing } = library
  const groups = new Map(model.groups.map(group => [group.id, group]))
  const nodeIds = new Set(model.nodes.map(node => node.id))
  const chains = new Set(library.chains.filter(chain =>
    chain.hops.length >= 2 && chain.hops.every(id => nodeIds.has(id))).map(chain => chain.id))
  const reject: RouteTarget = { kind: 'reject' }

  function keepTarget(target: RouteTarget): RouteTarget {
    if (target.kind === 'node' && !nodeIds.has(target.id)) return reject
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
    ...routing,
    fallback: keepTarget(routing.fallback).kind === 'reject' && routing.fallback.kind !== 'reject' ? defaultRouting.fallback : keepTarget(routing.fallback),
    rules: routing.rules.map(rule => ({ ...rule, target: keepTarget(rule.target) })),
  }
}

export function withoutSubscription(library: Library, sourceId: string): Library {
  const localIds = new Set(library.nodes.filter(node => node.sourceId === sourceId).map(node => node.id))
  const keepNode = (id: string) => !localIds.has(id) && !id.startsWith(sourceId + '/')
  const next: Library = {
    ...library,
    routing: library.routing.ruleLibrary ? { ...library.routing,
      ruleLibrary: dropBinding(library.routing.ruleLibrary, 'subscription:' + sourceId, 'subscription:' + sourceId) } : library.routing,
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

const supportedRules = new Set([
  'DOMAIN', 'DOMAIN-SUFFIX', 'DOMAIN-KEYWORD', 'DOMAIN-WILDCARD', 'DOMAIN-REGEX',
  'IP-CIDR', 'IP-CIDR6', 'IP-ASN', 'SRC-IP-CIDR',
  'GEOIP', 'GEOSITE',
  'DST-PORT', 'SRC-PORT', 'IN-TYPE', 'IN-PORT', 'NETWORK',
  'PROCESS-NAME', 'PROCESS-NAME-REGEX', 'PROCESS-PATH', 'PROCESS-PATH-REGEX',
])

function parseSubscriptionRule(entry: string) {
  const trimmed = entry.trim()
  if (!trimmed) return
  if (/^MATCH\s*,/i.test(trimmed)) {
    const [, policy = ''] = trimmed.split(',').map(part => part.trim())
    return { kind: 'match' as const, policy }
  }
  const composite = trimmed.match(/^(AND|OR|NOT)\s*,\s*(\(.+\))\s*,\s*([^,]+)$/i)
  if (composite) {
    return {
      kind: 'composite' as const,
      type: composite[1].toUpperCase(),
      expr: composite[2].trim(),
      policy: composite[3].trim(),
    }
  }
  const parts = trimmed.split(',').map(part => part.trim())
  const [rawType = '', key = '', policy = '', ...rest] = parts
  const type = rawType.toUpperCase()
  const hints = rest.filter(item => item === 'no-resolve' || item === 'src')
  return { kind: 'standard' as const, type, key, policy, hints }
}

function compileRuleProvider(value: unknown, lookupPolicy: (policy: string) => string | undefined) {
  const { type, behavior, format, interval, url, payload, proxy } = record(value)
  if (behavior !== 'domain' && behavior !== 'ipcidr' && behavior !== 'classical') return
  if (type === 'inline') {
    if (!Array.isArray(payload) || !payload.every(rule => typeof rule === 'string')) return
    return { type, behavior, payload }
  }
  if (type !== 'http' || typeof url !== 'string') return
  if (format != null && format !== 'yaml' && format !== 'text' && format !== 'mrs') return
  if (format === 'mrs' && behavior === 'classical') return
  let address: URL
  try { address = new URL(url) } catch { return }
  if (!['https:', 'http:'].includes(address.protocol) || !address.hostname || address.username || address.password) return
  const outbound = typeof proxy === 'string' && proxy.trim() ? lookupPolicy(proxy.trim()) : undefined
  if (proxy && !outbound) return
  // Mihomo derives the cache path from the URL. A subscription cannot supply a local path.
  return {
    type, behavior, url: address.href,
    ...(format && { format }),
    ...(typeof interval === 'number' && Number.isSafeInteger(interval) && interval >= 0 && { interval }),
    ...(outbound && { proxy: outbound }),
  }
}

export function ruleSourceId(library: Library, model: ReturnType<typeof readLibrary>, choice = selection(library, model)) {
  let sourceId: string | undefined
  if (choice?.type === 'node') sourceId = model.nodesById.get(choice.id)?.sourceId
  if (choice?.type === 'chain') {
    const exit = library.chains.find(chain => chain.id === choice.id)?.hops.at(-1)
    if (exit) sourceId = model.nodesById.get(exit)?.sourceId
  }
  if (choice?.type === 'group') {
    const group = model.groups.find(item => item.id === choice.id)
    if (group) {
      sourceId = group.sourceId || group.automatic?.sourceId
      if (!sourceId) {
        const sources = new Set(membersOf(group, model, library).map(node => node.sourceId))
        if (sources.size === 1) sourceId = [...sources][0]
      }
    }
  }
  return sourceId && model.profiles.has(sourceId) ? sourceId : ''
}

export function resolvedRuleSet(library: Library, model = readLibrary(library), choice: Choice | undefined = selection(library, model)) {
  const source = ruleSourceId(library, model, choice)
  const chain = choice?.type === 'chain' && library.chains.find(item => item.id === choice.id)
  const owner = chain && chain.inheritExitRules === false ? '' : source
  const keys = choice ? [objectKey(choice.type, choice.id)] : []
  if (choice?.type === 'node' && choice.groupId && library.groups.some(group => group.id === choice.groupId && membersOf(group, model, library).some(node => node.id === choice.id))) keys.push(objectKey('group', choice.groupId))
  if (owner) keys.push(objectKey('subscription', owner))
  return resolveRules(library.routing.ruleLibrary, keys, owner)
}

export function compile(library: Library, model = readLibrary(library), previewSourceId?: string) {
  const { network, routing } = library
  const byId = new Map<string, string>()
  const sourceTargets = new Map([...model.profiles].map(([id, parsed]) => [id, subscriptionProbeTarget(parsed.profile)]))
  const probeTargets: Record<string, { url: string; expected: string }> = {}
  const labels: Record<string, string> = { get DIRECT() { return tr('直连') }, get REJECT() { return tr('拒绝') } }
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
    const nodes = chain.hops.map(id => model.nodesById.get(id))
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
  // Rule targets and the selector's members stay fixed when the chosen exit changes.
  proxyGroups.push({ name: 'GLOBAL', type: 'select', proxies: [...byId.values(), 'DIRECT', 'REJECT'] })
  const reference = previewSourceId ? resolveRules(routing.ruleLibrary, ['subscription:' + previewSourceId], previewSourceId) : resolvedRuleSet(library, model, choice)
  const effectiveSubscriptionId = reference.startsWith('subscription:') ? reference.slice(13) : ''
  const userSet = reference.startsWith('user:') ? routing.ruleLibrary?.sets.find(set => set.id === reference.slice(5)) : undefined
  const source = userSet?.profile ?? model.profiles.get(effectiveSubscriptionId)?.profile
  const nodeLookup = new Map<string, string>()
  for (const node of model.nodes.filter(node => node.sourceId === effectiveSubscriptionId)) {
    nodeLookup.set(node.id.slice(effectiveSubscriptionId.length + 1), byId.get(node.id)!)
  }
  const groupLookup = new Map<string, string>()
  for (const group of model.groups.filter(group => group.sourceId === effectiveSubscriptionId)) {
    const name = byId.get(group.id)
    if (name) groupLookup.set(group.name, name)
  }
  const rawGroups = new Map<string, { type?: unknown; proxies?: unknown }>()
  if (Array.isArray(source?.['proxy-groups'])) {
    for (const item of source['proxy-groups']) {
      const group = record(item)
      if (typeof group.name === 'string') rawGroups.set(group.name, group)
    }
  }
  const lookupPolicy = (policy: string, seen = new Set<string>()): string | undefined => {
    const name = policy.trim()
    if (!name) return
    if (builtin.has(name)) return name
    if (nodeLookup.has(name)) return nodeLookup.get(name)
    const raw = rawGroups.get(name)
    if (raw && !seen.has(name)) {
      const nextSeen = new Set(seen).add(name)
      const members = Array.isArray(raw.proxies)
        ? raw.proxies.filter((p): p is string => typeof p === 'string').map(p => p.trim()).filter(Boolean)
        : []
      const first = members[0]
      if (first === 'DIRECT') return 'DIRECT'
      if (first === 'REJECT' || first === 'REJECT-DROP') return first
      if (first && rawGroups.has(first)) {
        const nested = lookupPolicy(first, nextSeen)
        if (nested === 'DIRECT' || nested === 'REJECT' || nested === 'REJECT-DROP') return nested
      }
      if (raw.type === 'select') return choice ? 'GLOBAL' : (groupLookup.get(name) ?? 'GLOBAL')
      return groupLookup.get(name) ?? 'GLOBAL'
    }
    return groupLookup.get(name) ?? (name === 'GLOBAL' || userSet ? 'GLOBAL' : undefined)
  }
  let subscriptionDefault: string | undefined
  const inherited: string[] = []
  const providers = new Map<string, NonNullable<ReturnType<typeof compileRuleProvider>>>()
  const sourceProviders = record(source?.['rule-providers'])
  if (Array.isArray(source?.rules)) {
    for (const entry of source.rules) {
      if (typeof entry !== 'string') continue
      const parsed = parseSubscriptionRule(entry)
      if (!parsed) continue
      if (parsed.kind === 'match') {
        subscriptionDefault = parsed.policy ? lookupPolicy(parsed.policy) : undefined
        break
      }
      const target = lookupPolicy(parsed.policy)
      if (!target) continue
      if (parsed.kind === 'composite') {
        inherited.push(`${parsed.type},${parsed.expr},${target}`)
        continue
      }
      const { type, key, hints } = parsed
      if (!key) continue
      if (type === 'RULE-SET') {
        if (!providers.has(key)) {
          const provider = Object.hasOwn(sourceProviders, key) ? compileRuleProvider(sourceProviders[key], lookupPolicy) : undefined
          if (!provider) continue
          providers.set(key, provider)
        }
      } else if (!supportedRules.has(type)) continue
      inherited.push([type, key, target, ...hints].join(','))
    }
  }
  function routeTarget(target: RouteTarget): string {
    switch (target.kind) {
      case 'direct': return 'DIRECT'
      case 'reject': return 'REJECT'
      case 'subscription': return subscriptionDefault ?? 'GLOBAL'
      case 'node': case 'group': case 'chain': return byId.get(target.id) ?? 'REJECT'
      case 'selected': return 'GLOBAL'
    }
  }
  const custom = routing.rules.map(rule => compileRule(rule, routeTarget(rule.target))).filter((rule): rule is string => Boolean(rule))
  const domesticFallback =
    !subscriptionDefault && inherited.length === 0
      ? ['GEOSITE,cn,DIRECT', 'GEOIP,CN,DIRECT,no-resolve']
      : []
  const quicRule = network.blockQuic
    ? ['AND,((NETWORK,UDP),(DST-PORT,443),(NOT,((GEOSITE,cn))),(NOT,((GEOIP,CN,no-resolve)))),REJECT']
    : []
  const rules = [
    ...custom,
    'GEOIP,private,DIRECT,no-resolve',
    'GEOSITE,private,DIRECT',
    ...quicRule,
    ...inherited,
    ...domesticFallback,
    'MATCH,' + routeTarget(routing.fallback),
  ]
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
  const usedSources = [effectiveSubscriptionId, ...(choice ? outboundSources.get(choice.id) ?? [] : [])]
  for (const target of [routing.fallback, ...routing.rules.filter(rule => rule.enabled).map(rule => rule.target)]) {
    if ('id' in target) usedSources.push(...outboundSources.get(target.id) ?? [])
  }
  const activeScope = scope(usedSources)
  const config = {
    mode: library.mode,
    ipv6: network.ipv6,
    'tcp-concurrent': network.tcpConcurrent,
    'unified-delay': true,
    'keep-alive-idle': 600,
    'keep-alive-interval': 15,
    'disable-keep-alive': false,
    'mixed-port': network.mixedPort ?? 0,
    'allow-lan': network.allowLan,
    'bind-address': network.allowLan ? '*' : '127.0.0.1',
    'find-process-mode': 'always',
    profile: { 'store-selected': false, 'store-fake-ip': false },
    sniffer: {
      enable: true,
      'force-dns-mapping': true,
      'parse-pure-ip': false,
      'override-destination': false,
      sniff: {
        HTTP: { ports: [80, '8080-8880'], 'override-destination': false },
        TLS: { ports: [443, 8443] },
        QUIC: { ports: [443, 8443] },
      },
      'skip-domain': ['Mijia Cloud', '+.push.apple.com', '+.lan', '+.local', '+.localdomain'],
    },
    proxies,
    'proxy-groups': proxyGroups,
    rules,
    ...(providers.size > 0 && { 'rule-providers': Object.fromEntries(providers) }),
    ...dnsConfiguration(network, { ...tables[activeScope].hosts, ...localHosts }),
  }
  const tunnel = {
    stack: network.tunStack, mtu: network.tunMtu ?? 9000, dnsHijack: network.dnsHijack,
    exclusions: network.routeExcludeAddress.map(ipPrefix).filter((value): value is string => Boolean(value)),
  }
  return { plan: { config, ipv6: network.ipv6, tunnel, select: { GLOBAL: active }, localHosts, probeTargets,
    outboundLabel: library.mode === 'direct' ? '' : (selectionName(choice, model, library) ?? ''),
    ...(hostSources.size > 0 && { hostScopes: { tables, byProxy, active: activeScope } }),
  }, byId, labels, choice, ruleSourceId: effectiveSubscriptionId, ruleReference: reference }
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
  const model = readLibrary(library)
  if (ruleSourceId(library, model) === sourceId) return stringify(compile(library, model).plan.config)
  const node = model.nodes.find(item => item.sourceId === sourceId)
  const preview = node ? { ...library, choice: { type: 'node' as const, id: node.id } } : library
  return stringify(compile(preview, model, sourceId).plan.config)
}
