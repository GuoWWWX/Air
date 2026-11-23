import { resolveRules } from '@/shared/proxy/rule-library'
import { subscriptionLabel } from '@/shared/proxy/subscription-name'
import type {
  CustomGroup,
  CustomGroupInput,
  CustomNodeInput,
  ExitVerification,
  GroupEdit,
  ImportInput,
  ImportPreview,
  Library,
  NodeMetrics,
  NodeRecord,
  Progress,
  ProxyAction,
  ProxyConnection,
  ProxyExit,
  ProxyStatus,
  ProxyTarget,
  ProxyTelemetry,
  RoutingConfig,
  RoutingDocument,
  SubscriptionGroup,
  SubscriptionSource,
  StartupSettings,
} from './air'

import type { NetworkSettings } from '@/shared/proxy/network'
const previewConfig = () => import('./previewConfig')

interface DemoNodeState {
  record: NodeRecord
  baseMs: number
  jitter: number
  username: string
  password: string
  originalName: string
  originalServer: string
  originalPort: number
}

const now = Date.now()
const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

function randomInt(min: number, max: number) {
  return Math.floor(Math.random() * (max - min + 1)) + min
}

function sleep(ms: number) {
  return new Promise<void>(resolve => {
    window.setTimeout(resolve, ms)
  })
}

function makeSubAYaml() {
  return `mixed-port: 7897
allow-lan: false
mode: rule
proxies:
  - { name: 香港 BGP 01, type: anytls, server: hk01.speedcloud.example, port: 443 }
  - { name: 香港 IEPL 07, type: vless, server: hk07.speedcloud.example, port: 8443 }
  - { name: 东京品川 03, type: vless, server: jp03.speedcloud.example, port: 443 }
  - { name: 新加坡狮城 02, type: trojan, server: sg02.speedcloud.example, port: 443 }
  - { name: 英国伦敦 04, type: hysteria2, server: uk04.speedcloud.example, port: 8443 }
proxy-groups:
  - name: 香港节点
    type: url-test
    proxies: [香港 BGP 01, 香港 IEPL 07]
  - name: 亚太日常
    type: select
    proxies: [香港 BGP 01, 东京品川 03, 新加坡狮城 02]
rules:
  - DOMAIN-SUFFIX,github.com,亚太日常
  - MATCH,亚太日常
`
}

function makeSubBYaml() {
  return `proxies:
  - { name: 美国圣何塞 01, type: vless, server: sjc01.globalnet.example, port: 443 }
  - { name: 美国洛杉矶 02, type: trojan, server: lax02.globalnet.example, port: 443 }
  - { name: 德国法兰克福 05, type: shadowsocks, server: fra05.globalnet.example, port: 8388 }
proxy-groups:
  - name: 美洲出口
    type: fallback
    proxies: [美国圣何塞 01, 美国洛杉矶 02]
`
}

