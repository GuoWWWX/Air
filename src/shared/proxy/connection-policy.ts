export type PolicyHostMatcher = 'domain' | 'domainSuffix' | 'ip'

export interface PolicyTargetLike {
  kind: string
}

export interface PolicyRuleLike<Target extends PolicyTargetLike = PolicyTargetLike> {
  enabled: boolean
  matcher: string
  value: string
  hostMatcher?: PolicyHostMatcher
  hostValue?: string
  target: Target
}

export interface ExtractedHostInfo {
  kind: 'domain' | 'ip' | 'none'
  value: string
  suggestedSuffix?: string
}

const MULTI_PART_PUBLIC_SUFFIXES = new Set([
  'com.cn',
  'net.cn',
  'org.cn',
  'gov.cn',
  'edu.cn',
  'ac.cn',
  'co.uk',
  'org.uk',
  'gov.uk',
  'ac.uk',
  'co.jp',
  'ne.jp',
  'or.jp',
  'ac.jp',
  'co.kr',
  'com.hk',
  'com.tw',
  'com.sg',
  'com.au',
  'com.br',
])

export function isPolicyIpAddress(raw: string): boolean {
  const value = raw.trim()
  if (!value) return false
  if (value.includes(':')) {
    try {
      return new URL(`http://[${value}]/`).hostname.startsWith('[')
    } catch {
      return false
    }
  }
  const parts = value.split('.')
  return parts.length === 4 && parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

/** Validate a manual fine-grained host/IP policy value across Desktop and Mobile. */
export function validatePolicyHostValue(matcher: PolicyHostMatcher, raw: string): string | null {
  const value = raw.trim()
  if (!value || value.includes(',') || /[\u0000-\u001f\u007f]/.test(value)) return null
  if (matcher === 'ip') {
    const parts = value.split('/')
    if (parts.length > 2) return null
    const [address, prefix] = parts
    if (!address || !isPolicyIpAddress(address)) return null
    const maxBits = address.includes(':') ? 128 : 32
    if (prefix === undefined) return value
    if (!/^\d{1,3}$/.test(prefix)) return null
    const num = Number(prefix)
    return num >= 0 && num <= maxBits ? value : null
  }
  const domain = value.replace(/\.+$/, '')
  if (!domain || /[\s/\\:@?#%*]/.test(domain) || isPolicyIpAddress(domain)) return null
  try {
    const host = new URL(`https://${domain}`).hostname
    if (!host || isPolicyIpAddress(host)) return null
    const valid = host.split('.').every(
      label => label.length > 0 && label.length <= 63 && !label.startsWith('-') && !label.endsWith('-') && /^[a-z0-9-]+$/i.test(label),
    )
    return valid ? domain : null
  } catch {
    return null
  }
}

function stripPort(raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed) return ''
  if (trimmed.startsWith('[')) {
    const end = trimmed.indexOf(']')
    return end > 1 ? trimmed.slice(1, end) : trimmed
  }
  const firstColon = trimmed.indexOf(':')
  const lastColon = trimmed.lastIndexOf(':')
  if (firstColon !== -1 && firstColon === lastColon) {
    const maybePort = trimmed.slice(lastColon + 1)
    if (/^\d+$/.test(maybePort)) {
      return trimmed.slice(0, lastColon)
    }
  }
  return trimmed
}

export function suggestRootDomain(domain: string): string {
  const clean = domain.trim().replace(/\.+$/, '').toLowerCase()
  const parts = clean.split('.').filter(Boolean)
  if (parts.length <= 2) return clean
  const lastTwo = parts.slice(-2).join('.')
  if (MULTI_PART_PUBLIC_SUFFIXES.has(lastTwo) && parts.length >= 3) {
    return parts.slice(-3).join('.')
  }
  return lastTwo
}

export function extractHostInfo(rawHostOrTarget?: string, destinationIp?: string): ExtractedHostInfo {
  const cleanedHost = stripPort(rawHostOrTarget ?? '').replace(/\.+$/, '')
  if (cleanedHost && cleanedHost !== '未知目标') {
    if (isPolicyIpAddress(cleanedHost)) {
      return { kind: 'ip', value: cleanedHost }
    }
    const lower = cleanedHost.toLowerCase()
    return {
      kind: 'domain',
      value: lower,
      suggestedSuffix: suggestRootDomain(lower),
    }
  }
  const cleanedIp = stripPort(destinationIp ?? '')
  if (cleanedIp && isPolicyIpAddress(cleanedIp)) {
    return { kind: 'ip', value: cleanedIp }
  }
  return { kind: 'none', value: '' }
}

export function normalizeProcessRuleValue(
  matcher: string,
  value: string,
  caseSensitiveProcess = false,
): string {
  let next = value.trim()
  if (matcher === 'processPath') {
    next = next.replaceAll('/', '\\')
  }
  return caseSensitiveProcess ? next : next.toLowerCase()
}

export function normalizeHostRuleValue(matcher: PolicyHostMatcher, value: string): string {
  const trimmed = value.trim()
  if (matcher === 'ip') return trimmed
  return trimmed.replace(/\.+$/, '').toLowerCase()
}

export function findAppPolicyRules<Rule extends PolicyRuleLike>(
  rules: readonly Rule[],
  processMatcher: string,
  processValue: string,
  options?: { caseSensitiveProcess?: boolean },
): {
  coarseRule: Rule | undefined
  fineRules: Rule[]
} {
  const targetProc = normalizeProcessRuleValue(
    processMatcher,
    processValue,
    options?.caseSensitiveProcess,
  )
  let coarseRule: Rule | undefined
  const fineRules: Rule[] = []

  for (const rule of rules) {
    if (!rule.enabled || rule.matcher !== processMatcher) continue
    if (
      normalizeProcessRuleValue(rule.matcher, rule.value, options?.caseSensitiveProcess) !==
      targetProc
    ) {
      continue
    }
    if (rule.hostMatcher && rule.hostValue?.trim()) {
      fineRules.push(rule)
    } else if (!coarseRule) {
      coarseRule = rule
    }
  }

  return { coarseRule, fineRules }
}

export interface FinePolicyDraft<Target extends PolicyTargetLike> {
  hostMatcher: PolicyHostMatcher
  hostValue: string
  target: Target
}

function finePriority(matcher: PolicyHostMatcher): number {
  return matcher === 'domainSuffix' ? 1 : 0
}

export function mergeAppPolicyRules<
  Target extends PolicyTargetLike,
  Rule extends PolicyRuleLike<Target> = PolicyRuleLike<Target>,
>(
  existingRules: readonly Rule[],
  params: {
    processMatcher: string
    processValue: string
    coarseTarget: Target | null
    fineRules: readonly FinePolicyDraft<Target>[]
    caseSensitiveProcess?: boolean
  },
): Rule[] {
  const targetProc = normalizeProcessRuleValue(
    params.processMatcher,
    params.processValue,
    params.caseSensitiveProcess,
  )

  const remaining = existingRules.filter(rule => {
    if (rule.matcher !== params.processMatcher) return true
    return (
      normalizeProcessRuleValue(rule.matcher, rule.value, params.caseSensitiveProcess) !==
      targetProc
    )
  })

  const dedupedFine = new Map<string, Rule>()
  for (const item of params.fineRules) {
    const cleanHost = item.hostValue.trim()
    if (!cleanHost) continue
    const key = `${item.hostMatcher}:${normalizeHostRuleValue(item.hostMatcher, cleanHost)}`
    dedupedFine.set(key, {
      enabled: true,
      matcher: params.processMatcher,
      value: params.processValue.trim(),
      hostMatcher: item.hostMatcher,
      hostValue: cleanHost,
      target: item.target,
    } as Rule)
  }

  const orderedFine = [...dedupedFine.values()].sort(
    (a, b) => finePriority(a.hostMatcher!) - finePriority(b.hostMatcher!),
  )

  const nextAppRules: Rule[] = [...orderedFine]
  if (params.coarseTarget) {
    nextAppRules.push({
      enabled: true,
      matcher: params.processMatcher,
      value: params.processValue.trim(),
      target: params.coarseTarget,
    } as Rule)
  }

  return [...nextAppRules, ...remaining]
}

export function findStandaloneHostRule<Rule extends PolicyRuleLike>(
  rules: readonly Rule[],
  hostMatcher: PolicyHostMatcher,
  hostValue: string,
): Rule | undefined {
  const normalized = normalizeHostRuleValue(hostMatcher, hostValue)
  return rules.find(
    rule =>
      rule.enabled &&
      rule.matcher === hostMatcher &&
      !rule.hostValue?.trim() &&
      normalizeHostRuleValue(hostMatcher, rule.value) === normalized,
  )
}

export function mergeStandaloneHostRule<
  Target extends PolicyTargetLike,
  Rule extends PolicyRuleLike<Target> = PolicyRuleLike<Target>,
>(
  existingRules: readonly Rule[],
  params: {
    hostMatcher: PolicyHostMatcher
    hostValue: string
    target: Target | null
  },
): Rule[] {
  const cleanHost = params.hostValue.trim()
  if (!cleanHost) return [...existingRules]
  const normalized = normalizeHostRuleValue(params.hostMatcher, cleanHost)
  const remaining = existingRules.filter(
    rule =>
      !(
        rule.matcher === params.hostMatcher &&
        !rule.hostValue?.trim() &&
        normalizeHostRuleValue(params.hostMatcher, rule.value) === normalized
      ),
  )
  if (!params.target) return remaining
  const inserted = {
    enabled: true,
    matcher: params.hostMatcher,
    value: cleanHost,
    target: params.target,
  } as Rule
  return [inserted, ...remaining]
}
