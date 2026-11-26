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
const { compile, createRoutingCompiler, defaultLibrary, effectiveYaml, restoreLibrary, withoutSubscription } = await vite.ssrLoadModule('/src/model.ts')
const { parseSettings } = await vite.ssrLoadModule('/src/configuration.ts')
const { mergeAppPolicyRules, mergeStandaloneHostRule } = await vite.ssrLoadModule('@/shared/proxy/connection-policy.ts')
const { orderedProbeIds } = await vite.ssrLoadModule('@/shared/proxy/probeOrder.ts')

test('manual probes start at the current page and preserve display order within a selection', () => {
  const rows = ['c', 'b', 'd', 'a'].map(id => ({ id }))
  assert.deepEqual(orderedProbeIds(rows, [], 2), ['d', 'a', 'c', 'b'])
  assert.deepEqual(orderedProbeIds(rows, ['b', 'a', 'c'], 2), ['a', 'c', 'b'])
  assert.deepEqual(orderedProbeIds(rows.slice(0, 2), ['a', 'b', 'c']), ['c', 'b', 'a'])
})

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

test('only untouched v3 and v4 network settings adopt the new defaults', () => {
  const oldProxyDns = ['https://223.5.5.5/dns-query', 'https://1.1.1.1/dns-query']
  const factoryV3 = {
    ...defaultLibrary.network,
    enhancedMode: 'redir-host',
    blockQuic: false,
    proxyServerNameserver: oldProxyDns,
  }
  const upgradeV3 = network => restoreLibrary({ ...library, networkVersion: 3, network })
  assert.deepEqual(upgradeV3(factoryV3).network, defaultLibrary.network)
  for (const change of [{ tunStack: 'mixed' }, { mixedPort: 27653 }, { nameserver: ['system'] }]) {
    const edited = { ...factoryV3, ...change }
    const upgraded = upgradeV3(edited)
    assert.deepEqual(upgraded.network, edited)
    assert.deepEqual(restoreLibrary(upgraded).network, edited)
  }
  const partial = upgradeV3({ mixedPort: 27653 })
  assert.equal(partial.network.enhancedMode, 'redir-host')
  assert.equal(partial.network.blockQuic, false)
  assert.deepEqual(partial.network.proxyServerNameserver, oldProxyDns)

  const factoryV4 = { ...defaultLibrary.network, proxyServerNameserver: oldProxyDns }
  const upgradeV4 = network => restoreLibrary({ ...library, networkVersion: 4, network })
  assert.deepEqual(upgradeV4(factoryV4).network, defaultLibrary.network)
  for (const change of [{ nameserver: ['system'] }, { proxyServerNameserver: ['https://223.5.5.5/dns-query'] }]) {
    const edited = { ...factoryV4, ...change }
    const upgraded = upgradeV4(edited)
    assert.deepEqual(upgraded.network, edited)
    assert.deepEqual(restoreLibrary(upgraded).network, edited)
  }
})

test('UDP 443 fallback respects subscription rules and direct exits', () => {
  const quic = 'AND,((NETWORK,UDP),(DST-PORT,443),(NOT,((GEOSITE,cn))),(NOT,((GEOIP,CN,no-resolve)))),REJECT'
  const rules = compile(library).plan.config.rules
  assert.ok(rules.indexOf(secondRule) >= 0)
  assert.deepEqual(rules.slice(-2), [quic, 'MATCH,GLOBAL'])
  const direct = compile({ ...library, choice: { type: 'node', id: 'first/Node' } }).plan.config.rules
  assert.equal(direct.at(-1), 'MATCH,DIRECT')
  assert.ok(!direct.includes(quic))
  const disabled = compile({ ...library, network: { ...library.network, blockQuic: false } }).plan.config.rules
  assert.deepEqual(disabled, rules.filter(rule => rule !== quic))
})

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
  const pathDefault = {...path, hostMatcher:undefined, hostValue:undefined}
  assert.deepEqual(replaceRuleRows([pathDefault,exception],[0,1],[pathDefault,exception]),[exception,pathDefault])
  const disabled = {...exception,enabled:false,hostValue:'paused.test'}
  const updated = mergeAppPolicyRules([exception,disabled,custom],{
    processMatcher:pathDefault.matcher, processValue:pathDefault.value, coarseTarget:pathDefault.target, fineRules:[],
  })
  assert.deepEqual(updated.slice(0,2),[exception,disabled])
  assert.equal(updated[2].matcher,'processPath')
  const edited = mergeAppPolicyRules([exception,disabled],{
    processMatcher:app.matcher, processValue:app.value, coarseTarget:app.target, fineRules:[],
  })
  assert.deepEqual(edited,[disabled,app])
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
  const { rules, 'proxy-groups': groups } = profile
  const cloned = compile({...library, routing:{...library.routing, ruleLibrary:{
    sets:[{id:'copy',name:'Copy',profile:{rules,'proxy-groups':groups}}],
    bindings:{'node:second/Node':'user:copy'},
  }}}).plan.config
  const copiedAlias = cloned.rules.find(line => line.startsWith('DOMAIN,auto.test,')).split(',').at(-1)
  const copiedGroup = cloned['proxy-groups'].find(item => item.name === copiedAlias)
  assert.equal(copiedGroup.interval,91)
  assert.deepEqual(copiedGroup.proxies,['DIRECT','AirNode-2'])
})
test('deleting a user template unbinds every referencing object and keeps unrelated bindings', async () => {
  const { dropBinding, validateRuleLibrary } = await vite.ssrLoadModule('@/shared/proxy/rule-library.ts')
  const catalog = {sets:[{id:'a'},{id:'b'}],bindings:{'node:X':'user:a','group:G':'user:a','chain:C':'user:a','subscription:S':'user:a','node:Y':'none'}}
  assert.deepEqual(dropBinding(catalog,'user:a'),{sets:[{id:'b'}],bindings:{'node:Y':'none'}})
  assert.equal(Object.keys(catalog.bindings).length, 5)
  assert.throws(() => validateRuleLibrary({
    sets: [{ id: 'loop', name: 'Loop', profile: { rules: ['MATCH,A'], 'proxy-groups': [{ name: 'A', type: 'select', proxies: ['B'] }, { name: 'B', type: 'fallback', proxies: ['A'] }] } }],
    bindings: {},
  }))
})

