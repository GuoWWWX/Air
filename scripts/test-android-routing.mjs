import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { after, test } from 'node:test'
import { createServer } from 'vite'
import { parse, stringify } from 'yaml'

const vite = await createServer({
  root: resolve(import.meta.dirname, '../android/web'),
  configFile: false,
  resolve: { alias: { '@/shared': resolve(import.meta.dirname, '../src/shared') } },
  server: { middlewareMode: true, hmr: false, watch: null },
  optimizeDeps: { noDiscovery: true },
  logLevel: 'silent',
})
after(() => vite.close())
const { compile, defaultLibrary, effectiveYaml, restoreLibrary, withoutSubscription } = await vite.ssrLoadModule('/src/model.ts')
const { parseSettings } = await vite.ssrLoadModule('/src/configuration.ts')
const { mergeAppPolicyRules, mergeStandaloneHostRule } = await vite.ssrLoadModule('@/shared/proxy/connection-policy.ts')

function subscription(id, rules) {
  const yaml = stringify({
    proxies: [{ name: 'Node', type: 'http', server: '127.0.0.1', port: 8080 }],
    'proxy-groups': [{ name: 'Group', type: 'select', proxies: ['Node'] }],
    rules,
  })
  return { id, name: id, yaml, original: yaml, updated: 0 }
}

const firstRule = 'DOMAIN,first.example,DIRECT'
const secondRule = 'DOMAIN,second.example,DIRECT'
const custom = { enabled: true, matcher: 'domain', value: 'second.example', target: { kind: 'reject' } }
const library = {
  ...defaultLibrary,
  sources: [subscription('first', [firstRule, 'MATCH,DIRECT']), subscription('second', [secondRule, 'MATCH,Group']), subscription('empty', [])],
  choice: { type: 'node', id: 'second/Node' },
  routing: { ...defaultLibrary.routing, rules: [custom] },
}
const legacy = { ...library.routing, subscriptionId: 'first', inheritRules: false, fallback: { kind: 'selected' } }

test('old saved bindings and an unchecked switch cannot override the selected node', () => {
  const restored = restoreLibrary({ ...library, routing: legacy })
  assert.deepEqual(parseSettings(stringify({ routing: legacy })).routing, restored.routing)
  const second = compile(restored).plan.config.rules
  assert.equal(second[0], 'DOMAIN,second.example,REJECT')
  assert.ok(second.includes(secondRule))
  assert.ok(!second.includes(firstRule))
  assert.equal(second.at(-1), 'MATCH,GLOBAL')
  const first = compile({ ...restored, choice: { type: 'node', id: 'first/Node' } }).plan.config.rules
  assert.ok(first.includes(firstRule))
  assert.ok(!first.includes(secondRule))
  assert.equal(first.at(-1), 'MATCH,DIRECT')
})

test('group, chain exit and subscription preview use the corresponding source', () => {
  assert.equal(compile({ ...library, choice: { type: 'group', id: 'first:group:Group' } }).ruleSourceId, 'first')
  const chain = { id: 'chain', name: 'Two hops', hops: ['first/Node', 'second/Node'] }
  assert.equal(compile({ ...library, chains: [chain], choice: { type: 'chain', id: chain.id } }).ruleSourceId, 'second')
  const preview = parse(effectiveYaml(library, 'first')).rules
  assert.ok(preview.includes(firstRule))
  assert.ok(!preview.includes(secondRule))
})

test('a source without rules and a mixed group never inherit another subscription', () => {
  const empty = compile({ ...library, choice: { type: 'node', id: 'empty/Node' } }).plan.config.rules
  assert.ok(!empty.includes(firstRule) && !empty.includes(secondRule))
  assert.ok(empty.includes('GEOSITE,cn,DIRECT'))
  const mixed = { id: 'mixed', name: 'Mixed', type: 'url-test', members: ['first/Node', 'second/Node'] }
  assert.equal(compile({ ...library, groups: [mixed], choice: { type: 'group', id: mixed.id } }).ruleSourceId, '')
})

test('explicit user fallbacks survive migration and deleting a different source', () => {
  const restored = restoreLibrary({ ...library, routing: { ...legacy, fallback: { kind: 'reject' } } })
  assert.equal(compile(withoutSubscription(restored, 'first')).plan.config.rules.at(-1), 'MATCH,REJECT')
  const pinnedExit = parseSettings(stringify({ routing: { rules: [], fallback: { kind: 'selected' } } }))
  assert.equal(pinnedExit.routing.fallback.kind, 'selected')
})

test('connection policies persist as custom rules and direct apps stay in the monitored VPN', () => {
  const pkg = 'com.xingin.xhs'
  const appRules = mergeAppPolicyRules([], {
    processMatcher: 'processName', processValue: pkg, coarseTarget: { kind: 'direct' }, fineRules: [],
  })
  const rules = mergeStandaloneHostRule(appRules, {
    hostMatcher: 'domain', hostValue: 'only.example', target: { kind: 'reject' },
  })
  const saved = restoreLibrary({ ...library, routing: { ...library.routing, rules } })
  assert.deepEqual(saved.routing.rules, rules)
  const { plan } = compile(saved)
  assert.ok(plan.config.rules.includes('PROCESS-NAME,' + pkg + ',DIRECT'))
  assert.ok(plan.config.rules.includes('DOMAIN,only.example,REJECT'))
  assert.ok(!plan.tunnel.disallowedApplications?.includes(pkg))
})

test('node, group context, subscription and saved chain resolve the closest explicit binding', () => {
  const ruleLibrary = { sets: [{ id: 'u', name: 'U', profile: { rules: ['DOMAIN,custom.test,DIRECT', 'MATCH,PROXY'] } }],
    bindings: { 'subscription:second': 'user:u', 'group:mix': 'none', 'chain:new': 'subscription:first' } }
  const base = { ...library, groups: [{ id: 'mix', name: 'Mix', type: 'select', members: ['second/Node'] }],
    routing: { ...library.routing, ruleLibrary } }
  const run = extra => compile({ ...base, ...extra }).plan.config.rules
  assert.ok(run({}).includes('DOMAIN,custom.test,DIRECT'))
  const grouped = { type: 'node', id: 'second/Node', groupId: 'mix' }
  assert.ok(run({ choice: grouped }).includes('GEOSITE,cn,DIRECT'))
  ruleLibrary.bindings['node:second/Node'] = 'subscription:first'
  assert.equal(run({ choice: grouped }).at(-1), 'MATCH,DIRECT')
  const chain = { id: 'new', name: 'New', inheritExitRules: false, hops: ['first/Node','second/Node'] }
  const picked = { chains: [chain], choice: { type: 'chain', id: 'new' } }
  assert.ok(run(picked).includes(firstRule))
  delete ruleLibrary.bindings['chain:new']
  assert.ok(run(picked).includes('GEOIP,CN,DIRECT,no-resolve'))
  assert.deepEqual(restoreLibrary(base).routing.ruleLibrary, ruleLibrary)
  assert.deepEqual(parseSettings(stringify({routing:base.routing})).routing.ruleLibrary,ruleLibrary)
})