function createInitialState() {
  const sources: (SubscriptionSource & { baseName?: string; autoName?: boolean })[] = [
    {
      id: 'sub-a',
      name: '极速云 · 主力订阅',
      nodes: 5,
      groups: 2,
      details: {
        kind: 'url',
        updatedAt: now - 18 * MIN,
        refreshError: null,
        usage: {
          upload: Math.round(38.4 * 1024 ** 3),
          download: Math.round(122.6 * 1024 ** 3),
          total: 500 * 1024 ** 3,
          expire: Math.floor((now + 180 * DAY) / 1000),
        },
      },
    },
    {
      id: 'sub-b',
      name: 'GlobalNet · 备用线路',
      nodes: 3,
      groups: 1,
      details: {
        kind: 'url',
        updatedAt: now - 2 * HOUR,
        refreshError: null,
        usage: {
          upload: Math.round(12.2 * 1024 ** 3),
          download: Math.round(52.9 * 1024 ** 3),
          total: 200 * 1024 ** 3,
          expire: Math.floor((now + 45 * DAY) / 1000),
        },
      },
    },
    {
      id: 'custom',
      name: '自定义',
      nodes: 2,
      groups: 0,
      details: {
        kind: 'custom',
        updatedAt: now - 5 * HOUR,
        refreshError: null,
      },
    },
  ]

  const nodes: DemoNodeState[] = [
    {
      record: {
        id: 'demo-hk-01',
        sourceId: 'sub-a',
        source: '极速云 · 主力订阅',
        name: '香港 BGP 01',
        protocol: 'AnyTLS',
        server: 'hk01.speedcloud.example',
        port: 443,
        status: 'available',
        latestMs: 42,
        averageMs: 46,
        availability: 0.998,
        continuousMs: 3 * DAY + 6 * HOUR,
      },
      baseMs: 45,
      jitter: 14,
      username: '',
      password: '',
      originalName: '香港 BGP 01',
      originalServer: 'hk01.speedcloud.example',
      originalPort: 443,
    },
    {
      record: {
        id: 'demo-hk-07',
        sourceId: 'sub-a',
        source: '极速云 · 主力订阅',
        name: '香港 IEPL 07',
        protocol: 'VLESS',
        server: 'hk07.speedcloud.example',
        port: 8443,
        status: 'available',
        latestMs: 68,
        averageMs: 72,
        availability: 0.996,
        continuousMs: DAY + 18 * HOUR,
      },
      baseMs: 68,
      jitter: 16,
      username: '',
      password: '',
      originalName: '香港 IEPL 07',
      originalServer: 'hk07.speedcloud.example',
      originalPort: 8443,
    },
    {
      record: {
        id: 'demo-jp-03',
        sourceId: 'sub-a',
        source: '极速云 · 主力订阅',
        name: '东京品川 03',
        protocol: 'VLESS',
        server: 'jp03.speedcloud.example',
        port: 443,
        status: 'available',
        latestMs: 96,
        averageMs: 104,
        availability: 0.992,
        continuousMs: 16 * HOUR,
      },
      baseMs: 98,
      jitter: 18,
      username: '',
      password: '',
      originalName: '东京品川 03',
      originalServer: 'jp03.speedcloud.example',
      originalPort: 443,
    },
    {
      record: {
        id: 'demo-sg-02',
        sourceId: 'sub-a',
        source: '极速云 · 主力订阅',
        name: '新加坡狮城 02',
        protocol: 'Trojan',
        server: 'sg02.speedcloud.example',
        port: 443,
        status: 'available',
        latestMs: 128,
        averageMs: 135,
        availability: 0.985,
        continuousMs: 2 * DAY + 2 * HOUR,
      },
      baseMs: 130,
      jitter: 20,
      username: '',
      password: '',
      originalName: '新加坡狮城 02',
      originalServer: 'sg02.speedcloud.example',
      originalPort: 443,
    },
    {
      record: {
        id: 'demo-uk-04',
        sourceId: 'sub-a',
        source: '极速云 · 主力订阅',
        name: '英国伦敦 04',
        protocol: 'Hysteria2',
        server: 'uk04.speedcloud.example',
        port: 8443,
        status: 'available',
        latestMs: 640,
        averageMs: 615,
        availability: 0.942,
        continuousMs: 5 * HOUR,
      },
      baseMs: 610,
      jitter: 80,
      username: '',
      password: '',
      originalName: '英国伦敦 04',
      originalServer: 'uk04.speedcloud.example',
      originalPort: 8443,
    },
    {
      record: {
        id: 'demo-us-sjc',
        sourceId: 'sub-b',
        source: 'GlobalNet · 备用线路',
        name: '美国圣何塞 01',
        protocol: 'VLESS',
        server: 'sjc01.globalnet.example',
        port: 443,
        status: 'available',
        latestMs: 148,
        averageMs: 154,
        availability: 1,
        continuousMs: 2 * DAY + 12 * HOUR,
      },
      baseMs: 150,
      jitter: 22,
      username: '',
      password: '',
      originalName: '美国圣何塞 01',
      originalServer: 'sjc01.globalnet.example',
      originalPort: 443,
    },
    {
      record: {
        id: 'demo-us-lax',
        sourceId: 'sub-b',
        source: 'GlobalNet · 备用线路',
        name: '美国洛杉矶 02',
        protocol: 'Trojan',
        server: 'lax02.globalnet.example',
        port: 443,
        status: 'available',
        latestMs: 165,
        averageMs: 172,
        availability: 0.988,
        continuousMs: 14 * HOUR,
      },
      baseMs: 168,
      jitter: 24,
      username: '',
      password: '',
      originalName: '美国洛杉矶 02',
      originalServer: 'lax02.globalnet.example',
      originalPort: 443,
    },
    {
      record: {
        id: 'demo-de-05',
        sourceId: 'sub-b',
        source: 'GlobalNet · 备用线路',
        name: '德国法兰克福 05',
        protocol: 'Shadowsocks',
        server: 'fra05.globalnet.example',
        port: 8388,
        status: 'timeout',
        latestMs: null,
        averageMs: 286,
        availability: 0.765,
        continuousMs: null,
      },
      baseMs: 245,
      jitter: 48,
      username: '',
      password: '',
      originalName: '德国法兰克福 05',
      originalServer: 'fra05.globalnet.example',
      originalPort: 8388,
    },
    {
      record: {
        id: 'demo-custom-us',
        sourceId: 'custom',
        source: '自定义',
        name: '美国住宅 · AT&T',
        protocol: 'https',
        server: 'att-home.example.net',
        port: 8443,
        status: 'available',
        latestMs: 182,
        averageMs: 188,
        availability: 0.991,
        continuousMs: DAY + 4 * HOUR,
      },
      baseMs: 184,
      jitter: 24,
      username: 'air-demo',
      password: 'demo-password',
      originalName: '美国住宅 · AT&T',
      originalServer: 'att-home.example.net',
      originalPort: 8443,
    },
    {
      record: {
        id: 'demo-custom-jp',
        sourceId: 'custom',
        source: '自定义',
        name: '日本静态独享',
        protocol: 'socks5',
        server: 'jp-static.example.net',
        port: 1080,
        status: null,
        latestMs: null,
        averageMs: null,
        availability: null,
        continuousMs: null,
      },
      baseMs: 112,
      jitter: 18,
      username: 'jp-user',
      password: 'jp-password',
      originalName: '日本静态独享',
      originalServer: 'jp-static.example.net',
      originalPort: 1080,
    },
  ]

  const groups: SubscriptionGroup[] = [
    {
      sourceId: 'sub-a',
      name: '香港节点',
      strategy: 'url-test',
      members: ['demo-hk-01', 'demo-hk-07'],
      memberNames: ['香港 BGP 01', '香港 IEPL 07'],
    },
    {
      sourceId: 'sub-a',
      name: '亚太日常',
      strategy: 'select',
      members: ['demo-hk-01', 'demo-jp-03', 'demo-sg-02'],
      memberNames: ['香港 BGP 01', '东京品川 03', '新加坡狮城 02'],
    },
    {
      sourceId: 'sub-b',
      name: '美洲出口',
      strategy: 'fallback',
      members: ['demo-us-sjc', 'demo-us-lax'],
      memberNames: ['美国圣何塞 01', '美国洛杉矶 02'],
    },
  ]

  const urls: Record<string, string> = {
    'sub-a': 'https://sub.speedcloud.example/api/v1/client/subscribe?token=demo',
    'sub-b': 'https://portal.globalnet.example/clash/config.yaml',
  }

  const yamls: Record<string, { original: string; local: string | null }> = {
    'sub-a': { original: makeSubAYaml(), local: null },
    'sub-b': { original: makeSubBYaml(), local: null },
  }

  return { sources, nodes, groups, urls, yamls }
}

import { emptyExtension, extendSubscription, type SubscriptionExtension } from '@/shared/proxy/subscription-extension'
const extensions = new Map<string, SubscriptionExtension>()
const state = createInitialState()

