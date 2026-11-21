export type ProxyMode = 'rule' | 'global' | 'direct'

export interface ProxyPowerState {
  running: boolean
  tun: boolean
  systemProxy: boolean
}

export interface ProxyTraffic {
  uploadRate: number
  downloadRate: number
  uploadTotal: number
  downloadTotal: number
}
