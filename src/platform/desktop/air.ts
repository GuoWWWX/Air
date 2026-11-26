import { diagnostic } from '@/shared/i18n/messages'
import { invoke as nativeInvoke, isTauri } from '@tauri-apps/api/core'
import { browserAir } from './browserPreview'
import type { DnsResult, NetworkSettings } from '@/shared/proxy/network'
import type { ProxyMode, ProxyPowerState, ProxyTraffic } from '@/shared/proxy/state'

function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  return nativeInvoke<T>(command, args).catch((error: unknown) => {
    throw new Error(diagnostic(error instanceof Error ? error.message : String(error)))
  })
}

export type { ProxyMode, ProxyTraffic } from '@/shared/proxy/state'

export interface NetworkDocument {
  settings: NetworkSettings
  revision: string
}

export type CustomProtocol = 'http' | 'https' | 'socks5'

export interface CustomNodeInput {
  id?: string
  name: string
  protocol: CustomProtocol
  server: string
  port: number
  username: string
  password: string
}

export interface CustomGroup {
  id: string
  name: string
  parentId?: string
  members: string[]
}

export interface CustomGroupInput {
  id?: string
  name: string
  parentId?: string
  members?: string[]
}

export interface ChainRecord {
  inheritExitRules?: boolean
  id: string
  name: string
  hops: string[]
}

export interface NodeRecord {
  id: string
  probeRevision?: string
  sourceId: string
  source: string
  name: string
  protocol: string
  server: string
  port: number
  subscriptionNotice?: boolean
  status: 'available' | 'timeout' | 'unreachable' | null
  latestMs: number | null
  averageMs: number | null
  availability: number | null
  continuousMs: number | null
}

export type NodeMetrics = Pick<NodeRecord,
  'id' | 'probeRevision' | 'status' | 'latestMs' | 'averageMs' | 'availability' | 'continuousMs'>

export interface Library {
  nodes: NodeRecord[]
  sources: SubscriptionSource[]
  groups: SubscriptionGroup[]
}

export interface SubscriptionSource {
  id: string
  name: string
  nodes: number
  groups: number
  details?: {
    kind: 'url' | 'file' | 'qr' | 'custom'
    updatedAt: number
    autoUpdate?: boolean | null
    intervalHours?: number | null
    customHours?: number | null
    refreshError: string | null
    usage?: SubscriptionUsage | null
  } | null
}

export interface SubscriptionUsage {
  upload: number
  download: number
  total: number
  expire: number | null
}

export interface SubscriptionGroup {
  sourceId: string
  name: string
  members: string[]
  memberNames?: string[]
  strategy?: string
}

export interface Progress {
  running: boolean
  batchId: number
  activeIds: string[]
  completedIds: string[]
  total: number
  completed: number
  available: number
  timeouts: number
  failed: number
  error: string | null
}

export interface ExitVerification {
  ip: string
  latencyMs: number
}

export interface ProxyExit {
  ip: string
  countryCode?: string
  region?: string
  city?: string
  kind?: 'datacenter' | 'residential' | 'mobile' | 'gateway'
  quality?: 'noEvidence' | 'lowRisk' | 'mediumRisk' | 'highRisk'
}

export type ChainProbeResult = ExitVerification | { error: string }

export interface ProxyStatus extends ProxyPowerState {
  target?: ProxyTarget
  mode: ProxyMode
  port: number | null
  tunServiceReady: boolean | null
  sessionId: string | null
  outbound: { name: string; hops: ProxyHop[] } | null
}

export type ProxyHop = Pick<NodeRecord, 'id' | 'name' | 'protocol' | 'source'>

export interface ProxyConnection {
  id: string
  app: string
  appExecutable?: string
  appIconKey?: string
  host?: string
  destinationIp?: string
  network?: string
  processName?: string
  processPath?: string
  start?: string
  closed?: boolean
  target: string
  rule: string
  path: string[]
  uploadBytes: number
  downloadBytes: number
}

export interface TelemetryCursor {
  sessionId: string
  revision: number
  knownIcons: string[]
}

export interface ProxyTelemetry extends ProxyTraffic {
  revision?: number
  logOrder?: string[]
  sessionId: string
  sampledAt: number
  stale: boolean
  memoryBytes: number | null
  connections: ProxyConnection[]
  connectionLogs?: ProxyConnection[]
  appIcons?: Record<string, string>
}

export type ProxyTarget =
  | { kind: 'routing' }
  | { kind: 'group'; id: string; name: string; members: string[] }
  | { kind: 'node'; id: string; groupId?: string }
  | { kind: 'chain'; id?: string; inheritExitRules?: boolean; name: string; hops: string[] }

