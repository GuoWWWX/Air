import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function formatDateTime(
  value: number | string | Date | null | undefined,
  options?: { seconds?: boolean },
): string {
  if (value === null || value === undefined || value === '') return '—'
  const date = value instanceof Date ? value : new Date(value)
  const time = date.getTime()
  if (!Number.isFinite(time)) return '—'
  const pad = (n: number) => String(n).padStart(2, '0')
  const datePart = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
  const timePart = `${pad(date.getHours())}:${pad(date.getMinutes())}${options?.seconds ? `:${pad(date.getSeconds())}` : ''}`
  return `${datePart} ${timePart}`
}

const protocolLabels: Record<string, string> = {
  http: 'HTTP',
  https: 'HTTPS',
  socks5: 'SOCKS5',
  vless: 'VLESS',
  vmess: 'VMess',
  anytls: 'AnyTLS',
  trojan: 'Trojan',
  shadowsocks: 'Shadowsocks',
  ss: 'Shadowsocks',
  hysteria2: 'Hysteria2',
  wireguard: 'WireGuard',
}

export function formatProtocol(protocol: string): string {
  const key = protocol.trim().toLowerCase()
  return protocolLabels[key] ?? protocol
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  const decimals = unit === 0 ? 0 : value >= 100 ? 0 : value >= 10 ? 1 : 2
  return `${value.toFixed(decimals)} ${units[unit]}`
}

export function formatRate(bytesPerSec: number): string {
  return `${formatBytes(bytesPerSec)}/s`
}

export function formatCompactRate(bytesPerSec: number): string {
  if (!Number.isFinite(bytesPerSec) || bytesPerSec <= 0) return '0 B/s'
  const units = ['B', 'K', 'M', 'G', 'T']
  let value = bytesPerSec
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  const decimals = unit === 0 || value >= 10 ? 0 : 1
  return `${value.toFixed(decimals)}${units[unit]}/s`
}
