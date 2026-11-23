import { tr } from '@/shared/i18n/messages'
import { useCallback, useEffect, useEffectEvent, useRef, useState } from 'react'
import { air, type ProxyAction, type ProxyExit, type ProxyStatus, type ProxyTelemetry } from '@/platform/desktop/air'

const initial: ProxyStatus = {
  running: false, mode: 'rule', port: null, systemProxy: false, tun: false, tunServiceReady: null, sessionId: null, outbound: null,
}

export interface TelemetryHistory extends ProxyTelemetry {
  uploadPeak: number
  downloadPeak: number
  uploadHistory: number[]
  downloadHistory: number[]
}

function localizeConnections(connections: ProxyTelemetry['connections']) {
  return connections.map(connection => {
    const app = connection.app === '未知应用' ? tr('未知应用') : connection.app
    const target = connection.target.replace(/^未知目标(?=:|$)/u, () => tr('未知目标'))
    return app === connection.app && target === connection.target ? connection : { ...connection, app, target }
  })
}

function appendTelemetry(current: TelemetryHistory | undefined, sample: ProxyTelemetry): TelemetryHistory {
  const previous = current?.sessionId === sample.sessionId ? current : undefined
  if (previous?.sampledAt === sample.sampledAt) {
    return previous.stale === sample.stale ? previous : { ...previous, stale: sample.stale }
  }
  return {
    ...sample,
    connections: localizeConnections(sample.connections),
    ...(sample.connectionLogs ? { connectionLogs: localizeConnections(sample.connectionLogs) } : {}),
    uploadPeak: Math.max(previous?.uploadPeak ?? 0, sample.uploadRate),
    downloadPeak: Math.max(previous?.downloadPeak ?? 0, sample.downloadRate),
    uploadHistory: [...(previous?.uploadHistory.slice(-16) ?? []), sample.uploadRate],
    downloadHistory: [...(previous?.downloadHistory.slice(-16) ?? []), sample.downloadRate],
  }
}

export interface ExitLookup {
  exit?: ProxyExit
  checking: boolean
  failed: boolean
  onRefresh?: () => void
}

function useProxyExit(status: ProxyStatus): ExitLookup {
  const [attempt, setAttempt] = useState(0)
  const [result, setResult] = useState<{ key: string; value?: ProxyExit }>()
  const key = status.running && status.sessionId
    ? JSON.stringify([status.target, status.outbound?.hops.map(hop => hop.id) ?? [], attempt])
    : null
  // TUN can replace the kernel session while keeping the same active outbound.
  const lookup = useEffectEvent(() => status.sessionId ? air.proxyExit(status.sessionId) : undefined)

  useEffect(() => {
    if (key === null) {
      setResult(undefined)
      return
    }
    let active = true
    const finish = (value?: ProxyExit) => {
      if (active) setResult({ key, value })
    }
    void lookup()?.then(finish, () => finish())
    return () => { active = false }
  }, [key])

  const current = result?.key === key ? result : undefined
  return {
    exit: current?.value,
    checking: key !== null && !current,
    failed: Boolean(current && !current.value),
    onRefresh: key !== null ? () => setAttempt(previous => previous + 1) : undefined,
  }
}