export type ProxyModeAction =
  | { action: 'mode'; mode: ProxyMode }
  | { action: 'systemProxy' | 'tun'; enabled: boolean }

export type ProxyAction =
  | { action: 'start'; kernelPath: string; target: ProxyTarget }
  | { action: 'selectGroup'; id: string }
  | { action: 'selectNode'; id: string; groupId?: string }
  | { action: 'stop' }
  | ProxyModeAction

export type RouteTarget =
  | { kind: 'direct' | 'reject' | 'selected' | 'residential' | 'subscription' }
  | { kind: 'node'; id: string }
  | { kind: 'group'; sourceId: string; name: string }

export type HostMatcher = 'domain' | 'domainSuffix' | 'ip'

export interface RouteRule {
  resumeOnEnable?: boolean
  enabled: boolean
  matcher: 'domain' | 'domainSuffix' | 'ip' | 'processName' | 'processPath'
  value: string
  hostMatcher?: HostMatcher
  hostValue?: string
  target: RouteTarget
}

export interface RoutingConfig {
  ruleLibrary?: import('@/shared/proxy/rule-library').RuleLibrary
  matchFallback?: RouteTarget
  subscriptionId: string | null
  inheritRules: boolean
  fallback: RouteTarget
  rules: RouteRule[]
}

export interface RoutingDocument {
  routing: RoutingConfig
  revision: string
  path: string
}

export type ImportInput =
  | { kind: 'url'; name: string; url: string; qr?: boolean; yaml?: string; profileTitle?: string | null; intervalHours?: number | null; usage?: SubscriptionUsage | null }
  | { kind: 'file'; name: string; filename: string; yaml: string }
export interface ImportPreview {
  profileTitle?: string | null
  name: string
  nodes: number
  groups: number
  yaml: string
  intervalHours?: number | null
  usage?: SubscriptionUsage | null
}
export interface GroupEdit {
  name: string
  strategy: string
  members: string[]
}
type NodeEdit = Pick<NodeRecord, 'id' | 'name' | 'server' | 'port'>

export interface StartupSettings { login: boolean; proxy: boolean }
export interface ResolvedAppIdentity { executable?: string; path?: string; name?: string; icon?: string }

import type { SubscriptionExtension } from "@/shared/proxy/subscription-extension"