test('UI changes and unrelated probes reuse the plan; changing the exit recompiles its rules', () => {
  const prepare = createRoutingCompiler()
  const initial = prepare(library)
  const next = { ...library, theme: 'dark', probes: { 'second/Node': [{ at: Date.now(), delay: 5 }] } }
  assert.equal(prepare(next).compiled, initial.compiled)
  const switched = { ...next, choice: { type: 'node', id: 'first/Node' } }
  const changed = prepare(switched)
  assert.equal(changed.model, initial.model)
  assert.notEqual(changed.compiled, initial.compiled)
  assert.deepEqual(changed.compiled.plan, compile(switched).plan)
  assert.ok(changed.compiled.plan.config.rules.includes(firstRule))
})

test('automatic groups react to changed and expired latency samples', t => {
  const now = Date.now()
  t.mock.method(Date, 'now', () => now)
  const prepare = createRoutingCompiler()
  const group = { id: 'auto', name: 'Auto', type: 'url-test', members: [],
    automatic: { sourceId: 'second', maxDelay: 100, limit: 1 } }
  const base = { ...library, groups: [group] }
  const empty = prepare(base)
  assert.equal(empty.compiled.byId.has(group.id), false)
  assert.equal(empty.expiresAt, Infinity)

  const chosen = {
    ...base,
    choice: { type: 'group', id: 'auto' },
    probes: { 'second/Node': [{ at: now, delay: 10 }] },
  }
  const measured = prepare(chosen)
  assert.equal(measured.compiled.byId.has(group.id), true)
  assert.deepEqual(measured.compiled.choice, { type: 'group', id: 'auto' })
  assert.equal(measured.expiresAt, now + 86_400_000)
  assert.equal(prepare({ ...chosen, theme: 'dark' }).compiled, measured.compiled)

  const expiredAt = now + 86_400_000
  Date.now.mock.mockImplementation(() => expiredAt)
  const expired = prepare(chosen)
  assert.equal(expired.compiled.byId.has(group.id), false)
  assert.notDeepEqual(expired.compiled.choice, { type: 'group', id: 'auto' })
  assert.equal(expired.expiresAt, Infinity)

  const multi = {
    ...chosen,
    probes: {
      'second/Node': [
        { at: expiredAt + 1000, delay: 15 },
        { at: expiredAt + 5000, delay: 10 },
      ],
    },
  }
  assert.equal(prepare(multi).expiresAt, expiredAt + 1000 + 86_400_000)
})

test('bypassLan defaults to true on restore, parse and compiled tunnel plans', () => {
  assert.equal(defaultLibrary.network.bypassLan, true)
  assert.equal(compile(defaultLibrary).plan.tunnel.bypassLan, true)

  const legacyNetwork = restoreLibrary({
    ...library,
    network: { ...library.network, bypassLan: undefined },
  })
  assert.equal(legacyNetwork.network.bypassLan, true)
  assert.equal(compile(legacyNetwork).plan.tunnel.bypassLan, true)

  const disabled = parseSettings(stringify({ network: { bypassLan: false } }))
  assert.equal(disabled.network.bypassLan, false)
  assert.equal(compile({ ...defaultLibrary, network: disabled.network }).plan.tunnel.bypassLan, false)
})
