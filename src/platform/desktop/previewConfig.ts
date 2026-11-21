import { isMap, parseDocument, stringify } from 'yaml'
import type { RoutingConfig } from './air'
import { defaultNetwork, type NetworkSettings } from '@/shared/proxy/network'

const key = 'air.preview.configFile'
const emptyRouting: RoutingConfig = { subscriptionId: null, inheritRules: false, fallback: { kind: 'direct' }, rules: [] }
type FileSource = { contents: string; revision: string }

export function read(demo: RoutingConfig): FileSource {
  const stored = localStorage.getItem(key)
  if (stored) return JSON.parse(stored)
  const oldNetwork = JSON.parse(localStorage.getItem('air.preview.network') ?? '{}')
  return { contents: stringify({ routing: demo, network: { ...defaultNetwork, ...oldNetwork.settings } }), revision: 'initial' }
}

export function parse(contents: string) {
  if (new TextEncoder().encode(contents).length > 1024 * 1024) throw new Error('全局配置文件超过 1 MB')
  const doc = parseDocument(contents)
  if (doc.errors.length) throw new Error(doc.errors[0].message)
  if (!isMap(doc.contents)) throw new Error('全局配置文件的根节点必须是 YAML 映射')
  const root = doc.toJS()
  for (const field of ['dns', 'nameserver', 'proxies', 'proxy-groups', 'rules', 'tun', 'mixed-port']) {
    if (Object.hasOwn(root, field)) throw new Error(`顶层的 ${field} 不是 Air 配置项`)
  }
  for (const section of ['network', 'routing']) {
    if (doc.has(section) && !isMap(doc.get(section, true))) throw new Error(`${section} 必须是 YAML 映射`)
  }
  const network: NetworkSettings = { ...defaultNetwork, ...root.network }
  if (root.network?.respectRules === undefined && root.network?.proxyServerNameserver?.length === 0) {
    network.respectRules = false
  }
  for (const field of Object.keys(root.network ?? {})) {
    if (!Object.hasOwn(defaultNetwork, field)) throw new Error(`未知网络设置：${field}`)
    const k = field as keyof NetworkSettings
    const expected = defaultNetwork[k], value = network[k]
    if (Array.isArray(expected) ? !Array.isArray(value) : expected === null ? value !== null && !Number.isInteger(value) : typeof value !== typeof expected) {
      throw new Error(`${field} 的值类型错误`)
    }
    if (Array.isArray(expected) && Array.isArray(value) && k !== 'domainDns' && value.some(v => typeof v !== 'string')) throw new Error(`${field} 应为文本列表`)
  }
  if (!network.nameserver.length) throw new Error('请至少填写一个主 DNS')
  if (network.respectRules && !network.proxyServerNameserver.length) throw new Error('请填写节点 DNS')
  const routing: RoutingConfig = { ...emptyRouting, ...root.routing }
  if (!Array.isArray(routing.rules) || !routing.fallback?.kind || routing.rules.some(r => !r?.matcher || typeof r.value !== 'string' || !r.target?.kind)) throw new Error('分流规则格式无效')
  return { doc, network, routing }
}

export function save(demo: RoutingConfig, contents: string, revision: string) {
  parse(contents)
  if (read(demo).revision !== revision) throw new Error('配置文件已更新，请重新读取后再保存')
  const next = crypto.randomUUID()
  localStorage.setItem(key, JSON.stringify({ contents, revision: next }))
  return next
}

export function saveSection(demo: RoutingConfig, section: string, value: NetworkSettings | RoutingConfig, revision: string) {
  const { doc } = parse(read(demo).contents)
  doc.set(section, value)
  return save(demo, String(doc), revision)
}