const tauriAir = {
  startupSettings: () => invoke<StartupSettings>('startup_settings'),
  setStartupSetting: (setting: keyof StartupSettings, enabled: boolean) =>
    invoke<StartupSettings>('set_startup_setting', { setting, enabled }),
  startProxyOnLaunch: (kernelOverride: string | null, target: ProxyTarget) =>
    invoke<ProxyStatus | null>('start_proxy_on_launch', { kernelOverride, target }),
  testDns: (kernelPath: string, settings: NetworkSettings, domain: string) =>
    invoke<DnsResult>('test_dns_settings', { kernelPath, settings, domain }),
  networkSettings: () => invoke<NetworkDocument>('network_settings'),
  subscriptionResolvers: (sourceId: string) => invoke<Partial<Pick<NetworkSettings, 'nameserver' | 'defaultNameserver' | 'directNameserver' | 'proxyServerNameserver'>>>('subscription_resolvers', { sourceId }),
  saveNetworkSettings: (settings: NetworkSettings, revision: string) =>
    invoke<NetworkDocument>('save_network_settings', { settings, revision }),
  library: () => invoke<Library>('library'),
  importSubscription: (input: ImportInput) => invoke<string>('import_subscription', { input }),
  previewSubscription: (input: ImportInput) => invoke<ImportPreview>('preview_subscription', { input }),
  subscriptionUrl: (id: string) => invoke<string | null>('subscription_url', { id }),
  subscriptionPolicy: (id: string, enabled: boolean, hours: number | null) => invoke<void>('subscription_policy', { id, enabled, hours }),
  subscriptionExtension: (id: string) => invoke<SubscriptionExtension>('subscription_extension', { id }),
  saveSubscriptionExtension: (id: string, extension: SubscriptionExtension) => invoke<void>('save_subscription_extension', { id, extension }),
  subscriptionYaml: (id: string, runtime: boolean) => invoke<string>('subscription_yaml', { id, runtime }),
  refreshSubscription: (id: string) => invoke<void>('refresh_subscription', { id }),
  updateSubscription: (id: string, name: string, url: string) =>
    invoke<void>('update_subscription', { id, name, url }),
  deleteSubscription: (id: string) => invoke<void>('delete_subscription', { id }),
  changeSubscriptionItem: (sourceId: string, item: string, group: boolean, edit?: GroupEdit) =>
    invoke<void>('change_subscription_item', { sourceId, item, group, edit: edit ?? null }),
  editNode: (edit: NodeEdit) => invoke<void>('edit_node', { edit }),
  resetNode: (id: string) => invoke<void>('reset_node', { id }),
  customNode: (id: string) => invoke<CustomNodeInput>('custom_node', { id }),
  saveCustomNode: (input: CustomNodeInput) => invoke<string>('save_custom_node', { input }),
  deleteCustomNode: (id: string) => invoke<void>('delete_custom_node', { id }),
  testCustomNode: (kernelPath: string, input: CustomNodeInput) =>
    invoke<number>('test_custom_node', { kernelPath, input }),
  customGroups: () => invoke<CustomGroup[]>('custom_groups'),
  saveCustomGroup: (input: CustomGroupInput) =>
    invoke<CustomGroup>('save_custom_group', { input }),
  changeCustomGroupMembers: (id: string, action: 'add' | 'remove', ids: string[]) =>
    invoke<void>('change_custom_group_members', { id, action, ids }),
  deleteCustomGroup: (id: string) => invoke<void>('delete_custom_group', { id }),
  sourceDocument: (sourceId: string) =>
    invoke<{ original: string; local: string | null }>('source_document', { sourceId }),
  restoreSourceYaml: (sourceId: string) => invoke<void>('restore_source_yaml', { sourceId }),
  validateYaml: (yaml: string) => invoke<void>('validate_yaml', { yaml }),
  saveYaml: (sourceId: string, yaml: string) => invoke<void>('save_yaml', { sourceId, yaml }),
  verify: (kernelPath: string, hops: string[]) =>
    invoke<ExitVerification>('verify_chain', { kernelPath, hops }),
  validateChain: (hops: string[]) => invoke<void>('validate_chain', { hops }),
  defaultKernelPath: () => invoke<string | null>('default_kernel_path'),
  proxyStatus: () => invoke<ProxyStatus>('proxy_status'),
  installTunService: () => invoke<ProxyStatus>('install_tun_service'),
  proxyExit: (sessionId: string) => invoke<ProxyExit>('proxy_exit', { sessionId }),
  proxyTelemetry: (cursor?: TelemetryCursor) => invoke<ProxyTelemetry | null>('proxy_telemetry', { cursor }),
  resolveApplications: (queries: string[]) =>
    invoke<ResolvedAppIdentity[]>('resolve_applications', { queries }),
  proxyControl: (request: ProxyAction) => invoke<ProxyStatus>('proxy_control', { request }),
  clearConnectionLogs: () => invoke<void>('clear_connection_logs'),
  closeMatchingConnections: (processName?: string, host?: string) =>
    invoke<void>('close_matching_connections', { processName: processName ?? null, host: host ?? null }),
  batch: (kernelPath: string, ids: string[], highSpeed = false) => invoke<void>('batch_probe', { kernelPath, ids, highSpeed }),
  cancelBatch: () => invoke<void>('cancel_batch_probe'),
  probe: (kernelPath: string, id: string) => invoke<unknown>('probe_node', { kernelPath, id }),
  nodeMetrics: (ids: string[]) => invoke<NodeMetrics[]>('node_metrics', { ids }),
  background: (kernelPath: string, enabled: boolean) =>
    invoke<void>('set_background', { kernelPath, enabled }),
  status: () => invoke<Progress>('monitor_status'),
  routingPath: () => invoke<string>('routing_path'),
  openConfigFolder: () => invoke<void>('open_config_folder'),
  readConfigFile: () => invoke<{ contents: string; revision: string }>('read_config_file'),
  saveConfigFile: (contents: string, revision: string) => invoke<string>('save_config_file', { contents, revision }),
  validateConfigFile: (contents: string) => invoke<void>('validate_config_file', { contents }),
  routingSettings: () => invoke<RoutingDocument>('routing_settings'),
  previewRouting: (config: RoutingConfig, target?: ProxyTarget) => invoke<string[]>('preview_routing', { config, target }),
  saveRouting: (config: RoutingConfig, revision: string, target?: ProxyTarget) =>
    invoke<RoutingDocument>('save_routing', { config, revision, target }),
}

export const air: typeof tauriAir = new Proxy(tauriAir, {
  get(target, prop, receiver) {
    const backend: typeof tauriAir = isTauri() ? target : browserAir
    return Reflect.get(backend, prop, receiver)
  },
})
