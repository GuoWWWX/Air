import { normalizeProcessRuleValue, type PolicyRuleLike } from './connection-policy'

export function applicationRule(rule: PolicyRuleLike) {
  return rule.matcher === 'processName' || rule.matcher === 'processPath'
}

export interface RuleRow { key: string; application: boolean; indices: number[] }

export function ruleRows(rules: PolicyRuleLike[], android = false): RuleRow[] {
  const rows = new Map<string, RuleRow>()
  rules.forEach((rule, index) => {
    const app = applicationRule(rule)
    const name = normalizeProcessRuleValue(rule.matcher, rule.value, android).split('\\').at(-1)
    const key = app && name ? 'app:' + name : 'rule:' + index
    const row = rows.get(key) ?? { key, application: app, indices: [] }
    row.indices.push(index)
    rows.set(key, row)
  })
  return [...rows.values()]
}

// Replace the original slots so unrelated, interleaved rules keep their priority.
export function replaceRuleRows<R extends PolicyRuleLike>(rules: R[], indices: number[], replacement: R[]) {
  const ordered = [...replacement]
  for (let index = 0; index < ordered.length; index++) {
    const rule = ordered[index]
    if (!applicationRule(rule) || !rule.hostMatcher) continue
    const value = normalizeProcessRuleValue(rule.matcher, rule.value)
    const earlier = ordered.findIndex((item, i) => i < index && !item.hostMatcher && applicationRule(item)
      && normalizeProcessRuleValue(item.matcher, item.value) === (item.matcher === 'processName' ? value.split('\\').at(-1) : value))
    if (earlier >= 0) ordered.splice(earlier, 0, ...ordered.splice(index, 1))
  }
  if (!indices.length) return [...rules, ...ordered]
  const selected = new Set(indices)
  let at = 0
  return rules.flatMap((rule, i) => !selected.has(i) ? [rule] : i === indices.at(-1)
    ? ordered.slice(at) : at < ordered.length ? [ordered[at++]] : [])
}

export function moveRuleRow<R extends PolicyRuleLike>(rules: R[], row: RuleRow, other: RuleRow) {
  const selected = new Set(row.indices)
  const before = row.indices[0] > other.indices[0]
  const anchor = before ? other.indices[0] : other.indices[other.indices.length - 1]
  const moving = row.indices.map(i => rules[i])
  return rules.flatMap((rule, index) => selected.has(index) ? [] : index !== anchor ? [rule]
    : before ? [...moving, rule] : [rule, ...moving])
}
