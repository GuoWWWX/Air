/** Snapshot the displayed order, starting at the current page and wrapping once. */
export function orderedProbeIds(nodes: readonly { id: string }[], selected: readonly string[] = [], start = 0) {
  const ids = nodes.slice(start).concat(nodes.slice(0, start)).map(node => node.id)
  if (!selected.length) return ids
  const remaining = new Set(selected)
  const ordered = ids.filter(id => remaining.delete(id))
  // Selections retained across filters follow the nodes in the current view.
  return [...ordered, ...remaining]
}
