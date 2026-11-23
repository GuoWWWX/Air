import { preferences } from '@/shared/lib/preferences'
import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import type { Library } from '@/platform/desktop/air'

const SELECTED_KEY = 'air.subscriptionSelected'
const KNOWN_KEY = 'air.subscriptionKnown'

function loadStringArray(key: string): string[] {
  try {
    const parsed: unknown = JSON.parse(preferences.getItem(key) ?? 'null')
    if (Array.isArray(parsed)) {
      return parsed.filter((item): item is string => typeof item === 'string')
    }
  } catch {
    /* Ignore invalid saved list. */
  }
  return []
}

function isSubscriptionSource(source: Library['sources'][number]) {
  return source.id !== 'custom' && source.details?.kind !== 'custom'
}

function reconcileSelected(
  selected: readonly string[],
  subscriptionIds: readonly string[],
  known: ReadonlySet<string>,
): string[] {
  const valid = new Set(subscriptionIds)
  const seen = new Set<string>()
  const next: string[] = []
  for (const id of selected) {
    if (valid.has(id) && !seen.has(id)) {
      seen.add(id)
      next.push(id)
    }
  }
  for (const id of subscriptionIds) {
    if (!known.has(id) && !seen.has(id)) {
      seen.add(id)
      next.push(id)
    }
  }
  return next
}

function sameList(a: readonly string[], b: readonly string[]) {
  return a.length === b.length && a.every((value, index) => value === b[index])
}

export function useSelectedSubscriptions(sources: Library['sources'], loaded: boolean) {
  const [selected, setSelected] = useState<string[]>(() => loadStringArray(SELECTED_KEY))
  const knownRef = useRef<Set<string>>(new Set(loadStringArray(KNOWN_KEY)))

  const subscriptionIds = useMemo(
    () => sources.filter(isSubscriptionSource).map(source => source.id),
    [sources],
  )
  const subscriptionIdsRef = useRef(subscriptionIds)
  subscriptionIdsRef.current = subscriptionIds

  const effectiveSelected = useMemo(
    () => reconcileSelected(selected, subscriptionIds, knownRef.current),
    [selected, subscriptionIds],
  )

  useEffect(() => {
    if (!loaded) return
    const nextKnown = new Set(subscriptionIds)
    const nextSelected = reconcileSelected(selected, subscriptionIds, knownRef.current)
    knownRef.current = nextKnown
    preferences.setItem(KNOWN_KEY, JSON.stringify([...nextKnown]))
    preferences.setItem(SELECTED_KEY, JSON.stringify(nextSelected))
    if (!sameList(nextSelected, selected)) {
      setSelected(nextSelected)
    }
  }, [loaded, subscriptionIds, selected])

  const setSelectedSubscriptionIds: Dispatch<SetStateAction<string[]>> = useCallback(action => {
    setSelected(previous => {
      const base = reconcileSelected(previous, subscriptionIdsRef.current, knownRef.current)
      return typeof action === 'function' ? action(base) : action
    })
  }, [])

  const selectAllSubscriptions = useCallback(() => {
    setSelected([...subscriptionIdsRef.current])
  }, [])

  return {
    selectedSubscriptionIds: effectiveSelected,
    setSelectedSubscriptionIds,
    selectAllSubscriptions,
    totalSubscriptionCount: subscriptionIds.length,
  }
}
