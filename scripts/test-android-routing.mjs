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

test('software rows collect path and process exceptions while preserving unrelated priorities', async () => {
  const {ruleRows, replaceRuleRows, moveRuleRow, toggleRuleRow} = await vite.ssrLoadModule('@/shared/proxy/rule-rows.ts')
  const app = { ...custom, matcher:'processName', value:'Example.EXE' }
  const exception = {...app,hostMatcher:'domain',hostValue:'own.test'}
  const path = {...app,matcher:'processPath',value:'C:\\Apps\\Example.exe',hostMatcher:'domainSuffix',hostValue:'home.test'}
  const rows = ruleRows([app,custom,exception,path])
  assert.deepEqual(rows.map(r=>r.indices), [[0,2,3],[1]])
  const result = replaceRuleRows([app,custom,exception,path],rows[0].indices,[app,exception,path])
  assert.deepEqual(result,[exception,custom,path,app])
  assert.deepEqual(moveRuleRow(result,rows[1],rows[0]),[custom,exception,path,app])
  assert.equal(ruleRows([custom,custom]).length,2)
  const mixed = [app,{...exception,enabled:false}]
  const bucket = ruleRows(mixed)[0]
  const paused = toggleRuleRow(mixed,bucket,false)
  assert.deepEqual(toggleRuleRow(paused,bucket,true).map(rule=>rule.enabled),[true,false])
})

test('borrowed automatic groups preserve DIRECT members and original health-check strategy', () => {
  const first = library.sources[0]
  const profile = parse(first.yaml)
  profile['proxy-groups'] = [{ name:'Fallback', type:'fallback', proxies:['DIRECT','Node'], url:'https://example.org/ping', interval:91 }]
  profile.rules = ['DOMAIN,auto.test,Fallback','MATCH,DIRECT']
  const yaml = stringify(profile)
  const routing = { ...library.routing, ruleLibrary:{ sets:[],bindings:{'node:second/Node':'subscription:first'} } }
  const result = compile({...library, sources:[{...first,yaml,original:yaml},library.sources[1]], routing}).plan.config
  const alias = result.rules.find(line=>line.startsWith('DOMAIN,auto.test,')).split(',').at(-1)
  const group = result['proxy-groups'].find(item=>item.name===alias)
  assert.equal(group.type,'fallback')
  assert.equal(group.interval,91)
  assert.deepEqual(group.proxies,['DIRECT','AirNode-1'])
})
test('deleting a user template unbinds every referencing object and keeps unrelated bindings', async () => {
  const {dropBinding} = await vite.ssrLoadModule('@/shared/proxy/rule-library.ts')
  const catalog = {sets:[{id:'a'},{id:'b'}],bindings:{'node:X':'user:a','group:G':'user:a','chain:C':'user:a','subscription:S':'user:a','node:Y':'none'}}
  assert.deepEqual(dropBinding(catalog,'user:a'),{sets:[{id:'b'}],bindings:{'node:Y':'none'}})
  assert.equal(Object.keys(catalog.bindings).length,5)
})