export function useProxy(onError: (error: unknown) => void, options?: { liveTelemetry?: boolean }) {
  const liveTelemetry = options?.liveTelemetry ?? true
  const liveTelemetryRef = useRef(liveTelemetry)
  liveTelemetryRef.current = liveTelemetry
  const [status, setStatus] = useState(initial)
  const exitLookup = useProxyExit(status)
  const [snapshot, setSnapshot] = useState<TelemetryHistory>()
  const [pending, setPending] = useState<'start' | 'stop'>()
  const [selectingNodeId, setSelectingNodeId] = useState<string>()
  const mounted = useRef(true)
  const inFlight = useRef(0)
  const powerBusy = useRef(false)
  const nodeBusy = useRef(false)
  const revision = useRef(0)
  const queue = useRef<Promise<void>>(Promise.resolve())
  const refreshStatusRef = useRef<(() => void) | undefined>(undefined)
  const pollTelemetryRef = useRef<(() => void) | undefined>(undefined)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  useEffect(() => {
    let active = true
    let refreshing = false
    let timer: number | undefined
    function schedule() {
      window.clearTimeout(timer)
      if (active && status.running && !document.hidden) {
        timer = window.setTimeout(() => void refresh(), liveTelemetryRef.current ? 1800 : 4000)
      }
    }
    async function refresh() {
      if (document.hidden) return
      if (refreshing || inFlight.current > 0) {
        schedule()
        return
      }
      window.clearTimeout(timer)
      refreshing = true
      const version = ++revision.current
      try {
        const next = await air.proxyStatus()
        if (active && revision.current === version && inFlight.current === 0) {
          setStatus(next)
        }
      } catch (error) {
        if (active && revision.current === version) onError(error)
      } finally {
        refreshing = false
        schedule()
      }
    }
    refreshStatusRef.current = () => { void refresh() }
    void refresh()
    const onVisibility = () => { void refresh() }
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      active = false
      refreshStatusRef.current = undefined
      window.clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [onError, status.running])

  useEffect(() => {
    if (!status.sessionId) {
      setSnapshot(undefined)
      return
    }
    let active = true
    let polling = false
    let timer: number | undefined
    const sessionId = status.sessionId
    async function pollTelemetry() {
      if (document.hidden) return
      if (polling) {
        if (active) {
          window.clearTimeout(timer)
          timer = window.setTimeout(() => void pollTelemetry(), liveTelemetryRef.current ? 1000 : 2500)
        }
        return
      }
      polling = true
      window.clearTimeout(timer)
      try {
        const next = await air.proxyTelemetry()
        if (active && next?.sessionId === sessionId) {
          setSnapshot(current => appendTelemetry(current, next))
        }
      } catch {
        if (active) setSnapshot(current => current && !current.stale ? { ...current, stale: true } : current)
      } finally {
        polling = false
        if (active && !document.hidden) {
          timer = window.setTimeout(() => void pollTelemetry(), liveTelemetryRef.current ? 1000 : 2500)
        }
      }
    }
    pollTelemetryRef.current = () => { void pollTelemetry() }
    void pollTelemetry()
    const onVisibility = () => { void pollTelemetry() }
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      active = false
      pollTelemetryRef.current = undefined
      window.clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [status.sessionId])

  function control(action: ProxyAction) {
    const isPower = action.action === 'start' || action.action === 'stop'
    if ((action.action === 'selectNode' || action.action === 'selectGroup')) {
      if (powerBusy.current || nodeBusy.current) return Promise.resolve(undefined)
      nodeBusy.current = true
      setSelectingNodeId(action.id)
    }
    if (isPower) {
      if (powerBusy.current) return Promise.resolve(undefined)
      powerBusy.current = true
      setPending(action.action)
    }

    const version = ++revision.current
    inFlight.current += 1
    if (action.action === 'mode') {
      setStatus(current => ({ ...current, mode: action.mode }))
    }

    const task = queue.current.then(async () => {
      try {
        const next = await air.proxyControl(action)
        if (!mounted.current) return
        if (revision.current === version) {
          setStatus(next)
        } else {
          setStatus(current => ({ ...next, mode: current.mode }))
        }
        return next
      } catch (error) {
        onError(error)
        try {
          const real = await air.proxyStatus()
          if (mounted.current && revision.current === version) {
            setStatus(real)
          }
        } catch {
          /* Keep the last known state. */
        }
      } finally {
        inFlight.current = Math.max(0, inFlight.current - 1)
        if (isPower) {
          powerBusy.current = false
          if (mounted.current) setPending(undefined)
        }
        if ((action.action === 'selectNode' || action.action === 'selectGroup')) {
          nodeBusy.current = false
          if (mounted.current) setSelectingNodeId(undefined)
        }
      }
    })

    queue.current = task.then(() => {})
    return task
  }

  const telemetry = snapshot?.sessionId === status.sessionId ? snapshot : undefined
  function updateStatus(next: ProxyStatus) {
    revision.current += 1
    setStatus(next)
  }
  const refreshNow = useCallback(() => {
    refreshStatusRef.current?.()
    pollTelemetryRef.current?.()
  }, [])
  const clearLogs = useCallback(async () => {
    await air.clearConnectionLogs()
    setSnapshot(current =>
      current?.connectionLogs
        ? { ...current, connectionLogs: current.connectionLogs.filter(item => !item.closed) }
        : current,
    )
    pollTelemetryRef.current?.()
  }, [])
  return { status, telemetry, exitLookup, pending, selectingNodeId, control, updateStatus, refreshNow, clearLogs }
}