const CUSTOM_GROUPS_STORAGE_KEY = 'air.demoCustomGroups'

const defaultDemoCustomGroups: CustomGroup[] = [
  {
    id: 'cg-demo-low-latency',
    name: '常用低延迟',
    members: ['demo-hk-01', 'demo-jp-03', 'demo-custom-jp'],
  },
]

function loadDemoCustomGroups(): CustomGroup[] {
  try {
    const raw = localStorage.getItem(CUSTOM_GROUPS_STORAGE_KEY)
    if (!raw) return defaultDemoCustomGroups.map(group => ({ ...group, members: [...group.members] }))
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (item): item is CustomGroup =>
        Boolean(item) &&
        typeof item === 'object' &&
        typeof (item as CustomGroup).id === 'string' &&
        typeof (item as CustomGroup).name === 'string' &&
        Array.isArray((item as CustomGroup).members),
    )
  } catch {
    return defaultDemoCustomGroups.map(group => ({ ...group, members: [...group.members] }))
  }
}

function saveDemoCustomGroups(groups: CustomGroup[]) {
  try {
    localStorage.setItem(CUSTOM_GROUPS_STORAGE_KEY, JSON.stringify(groups))
  } catch {
    /* Ignore storage quota issues in preview. */
  }
}

let customGroupsState: CustomGroup[] = loadDemoCustomGroups()

let progress: Progress = {
  running: false,
  batchId: 0,
  activeIds: [],
  completedIds: [],
  total: 0,
  completed: 0,
  available: 0,
  timeouts: 0,
  failed: 0,
  error: null,
}

let proxyState: ProxyStatus = {
  running: false,
  mode: 'rule',
  port: null,
  systemProxy: true,
  tun: false,
  tunServiceReady: false,
  sessionId: null,
  outbound: null,
}

function resolveDemoNodes(ids: string[]): NodeRecord[] {
  return ids.map(id => {
    const node = state.nodes.find(entry => entry.record.id === id)?.record
    if (!node) throw new Error('请选择有效的链路节点')
    return node
  })
}

function resolveDemoChain(hops: string[]) {
  if (hops.length < 2) throw new Error('链路至少需要包含 2 跳节点')
  if (new Set(hops).size !== hops.length) throw new Error('同一条链路中不能重复使用相同节点')
  return resolveDemoNodes(hops)
}

const routingDoc: RoutingDocument = {
  path: 'C:\\Users\\Demo\\AppData\\Local\\app.air.client\\air-config.yaml',
  revision: 'demo-rev-1',
  routing: {
    subscriptionId: 'sub-a',
    inheritRules: true,
    fallback: { kind: 'direct' },
    rules: [
      {
        enabled: true,
        matcher: 'processName',
        value: 'chrome.exe',
        target: { kind: 'residential' },
      },
      {
        enabled: true,
        matcher: 'domainSuffix',
        value: 'corp.example.com',
        target: { kind: 'direct' },
      },
    ],
  },
}

function syncSourceCounts() {
  for (const source of state.sources) {
    source.nodes = state.nodes.filter(item => item.record.sourceId === source.id).length
    source.groups = state.groups.filter(item => item.sourceId === source.id).length
  }
}

function snapshotLibrary(): Library {
  syncSourceCounts()
  return {
    sources: state.sources.map(source => ({ ...source })),
    nodes: state.nodes.map(item => ({ ...item.record })),
    groups: state.groups.map(group => ({ ...group, members: [...group.members] })),
  }
}

function sampleNodeLatency(entry: DemoNodeState) {
  const previous = entry.record.latestMs
  let nextMs = Math.max(18, entry.baseMs + randomInt(-entry.jitter, entry.jitter))
  if (previous !== null && nextMs === previous) {
    nextMs = Math.max(18, nextMs + 3)
  }
  const prevAvg = entry.record.averageMs
  const nextAvg = prevAvg === null ? nextMs : Math.round((prevAvg * 4 + nextMs) / 5)
  const prevAvail = entry.record.availability ?? 0.985
  const nextAvail = Math.min(1, Number(((prevAvail * 9 + 1) / 10).toFixed(3)))
  entry.record = {
    ...entry.record,
    status: 'available',
    latestMs: nextMs,
    averageMs: nextAvg,
    availability: nextAvail,
    continuousMs: (entry.record.continuousMs ?? 0) + 5 * MIN,
  }
  return nextMs
}

function resolveDemoExitIp(node: NodeRecord) {
  const name = node.name
  if (name.includes('香港')) return '203.0.113.18'
  if (name.includes('日本') || name.includes('东京')) return '203.0.113.86'
  if (name.includes('新加坡')) return '203.0.113.52'
  if (name.includes('英国')) return '198.51.100.74'
  if (name.includes('德国')) return '198.51.100.91'
  return '198.51.100.24'
}

let backgroundTimer: number | undefined
let lastBackgroundSample = 0

function sampleInBackground() {
  const now = Date.now()
  if (!document.hidden || progress.running || now - lastBackgroundSample < 5 * MIN) return
  for (const entry of state.nodes) sampleNodeLatency(entry)
  lastBackgroundSample = now
}

function previewImportLabel(input: ImportInput) {
  const url = input.kind === 'url' ? new URL(input.url).href : undefined
  const previous = url ? state.sources.find(s => state.urls[s.id] === url) : undefined
  const autoName = !input.name.trim() && previous?.autoName !== false
  const previousBase = previous?.baseName ?? previous?.name
  const base = input.name.trim() || (input.kind === 'url'
    ? (!autoName && previousBase) || input.profileTitle || previousBase || new URL(input.url).hostname : input.filename)
  return { ...subscriptionLabel(base, state.sources, previous), autoName, previous, url }
}

