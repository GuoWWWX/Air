import { tr } from '@/shared/i18n/messages'

export type ObjectKind = 'node' | 'subscription' | 'group' | 'chain'
export interface RuleProfile {
  rules: string[]
  'rule-providers'?: Record<string, unknown>
  'proxy-groups'?: { name: string; type: string; proxies?: string[] }[]
}
export interface UserRuleSet { id: string; name: string; profile: RuleProfile }
export interface RuleLibrary { sets: UserRuleSet[]; bindings: Record<string, string> }

export function objectKey(kind: ObjectKind, id: string) { return kind + ':' + id }
export function resolveRules(catalog: RuleLibrary | undefined, keys: string[], source?: string) {
  for (const key of keys) {
    const binding = catalog?.bindings[key]
    if (binding) return binding
  }
  return source && source !== 'custom' ? 'subscription:' + source : 'none'
}
export function dropBinding(catalog: RuleLibrary, reference: string, owner?: string): RuleLibrary {
  return { sets: catalog.sets.filter(set => 'user:' + set.id !== reference),
    bindings: Object.fromEntries(Object.entries(catalog.bindings).filter(([key, value]) => key !== owner && value !== reference)) }
}
export function validateRuleLibrary(value: unknown): asserts value is RuleLibrary {
  const lib = value as RuleLibrary
  if (!lib || !Array.isArray(lib.sets) || !lib.bindings || Array.isArray(lib.bindings) || typeof lib.bindings !== 'object') throw new Error(tr('规则库格式无效'))
  const ids = new Set<string>()
  for (const set of lib.sets) {
    if (!set?.id || ids.has(set.id) || !set.name?.trim() || !Array.isArray(set.profile?.rules)
      || set.profile.rules.some(line => typeof line !== 'string' || !line.trim().includes(','))) throw new Error(tr('规则集格式无效'))
    const groups = set.profile['proxy-groups']
    if (groups) {
      if (!Array.isArray(groups)) throw new Error(tr('规则集格式无效'))
      const byName = new Map<string, string[]>()
      for (const group of groups) {
        if (!group || typeof group.name !== 'string' || typeof group.type !== 'string'
          || (group.proxies !== undefined && (!Array.isArray(group.proxies) || group.proxies.some(member => typeof member !== 'string')))) {
          throw new Error(tr('规则集格式无效'))
        }
        byName.set(group.name, group.proxies ?? [])
      }
      const visit = (name: string, stack: Set<string>) => {
        if (stack.has(name)) throw new Error(tr('订阅分组包含循环引用'))
        const members = byName.get(name)
        if (!members) return
        const next = new Set(stack).add(name)
        for (const member of members) {
          if (byName.has(member)) visit(member, next)
        }
      }
      for (const name of byName.keys()) visit(name, new Set())
    }
    ids.add(set.id)
  }
  for (const [owner, ref] of Object.entries(lib.bindings)) {
    if (!/^(subscription|node|group|chain):.+/.test(owner) || typeof ref !== 'string'
      || !(ref === 'none' || /^subscription:.+/.test(ref) || (ref.startsWith('user:') && ids.has(ref.slice(5))))) throw new Error(tr('分流规则绑定无效'))
  }
}

export const emptyRuleLibrary: RuleLibrary = { sets: [], bindings: {} }

export function setBinding(catalog: RuleLibrary | undefined, owner: string, value: string): RuleLibrary {
  const next = { ...(catalog ?? emptyRuleLibrary), bindings: { ...catalog?.bindings } }
  if (value) next.bindings[owner] = value
  else delete next.bindings[owner]
  return next
}
