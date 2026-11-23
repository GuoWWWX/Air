import { preferences } from '@/shared/lib/preferences'
import { useMemo, useState } from 'react'

const key = 'air.subscription-order.v1'

export function useSubscriptionOrder<T extends { id: string }>(sources: T[]) {
  const [order, setOrder] = useState<string[]>(() => {
    try {
      const saved: unknown = JSON.parse(preferences.getItem(key) ?? '[]')
      return Array.isArray(saved) ? saved.filter((id): id is string => typeof id === 'string') : []
    } catch { return [] }
  })
  const sorted = useMemo(() => {
    const ranks = new Map(order.map((id, index) => [id, index]))
    return [...sources].sort((a, b) => (ranks.get(a.id) ?? Infinity) - (ranks.get(b.id) ?? Infinity))
  }, [sources, order])
  function move(id: string, offset: -1 | 1) {
    const next = sorted.map(source => source.id)
    const index = next.indexOf(id)
    if (index < 0 || index + offset < 0 || index + offset >= next.length) return
    next.splice(index, 1)
    next.splice(index + offset, 0, id)
    preferences.setItem(key, JSON.stringify(next))
    setOrder(next)
  }
  return { sorted, move }
}