export const browserAir = {
  startupSettings: async (): Promise<StartupSettings> => ({
    login: localStorage.getItem('air.preview.login') === '1',
    proxy: localStorage.getItem('air.preview.proxy') === '1',
  }),
  setStartupSetting: async (setting: keyof StartupSettings, enabled: boolean): Promise<StartupSettings> => {
    localStorage.setItem(`air.preview.${setting}`, enabled ? '1' : '0')
    return browserAir.startupSettings()
  },
  startProxyOnLaunch: async (): Promise<ProxyStatus | null> => null,
  library: async (): Promise<Library> => snapshotLibrary(),

  importSubscription: async (input: ImportInput): Promise<string> => {
    await sleep(260)
    const { name, baseName, autoName, previous, url } = previewImportLabel(input)
    if (previous) {
      Object.assign(previous, { name, baseName, autoName })
      for (const node of state.nodes) if (node.record.sourceId === previous.id) node.record.source = name
      if (previous.details) previous.details.updatedAt = Date.now()
      if (input.yaml) state.yamls[previous.id].original = input.yaml
      return name
    }
    const id = crypto.randomUUID()
    const nodeId = 'demo-import-' + id
    state.sources.push({
      id, name, baseName, autoName,
      nodes: 1,
      groups: 0,
      details: {
        kind: input.kind === 'url' ? (input.qr ? 'qr' : 'url') : 'file',
        updatedAt: Date.now(),
        refreshError: null,
        usage: input.kind === 'url' ? (input.usage ?? null) : null,
      },
    })
    state.nodes.push({
      record: {
        id: nodeId,
        sourceId: id,
        source: name,
        name: `${name} · 节点 01`,
        protocol: 'VLESS',
        server: 'import.example.net',
        port: 443,
        status: null,
        latestMs: null,
        averageMs: null,
        availability: null,
        continuousMs: null,
      },
      baseMs: 92,
      jitter: 18,
      username: '',
      password: '',
      originalName: `${name} · 节点 01`,
      originalServer: 'import.example.net',
      originalPort: 443,
    })
    if (url) state.urls[id] = url
    state.yamls[id] = {
      original: input.yaml ?? `proxies:\n  - { name: "${name} · 节点 01", type: vless, server: import.example.net, port: 443 }\n`,
      local: null,
    }
    return name
  },

  previewSubscription: async (input: ImportInput): Promise<ImportPreview> => {
    await sleep(240)
    if (input.kind === 'url') {
      let parsed: URL
      try {
        parsed = new URL(input.url.trim())
      } catch {
        throw new Error('请输入有效的 HTTP 或 HTTPS 订阅链接')
      }
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        throw new Error('请输入有效的 HTTP 或 HTTPS 订阅链接')
      }
    }
    const { name } = previewImportLabel(input)
    return {
      name, profileTitle: input.kind === 'url' ? input.profileTitle : undefined,
      nodes: 3,
      groups: 1,
      yaml: input.yaml ?? makeSubBYaml(),
      usage: null,
    }
  },

  subscriptionUrl: async (id: string): Promise<string | null> => state.urls[id] ?? null,

  subscriptionPolicy: async (id: string, enabled: boolean, hours: number | null) => {
    const details = state.sources.find(source => source.id === id)?.details
    if (details) { details.autoUpdate = enabled; details.customHours = hours }
  },
  subscriptionExtension: async (id: string) => extensions.get(id) ?? emptyExtension,
  saveSubscriptionExtension: async (id: string, extension: SubscriptionExtension) => {
    const doc = state.yamls[id]
    await extendSubscription(doc.local ?? doc.original, extension)
    extensions.set(id, extension)
    const details = state.sources.find(source => source.id === id)?.details
    if (details) details.autoUpdate = false
  },
  subscriptionYaml: async (id: string, _runtime: boolean) => {
    const doc = state.yamls[id]
    return extendSubscription(doc.local ?? doc.original, extensions.get(id))
  },
  refreshSubscription: async (id: string): Promise<void> => {
    await sleep(360)
    const source = state.sources.find(item => item.id === id)
    if (!source) throw new Error('订阅已不存在')
    if (source.details) {
      source.details = { ...source.details, updatedAt: Date.now(), refreshError: null }
    }
  },

  updateSubscription: async (id: string, name: string, url: string): Promise<void> => {
    await sleep(200)
    const source = state.sources.find(item => item.id === id)
    if (!source) throw new Error('订阅已不存在')
    if (name.trim() && name.trim() !== source.name) {
      Object.assign(source, subscriptionLabel(name.trim(), state.sources, source), { autoName: false })
    }
    if (url.trim()) state.urls[id] = url.trim()
    for (const entry of state.nodes) {
      if (entry.record.sourceId === id) entry.record.source = source.name
    }
  },

  deleteSubscription: async (id: string): Promise<void> => {
    const file = await previewConfig()
    const { contents, revision } = file.read(routingDoc.routing)
    const { routing } = file.parse(contents)
    let changed = routing.subscriptionId === id
    if (changed) {
      routing.subscriptionId = null
      routing.inheritRules = false
      if (routing.fallback.kind === 'subscription') routing.fallback = { kind: 'reject' }
    }
    if (routing.fallback.kind === 'group' && routing.fallback.sourceId === id) {
      routing.fallback = { kind: 'reject' }
      changed = true
    }
    for (const rule of routing.rules) {
      if (rule.target.kind === 'group' && rule.target.sourceId === id) {
        rule.target = { kind: 'reject' }
        changed = true
      }
    }
    if (changed) file.saveSection(routingDoc.routing, 'routing', routing, revision)
    state.sources = state.sources.filter(item => item.id !== id)
    state.nodes = state.nodes.filter(item => item.record.sourceId !== id)
    state.groups = state.groups.filter(item => item.sourceId !== id)
    delete state.urls[id]
    delete state.yamls[id]
  },

  changeSubscriptionItem: async (
    sourceId: string,
    item: string,
    group: boolean,
    edit?: GroupEdit,
  ): Promise<void> => {
    if (group) {
      const idx = state.groups.findIndex(g => g.sourceId === sourceId && g.name === item)
      if (idx === -1) return
      if (edit) {
        const current = state.groups[idx]!
        state.groups[idx] = {
          ...current,
          name: edit.name.trim() || current.name,
          strategy: edit.strategy,
          members: [...edit.members],
        }
      } else {
        state.groups.splice(idx, 1)
      }
      return
    }
    state.nodes = state.nodes.filter(entry => entry.record.id !== item)
    syncSourceCounts()
  },

  editNode: async (edit: Pick<NodeRecord, 'id' | 'name' | 'server' | 'port'>): Promise<void> => {
    const entry = state.nodes.find(item => item.record.id === edit.id)
    if (!entry) throw new Error('节点已不存在')
    entry.record = {
      ...entry.record,
      name: edit.name.trim(),
      server: edit.server.trim(),
      port: edit.port,
    }
  },

  resetNode: async (id: string): Promise<void> => {
    const entry = state.nodes.find(item => item.record.id === id)
    if (!entry) return
    entry.record = {
      ...entry.record,
      name: entry.originalName,
      server: entry.originalServer,
      port: entry.originalPort,
    }
  },

  customNode: async (id: string): Promise<CustomNodeInput> => {
    const entry = state.nodes.find(item => item.record.id === id && item.record.sourceId === 'custom')
    if (!entry) throw new Error('自定义节点已不存在')
    const protocol =
      entry.record.protocol.toLowerCase() === 'https'
        ? 'https'
        : entry.record.protocol.toLowerCase() === 'socks5'
          ? 'socks5'
          : 'http'
    return {
      id: entry.record.id,
      name: entry.record.name,
      protocol,
      server: entry.record.server,
      port: entry.record.port,
      username: entry.username,
      password: entry.password,
    }
  },

  saveCustomNode: async (input: CustomNodeInput): Promise<string> => {
    await sleep(180)
    const name = input.name.trim()
    const server = input.server.trim()
    if (!name || !server || input.port < 1 || input.port > 65535) {
      throw new Error('请填写节点名称、服务器地址和有效端口')
    }
    let customSource = state.sources.find(item => item.id === 'custom')
    if (!customSource) {
      customSource = {
        id: 'custom',
        name: '自定义',
        nodes: 0,
        groups: 0,
        details: { kind: 'custom', updatedAt: Date.now(), refreshError: null },
      }
      state.sources.push(customSource)
    }
    if (input.id) {
      const entry = state.nodes.find(item => item.record.id === input.id)
      if (!entry) throw new Error('自定义节点已不存在')
      entry.record = {
        ...entry.record,
        name,
        protocol: input.protocol,
        server,
        port: input.port,
      }
      entry.username = input.username
      entry.password = input.password
      return entry.record.id
    }
    const id = `demo-custom-${Date.now().toString(36)}`
    state.nodes.push({
      record: {
        id,
        sourceId: 'custom',
        source: '自定义',
        name,
        protocol: input.protocol,
        server,
        port: input.port,
        status: null,
        latestMs: null,
        averageMs: null,
        availability: null,
        continuousMs: null,
      },
      baseMs: 135,
      jitter: 22,
      username: input.username,
      password: input.password,
      originalName: name,
      originalServer: server,
      originalPort: input.port,
    })
    syncSourceCounts()
    return id
  },

  deleteCustomNode: async (id: string): Promise<void> => {
    state.nodes = state.nodes.filter(item => item.record.id !== id)
    customGroupsState = customGroupsState.map(group => ({
      ...group,
      members: group.members.filter(memberId => memberId !== id),
    }))
    saveDemoCustomGroups(customGroupsState)
    syncSourceCounts()
  },

  testCustomNode: async (_kernelPath: string, input: CustomNodeInput): Promise<number> => {
    await sleep(380)
    if (!input.server.trim() || input.port < 1 || input.port > 65535) {
      throw new Error('请输入有效的服务器地址和端口')
    }
    return randomInt(95, 195)
  },

  customGroups: async (): Promise<CustomGroup[]> =>
    customGroupsState.map(group => ({ ...group, members: [...group.members] })),

  saveCustomGroup: async (input: CustomGroupInput): Promise<CustomGroup> => {
    const name = input.name.trim()
    if (!name) throw new Error('请输入自定义分组名称')
    const existingId = input.id?.trim() || undefined
    if (customGroupsState.some(group => group.id !== existingId && group.name === name)) {
      throw new Error('已存在同名的自定义分组')
    }
    const members = input.members && [...new Set(input.members.filter(Boolean))]
    if (members) resolveDemoNodes(members)
    if (existingId) {
      const target = customGroupsState.find(group => group.id === existingId)
      if (!target) throw new Error('自定义分组已不存在')
      target.name = name
      if (members) target.members = members
      saveDemoCustomGroups(customGroupsState)
      return { ...target, members: [...target.members] }
    }
    if (input.parentId && !customGroupsState.some(group => group.id === input.parentId)) {
      throw new Error('上级分组已不存在')
    }
    const created: CustomGroup = {
      id: `cg-${crypto.randomUUID()}`,
      name,
      parentId: input.parentId,
      members: members ?? [],
    }
    customGroupsState = [...customGroupsState, created]
    saveDemoCustomGroups(customGroupsState)
    return { ...created, members: [...created.members] }
  },

  changeCustomGroupMembers: async (id: string, action: 'add' | 'remove', ids: string[]) => {
    const group = customGroupsState.find(group => group.id === id)
    if (!group) throw new Error('自定义分组已不存在')
    if (action === 'add') {
      resolveDemoNodes(ids)
      group.members = [...new Set([...group.members, ...ids])]
    } else {
      const removed = new Set(ids)
      group.members = group.members.filter(member => !removed.has(member))
    }
    saveDemoCustomGroups(customGroupsState)
  },

  deleteCustomGroup: async (id: string): Promise<void> => {
    const removed = customGroupsState.find(group => group.id === id)
    if (!removed) throw new Error('自定义分组已不存在')
    customGroupsState = customGroupsState
      .filter(group => group.id !== id)
      .map(group => group.parentId === id ? { ...group, parentId: removed.parentId } : group)
    saveDemoCustomGroups(customGroupsState)
  },

  sourceDocument: async (sourceId: string) =>
    state.yamls[sourceId] ?? { original: makeSubAYaml(), local: null },

  restoreSourceYaml: async (sourceId: string): Promise<void> => {
    const doc = state.yamls[sourceId]
    if (doc) doc.local = null
  },

  validateYaml: async (yaml: string): Promise<void> => {
    if (!yaml.trim() || !yaml.includes('proxies')) {
      throw new Error('YAML 中缺少 proxies 节点列表')
    }
  },

  saveYaml: async (sourceId: string, yaml: string): Promise<void> => {
    const doc = state.yamls[sourceId]
    if (doc) doc.local = yaml
    else state.yamls[sourceId] = { original: yaml, local: yaml }
  },

  verify: async (_kernelPath: string, hops: string[]): Promise<ExitVerification> => {
    await sleep(420)
    const resolved = resolveDemoChain(hops)
    const latencyMs = resolved.reduce((sum, node, index) => {
      const hopMs = node.latestMs ?? (state.nodes.find(n => n.record.id === node.id)?.baseMs ?? 120)
      return sum + (index === 0 ? hopMs : Math.round(hopMs * 0.65))
    }, 0)
    return {
      ip: resolveDemoExitIp(resolved[resolved.length - 1]!),
      latencyMs,
    }
  },

  validateChain: async (hops: string[]): Promise<void> => { resolveDemoChain(hops) },

  defaultKernelPath: async (): Promise<string | null> => 'C:\\Program Files\\Air\\mihomo.exe',

  proxyStatus: async (): Promise<ProxyStatus> => ({ ...proxyState }),

  installTunService: async (): Promise<ProxyStatus> => {
    proxyState = { ...proxyState, tunServiceReady: true }
    return { ...proxyState }
  },

  proxyExit: async (sessionId: string): Promise<ProxyExit> => {
    await sleep(350)
    if (proxyState.sessionId !== sessionId) throw new Error('代理会话已变更')
    return { ip: '203.0.113.24', countryCode: 'JP', city: 'Tokyo', kind: 'datacenter', quality: 'mediumRisk' }
  },

  proxyTelemetry: async (): Promise<ProxyTelemetry | null> => sampleBrowserTelemetry(),
  clearConnectionLogs: async (): Promise<void> => {
    telemetryState.closedLogs = []
  },
  closeMatchingConnections: async (): Promise<void> => undefined,

  proxyControl: async (request: ProxyAction): Promise<ProxyStatus> => {
    await sleep(request.action === 'start' ? 150 : 80)
    switch (request.action) {
      case 'start': {
        const target = request.target
        const nodes = target.kind === 'chain' ? resolveDemoChain(target.hops)
          : target.kind === 'node' ? resolveDemoNodes([target.id]) : []
        const hops = nodes.map(({ id, name, protocol, source }) => ({ id, name, protocol, source }))
        const name = (target.kind === 'chain' ? target.name.trim() : '')
          || hops.map(hop => hop.name).join(' → ') || '按分流规则'
        proxyState = { ...proxyState, running: true, port: 7897, sessionId: crypto.randomUUID(), outbound: { name, hops } }
        telemetryState.lastSampledAt = 0
        telemetryState.uploadTotal = 0
        telemetryState.downloadTotal = 0
        telemetryState.connections = demoConnections.map(connection => ({ ...connection }))
        break
      }
      case 'stop':
        proxyState = { ...proxyState, running: false, port: null, sessionId: null, outbound: null }
        break
      case 'selectNode': {
        if (!proxyState.running) throw new Error('代理已停止，请重新启动')
        const [{ id, name, protocol, source }] = resolveDemoNodes([request.id])
        proxyState = { ...proxyState, outbound: { name, hops: [{ id, name, protocol, source }] } }
        break
      }
      case 'mode':
        proxyState = { ...proxyState, mode: request.mode }
        break
      case 'systemProxy':
        proxyState = { ...proxyState, systemProxy: request.enabled }
        break
      case 'tun':
        proxyState = { ...proxyState, tun: request.enabled }
        break
    }
    return { ...proxyState }
  },

  batch: async (_kernelPath: string, ids: string[]): Promise<void> => {
    if (progress.running) return
    const targetIds = ids.length ? ids : state.nodes.map(item => item.record.id)
    const runBatchId = progress.batchId + 1
    progress = {
      running: true,
      batchId: runBatchId,
      activeIds: targetIds.slice(0, 3),
      completedIds: [],
      total: targetIds.length,
      completed: 0,
      available: 0,
      timeouts: 0,
      failed: 0,
      error: null,
    }
    for (let i = 0; i < targetIds.length; i += 2) {
      if (!progress.running || progress.batchId !== runBatchId) return
      const chunk = targetIds.slice(i, i + 2)
      progress = { ...progress, activeIds: chunk }
      await sleep(280)
      if (!progress.running || progress.batchId !== runBatchId) return
      for (const id of chunk) {
        const entry = state.nodes.find(item => item.record.id === id)
        if (entry) sampleNodeLatency(entry)
      }
      progress = {
        ...progress,
        activeIds: targetIds.slice(i + 2, i + 4),
        completedIds: [...progress.completedIds, ...chunk],
        completed: Math.min(targetIds.length, i + chunk.length),
        available: Math.min(targetIds.length, i + chunk.length),
      }
    }
    if (!progress.running || progress.batchId !== runBatchId) return
    progress = {
      ...progress,
      running: false,
      activeIds: [],
    }
  },

  cancelBatch: async (): Promise<void> => {
    progress = { ...progress, running: false, activeIds: [] }
  },

  probe: async (_kernelPath: string, id: string): Promise<void> => {
    await sleep(randomInt(300, 500))
    const entry = state.nodes.find(item => item.record.id === id)
    if (!entry) throw new Error('节点已不存在')
    sampleNodeLatency(entry)
  },

  nodeMetrics: async (ids: string[]): Promise<NodeMetrics[]> => {
    const requested = new Set(ids)
    return state.nodes.filter(({ record }) => requested.has(record.id)).map(({ record }) => {
      const { id, status, latestMs, averageMs, availability, continuousMs } = record
      return { id, status, latestMs, averageMs, availability, continuousMs }
    })
  },

  background: async (_kernelPath: string, enabled: boolean): Promise<void> => {
    window.clearInterval(backgroundTimer)
    backgroundTimer = undefined
    document.removeEventListener('visibilitychange', sampleInBackground)
    if (!enabled) return
    document.addEventListener('visibilitychange', sampleInBackground)
    sampleInBackground()
    backgroundTimer = window.setInterval(sampleInBackground, 5 * MIN)
  },

  status: async (): Promise<Progress> => ({
    ...progress,
    activeIds: [...progress.activeIds],
    completedIds: [...progress.completedIds],
  }),

  routingPath: async (): Promise<string> => routingDoc.path,
  openConfigFolder: async (): Promise<void> => { throw new Error('请在 Air 桌面端打开配置文件夹') },
  readConfigFile: async () => (await previewConfig()).read(routingDoc.routing),
  validateConfigFile: async (contents: string) => { (await previewConfig()).parse(contents) },
  saveConfigFile: async (contents: string, revision: string) => (await previewConfig()).save(routingDoc.routing, contents, revision),
  networkSettings: async () => {
    const config = await previewConfig()
    const { contents, revision } = config.read(routingDoc.routing)
    return { settings: config.parse(contents).network, revision }
  },
  subscriptionResolvers: async () => { throw new Error('请在 Air 桌面端读取本机订阅的 DNS 地址') },
  testDns: async () => { throw new Error('请在 Air 桌面端使用 Mihomo 测试 DNS') },
  saveNetworkSettings: async (settings: NetworkSettings, revision: string) => {
    const config = await previewConfig()
    return { settings, revision: config.saveSection(routingDoc.routing, 'network', settings, revision) }
  },

  routingSettings: async (): Promise<RoutingDocument> => {
    const config = await previewConfig()
    const { contents, revision } = config.read(routingDoc.routing)
    return { path: routingDoc.path, routing: config.parse(contents).routing, revision }
  },

  previewRouting: async (config: RoutingConfig, selected?: ProxyTarget): Promise<string[]> => {
    const formatTarget = (target: RoutingConfig['fallback']) =>
      target.kind === 'direct'
        ? 'DIRECT'
        : target.kind === 'reject'
          ? 'REJECT'
          : target.kind === 'selected'
            ? 'GLOBAL'
            : target.kind === 'node'
              ? state.nodes.find(n => n.record.id === target.id)?.record.name ?? target.id
              : target.kind === 'residential'
                ? 'air-residential-exit'
                : target.kind === 'group'
                  ? target.name
                  : '订阅默认出口'
    const lines = config.rules
      .filter(rule => rule.enabled && rule.value.trim())
      .map(rule => {
        const prefix =
          rule.matcher === 'domain'
            ? 'DOMAIN'
            : rule.matcher === 'domainSuffix'
              ? 'DOMAIN-SUFFIX'
              : rule.matcher === 'ip'
                ? 'IP-CIDR'
                : rule.matcher === 'processName'
                  ? 'PROCESS-NAME'
                  : 'PROCESS-PATH'
        const target = formatTarget(rule.target)
        const hostVal = rule.hostValue?.trim()
        if (rule.hostMatcher && hostVal) {
          const hostPrefix =
            rule.hostMatcher === 'domain'
              ? 'DOMAIN'
              : rule.hostMatcher === 'domainSuffix'
                ? 'DOMAIN-SUFFIX'
                : 'IP-CIDR'
          const hostClause = rule.hostMatcher === 'ip' ? `${hostPrefix},${hostVal},no-resolve` : `${hostPrefix},${hostVal}`
          return `AND,((${prefix},${rule.value.trim()}),(${hostClause})),${target}`
        }
        return `${prefix},${rule.value.trim()},${target}`
      })
    const exit = selected?.kind === 'node' ? selected.id : selected?.kind === 'chain' ? selected.hops.at(-1) : undefined
    const owner = selected?.kind === 'chain' && selected.inheritExitRules === false ? undefined
      : exit ? state.nodes.find(node => node.record.id === exit)?.record.sourceId : config.subscriptionId
    const keys = selected?.kind === 'node' ? ['node:' + selected.id, ...(selected.groupId ? ['group:' + selected.groupId] : [])]
      : selected?.kind === 'chain' && selected.id ? ['chain:' + selected.id] : []
    if (owner) keys.push('subscription:' + owner)
    const ref = resolveRules(config.ruleLibrary, keys, owner ?? undefined)
    const sourceId = ref.startsWith('subscription:') ? ref.slice(13) : undefined
    const yaml = sourceId && state.yamls[sourceId]
    const user = config.ruleLibrary?.sets.find(set => 'user:' + set.id === ref)
    const profile = user?.profile ?? (yaml ? (await import('yaml')).parse(yaml.local ?? yaml.original) : undefined)
    const inherited: string[] = Array.isArray(profile?.rules) ? profile.rules.filter((rule: unknown) => typeof rule === 'string') : []
    const end = inherited.findIndex(line => /^MATCH\s*,/i.test(line.trim()))
    const formatPolicy = (line: string) => {
      if (!exit) return line
      const fields = line.split(',').map(field => field.trim())
      let index = fields.length - 1
      while (index > 0 && ['no-resolve', 'src'].includes(fields[index])) index--
      const group = state.groups.find(group => group.sourceId === sourceId && group.name === fields[index])
      if (group?.strategy === 'select') {
        const [first] = group.memberNames ?? group.members
        fields[index] = ['DIRECT', 'REJECT', 'REJECT-DROP'].includes(first) ? first : 'GLOBAL'
      }
      else if (user && !['DIRECT', 'REJECT', 'REJECT-DROP', 'PASS'].includes(fields[index])) fields[index] = 'GLOBAL'
      return fields.join(',')
    }
    if (exit) lines.push('GEOIP,private,DIRECT,no-resolve', 'GEOSITE,private,DIRECT')
    const demoSettings = await browserAir.networkSettings()
    if (demoSettings.settings.blockQuic) lines.push('AND,((NETWORK,UDP),(DST-PORT,443),(NOT,((GEOSITE,cn))),(NOT,((GEOIP,CN,no-resolve)))),REJECT')
    if (exit || config.inheritRules) {
      lines.push(...(end < 0 ? inherited : inherited.slice(0, end)).map(formatPolicy))
    }
    if (exit && !inherited.length) lines.push('GEOSITE,cn,DIRECT', 'GEOIP,CN,DIRECT,no-resolve')
    const fallback = config.matchFallback && config.matchFallback.kind !== 'subscription' ? formatTarget(config.matchFallback) : exit ? (selected?.kind === 'chain' ? 'air-residential-exit' : 'GLOBAL') : formatTarget(config.fallback)
    const terminal = end >= 0 && (config.matchFallback ? config.matchFallback.kind === 'subscription' : exit || config.fallback.kind === 'subscription') ? formatPolicy(inherited[end]) : `MATCH,${fallback}`
    lines.push(terminal)
    return lines
  },

  saveRouting: async (routing: RoutingConfig, revision: string): Promise<RoutingDocument> => {
    const config = await previewConfig()
    return { path: routingDoc.path, routing, revision: config.saveSection(routingDoc.routing, 'routing', routing, revision) }
  },
}

