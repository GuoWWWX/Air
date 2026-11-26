import { highSpeedProbe, preferences } from '@/shared/lib/preferences'
import { tr } from '@/shared/i18n/messages'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  air,
  type CustomGroup,
  type CustomGroupInput,
  type Library,
  type Progress,
} from '@/platform/desktop/air'
import { showMessage } from '@/shared/ui/message'

export function useNodes() {
  const [library, setLibrary] = useState<Library>({ nodes: [], sources: [], groups: [] })
  const [loaded, setLoaded] = useState(false)
  const [customGroups, setCustomGroups] = useState<CustomGroup[]>([])
  const [progress, setProgress] = useState<Progress>()
  const [selected, setSelected] = useState<string[]>(() => {
    try {
      const ids: unknown = JSON.parse(preferences.getItem('air.checkedNodeIds') ?? '[]')
      return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : []
    } catch { return [] }
  })
  const [testing, setTesting] = useState<string[]>([])
  const [pendingBatch, setPendingBatch] = useState<{ total: number; previousId: number }>()
  const [kernelOverride, setPath] = useState(() => preferences.getItem('air.kernelPath') ?? '')
  const [defaultKernelPath, setDefaultKernelPath] = useState('')
  const kernelPath = kernelOverride || defaultKernelPath
  const [background, setBackground] = useState(() => preferences.getItem('air.backgroundMonitoring') !== '0')
  const [backgroundError, setBackgroundError] = useState('')
  const hasNodes = library.nodes.length > 0
  const libraryQueue = useRef(Promise.resolve())
  const groupRequest = useRef(0)
  const pollQueue = useRef(Promise.resolve())
  const progressRef = useRef<Progress>(undefined)
  const inFlight = useRef(new Set<string>())
  const batching = useRef(false)
  const batchVersion = useRef(0)
  const cancelRequest = useRef(Promise.resolve())

  useEffect(() => {
    preferences.setItem('air.checkedNodeIds', JSON.stringify(selected))
  }, [selected])

  useEffect(() => {
    void air.defaultKernelPath().then(path => setDefaultKernelPath(path ?? '')).catch(() => {})
  }, [])

  useEffect(() => {
    let current = true
    void air.background(kernelPath, background && Boolean(kernelPath) && hasNodes).then(
      () => { if (current) setBackgroundError('') },
      error => {
        if (!current) return
        const text = error instanceof Error ? error.message : String(error)
        setBackgroundError(text)
        showMessage({ type: 'error', id: 'background-monitor-error', title: tr('后台监测异常'), description: text })
      },
    )
    return () => { current = false }
  }, [background, hasNodes, kernelPath])

  const refreshGroups = useCallback(async () => {
    const request = ++groupRequest.current
    const groups = await air.customGroups()
    if (request === groupRequest.current) setCustomGroups(groups)
  }, [])

  const queueLibraryUpdate = useCallback((update: () => Promise<void>) => {
    const task = libraryQueue.current.then(update)
    libraryQueue.current = task.catch(() => {})
    return task
  }, [])

  const refresh = useCallback(async () => {
    await Promise.all([refreshGroups(), queueLibraryUpdate(async () => {
      const next = await air.library()
      const valid = new Set(next.nodes.map(node => node.id))
      setSelected(previous => previous.filter(node => valid.has(node)))
      setLibrary(next)
    })])
    setLoaded(true)
  }, [queueLibraryUpdate, refreshGroups])

  const refreshMetrics = useCallback((ids: string[]) => queueLibraryUpdate(async () => {
    const metrics = new Map((await air.nodeMetrics(ids)).map(item => [item.id, item]))
    if (!metrics.size) return
    setLibrary(current => ({
      ...current,
      nodes: current.nodes.map(node => {
        const update = metrics.get(node.id)
        return update && update.probeRevision === node.probeRevision ? { ...node, ...update } : node
      }),
    }))
  }), [queueLibraryUpdate])

  const poll = useCallback(() => {
    const version = batchVersion.current
    const task = pollQueue.current.then(async () => {
      const next = await air.status()
      const prior = progressRef.current
      if (version === batchVersion.current) setProgress(next)
      const previousBatch = prior?.batchId ?? 0
      if (next.batchId > previousBatch + 1 || (prior?.running && next.batchId !== previousBatch)) {
        // A hidden window can miss completed batches between polls.
        await refresh()
      } else {
        const ids = next.completedIds.slice(prior?.batchId === next.batchId ? prior.completedIds.length : 0)
        if (ids.length) await refreshMetrics(ids)
      }
      progressRef.current = next
    })
    pollQueue.current = task.catch(() => {})
    return task
  }, [refresh, refreshMetrics])

  async function measure(id: string) {
    if (inFlight.current.has(id)) return
    inFlight.current.add(id)
    setTesting([...inFlight.current])
    try { await air.probe(kernelPath, id); await refreshMetrics([id]) }
    finally {
      inFlight.current.delete(id)
      setTesting([...inFlight.current])
    }
  }

  function isMeasuring(id: string) {
    return testing.includes(id) || progress?.activeIds.includes(id) === true
  }

  async function batch(ids: string[]) {
    if (!ids.length || batching.current) return
    const highSpeed = highSpeedProbe.get()
    const version = ++batchVersion.current
    batching.current = true
    const previousId = progressRef.current?.batchId ?? 0
    setPendingBatch({ total: ids.length, previousId })
    try {
      await cancelRequest.current
      if (version !== batchVersion.current) return
      const afterCancel = progressRef.current?.batchId ?? 0
      if (afterCancel !== previousId) setPendingBatch({ total: ids.length, previousId: afterCancel })
      await air.batch(kernelPath, ids, highSpeed)
    }
    finally {
      try { if (version === batchVersion.current) await poll() }
      finally {
        if (batchVersion.current === version) {
          batching.current = false
          setPendingBatch(undefined)
        }
      }
    }
  }

  async function cancelBatch() {
    batchVersion.current += 1
    batching.current = false
    setPendingBatch(undefined)
    setProgress(current => (current ? { ...current, running: false, activeIds: [] } : current))
    const request = air.cancelBatch().then(() => poll())
    cancelRequest.current = request.catch(() => {})
    await request
  }

  function toggleBackground(enabled: boolean) {
    setBackground(enabled)
    preferences.setItem('air.backgroundMonitoring', enabled ? '1' : '0')
  }

  async function saveCustomGroup(input: CustomGroupInput) {
    const saved = await air.saveCustomGroup(input)
    await refreshGroups()
    return saved
  }

  async function deleteCustomGroup(id: string) {
    await air.deleteCustomGroup(id)
    await refreshGroups()
  }

  async function addNodesToCustomGroup(groupId: string, nodeIds: string[]) {
    await air.changeCustomGroupMembers(groupId, 'add', nodeIds)
    await refreshGroups()
  }

  async function removeNodeFromCustomGroup(groupId: string, nodeId: string) {
    await air.changeCustomGroupMembers(groupId, 'remove', [nodeId])
    await refreshGroups()
  }

  function setKernelPath(value: string) {
    const path = value.trim()
    setPath(path)
    preferences.setItem('air.kernelPath', path)
  }

  return {
    library,
    loaded,
    customGroups,
    progress,
    selected,
    setSelected,
    isMeasuring,
    batchPending: Boolean(pendingBatch),
    batchProgress: pendingBatch
      ? progress && progress.batchId > pendingBatch.previousId && progress.total > 0
        ? progress : { completed: 0, total: pendingBatch.total }
      : progress?.running && progress.total > 0 ? progress : undefined,
    kernelPath,
    kernelOverride,
    defaultKernelPath,
    background,
    backgroundError,
    refresh,
    poll,
    measure,
    batch,
    cancelBatch,
    toggleBackground,
    saveCustomGroup,
    deleteCustomGroup,
    addNodesToCustomGroup,
    removeNodeFromCustomGroup,
    setKernelPath,
  }
}

export type Nodes = ReturnType<typeof useNodes>
