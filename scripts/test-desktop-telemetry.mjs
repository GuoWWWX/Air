import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { after, test } from 'node:test'
import { createServer } from 'vite'

const root = resolve(import.meta.dirname, '..')
const vite = await createServer({
  root, configFile: false, resolve: { alias: { '@': resolve(root, 'src') } },
  server: { middlewareMode: true, hmr: false, watch: null },
  optimizeDeps: { noDiscovery: true }, logLevel: 'silent',
})
after(() => vite.close())
const { appendTelemetry } = await vite.ssrLoadModule('/src/features/proxy/useProxy.ts')

const row = { id: 'a', app: 'App', appIconKey: 'icon', target: 'example.test:443', closed: false }
const packet = { sessionId: 'one', sampledAt: 100, revision: 1, stale: false, uploadRate: 1, downloadRate: 2,
  connections: [row], connectionLogs: [], logOrder: ['a'], appIcons: { icon: 'png' } }

test('closed rows keep attribution and icons across deltas, eviction and same-tick clear', () => {
  const active = appendTelemetry(undefined, packet)
  const closed = { ...row, closed: true }
  const next = { ...packet, connections: [], sampledAt: 200, revision: 2, connectionLogs: [closed], appIcons: {} }
  const history = appendTelemetry(active, next)
  assert.deepEqual(history.connectionLogs, [closed])
  assert.deepEqual(history.appIcons, { icon: 'png' })
  const unchanged = appendTelemetry(history, { ...next, revision: 3, sampledAt: 300, connectionLogs: [] })
  assert.equal(unchanged.connectionLogs[0], history.connectionLogs[0])
  const clear = appendTelemetry(unchanged, { ...next, sampledAt: 300, revision: 4, connectionLogs: [], logOrder: [] })
  assert.deepEqual(clear.connectionLogs, [])
  assert.deepEqual(clear.appIcons, {})
  assert.equal(clear.uploadHistory, unchanged.uploadHistory)
})

test('a new session resets history and an incomplete delta requires a fresh snapshot', () => {
  const previous = appendTelemetry(undefined, packet)
  const next = appendTelemetry(previous, { ...packet, sessionId: 'two', logOrder: [], connections: [], appIcons: {} })
  assert.deepEqual(next.connectionLogs, [])
  assert.equal(next.uploadHistory.length, 1)
  assert.throws(() => appendTelemetry(undefined, { ...packet, connections: [] }), /Incomplete connection history/)
  const full = appendTelemetry(undefined, { ...packet, logOrder: undefined, connectionLogs: [row] })
  assert.deepEqual(full.connectionLogs, [row])
})