const demoConnections: ProxyConnection[] = [
    {
      id: 'conn-chrome',
      app: 'chrome.exe',
      processName: 'chrome.exe',
      host: 'chatgpt.com',
      network: 'tcp',
      start: new Date(now - 25_000).toISOString(),
      closed: false,
      target: 'chatgpt.com:443',
      rule: 'PROCESS-NAME · 链式出口',
      path: ['默认多跳链路'],
      downloadBytes: 28_420_000,
      uploadBytes: 2_840_000,
    },
    {
      id: 'conn-code',
      app: 'Code.exe',
      processName: 'Code.exe',
      host: 'copilot-proxy.githubusercontent.com',
      network: 'tcp',
      start: new Date(now - 65_000).toISOString(),
      closed: false,
      target: 'copilot-proxy.githubusercontent.com:443',
      rule: 'DOMAIN-SUFFIX · githubusercontent.com',
      path: ['亚太日常 · 香港 BGP 01'],
      downloadBytes: 14_960_000,
      uploadBytes: 1_920_000,
    },
    {
      id: 'conn-tg',
      app: 'Telegram.exe',
      processName: 'Telegram.exe',
      destinationIp: '149.154.167.91',
      network: 'tcp',
      start: new Date(now - 120_000).toISOString(),
      closed: false,
      target: '149.154.167.91:443',
      rule: 'PROCESS-NAME · 链式出口',
      path: ['默认多跳链路'],
      downloadBytes: 9_120_000,
      uploadBytes: 760_000,
    },
    {
      id: 'conn-git',
      app: 'git.exe',
      processName: 'git.exe',
      host: 'github.com',
      network: 'tcp',
      start: new Date(now - 180_000).toISOString(),
      closed: false,
      target: 'github.com:443',
      rule: 'DOMAIN-SUFFIX · github.com',
      path: ['香港节点 · 香港 IEPL 07'],
      downloadBytes: 6_340_000,
      uploadBytes: 1_180_000,
    },
]

