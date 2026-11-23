export interface NetworkSettings {
  nameserver: string[]
  defaultNameserver: string[]
  directNameserver: string[]
  proxyServerNameserver: string[]
  fallback: string[]
  fallbackDomains: string[]
  domainDns: { domain: string; server: string }[]
  enhancedMode: 'auto' | 'fake-ip' | 'redir-host'
  fakeIpFilter: string[]
  respectRules: boolean
  ipv6: boolean
  dnsIpv6: boolean
  useSystemHosts: boolean
  hosts: string[]
  directFollowPolicy: boolean
  dnsCacheAlgorithm: 'auto' | 'lru' | 'arc'
  tunStack: 'gvisor' | 'system' | 'mixed'
  tunMtu: number | null
  strictRoute: boolean
  dnsHijack: boolean
  routeExcludeAddress: string[]
  mixedPort: number | null
  allowLan: boolean
  systemProxyBypass: string[]
  tcpConcurrent: boolean
  blockQuic: boolean
  probeUrl: string
  probeStatus: number
  probeIntervalMinutes: number
}

export interface DnsResult {
  addresses: string[]
  elapsedMs: number
}

export const defaultNetwork: NetworkSettings = {
  nameserver: ['https://1.1.1.1/dns-query', 'https://8.8.8.8/dns-query'], defaultNameserver: [], directNameserver: [],
  proxyServerNameserver: ['https://223.5.5.5/dns-query', 'https://1.1.1.1/dns-query'],
  fallback: [], fallbackDomains: [], domainDns: [], enhancedMode: 'redir-host', fakeIpFilter: [],
  respectRules: true, ipv6: true, dnsIpv6: true, useSystemHosts: true,
  hosts: [], directFollowPolicy: false, dnsCacheAlgorithm: 'auto',
  tunStack: 'gvisor', tunMtu: null, strictRoute: true, dnsHijack: true, routeExcludeAddress: [],
  mixedPort: null, allowLan: false, systemProxyBypass: [], tcpConcurrent: true, blockQuic: false,
  probeUrl: 'https://www.gstatic.com/generate_204', probeStatus: 204, probeIntervalMinutes: 5,
}