const telemetryState = {
  uploadRate: 0,
  downloadRate: 0,
  lastSampledAt: 0,
  uploadTotal: 0,
  downloadTotal: 0,
  connections: demoConnections,
  closedLogs: [] as ProxyConnection[],
}

function stepBrowserTraffic() {
  const now = Date.now()
  if (now - telemetryState.lastSampledAt < 850) return
  telemetryState.lastSampledAt = now

  const burst = Math.random()
  const uploadRate = (burst > 0.72 ? randomInt(240, 520) : randomInt(18, 190)) * 1024
  const downloadRate =
    (burst > 0.7 ? randomInt(2_200, 6_400) : burst < 0.2 ? randomInt(16, 180) : randomInt(320, 1_850)) *
    1024
  telemetryState.uploadRate = uploadRate
  telemetryState.downloadRate = downloadRate
  telemetryState.uploadTotal += uploadRate
  telemetryState.downloadTotal += downloadRate
  telemetryState.connections = telemetryState.connections.map(item => ({
    ...item,
    downloadBytes: item.downloadBytes + randomInt(8, 120) * 1024,
    uploadBytes: item.uploadBytes + randomInt(2, 24) * 1024,
  }))
}

function sampleBrowserTelemetry(): ProxyTelemetry | null {
  if (!proxyState.sessionId) return null
  stepBrowserTraffic()
  const hops = proxyState.outbound?.hops.map(hop => hop.name) ?? []
  const mappedConnections = telemetryState.connections.map((item, index) => ({
    ...item,
    path: proxyState.mode === 'direct' ? ['DIRECT'] : hops.length && (index === 0 || index === 2) ? hops : item.path,
  }))

  return {
    sessionId: proxyState.sessionId,
    sampledAt: telemetryState.lastSampledAt,
    stale: false,
    uploadRate: telemetryState.uploadRate,
    downloadRate: telemetryState.downloadRate,
    uploadTotal: telemetryState.uploadTotal,
    downloadTotal: telemetryState.downloadTotal,
    memoryBytes: 38 * 1024 * 1024 + randomInt(120, 960) * 1024,
    connections: mappedConnections,
    connectionLogs: [...mappedConnections, ...telemetryState.closedLogs],
  }
}

