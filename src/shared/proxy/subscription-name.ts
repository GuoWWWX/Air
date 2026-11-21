interface NamedSource {
  id: string
  name: string
  baseName?: string
}

function availableName(base: string, occupied: Set<string>) {
  let name = base
  let suffix = 1
  while (occupied.has(name)) name = base + ' (' + suffix++ + ')'
  return name
}

export function subscriptionLabel(base: string, sources: NamedSource[], previous?: NamedSource) {
  const occupied = new Set(sources.filter(source => source.id !== previous?.id).map(source => source.name))
  const keep = previous && (previous.baseName ?? previous.name) === base && !occupied.has(previous.name)
  const name = keep ? previous.name : availableName(base, occupied)
  return { name, baseName: name === base ? undefined : base }
}

export function repairSubscriptionNames<T extends NamedSource>(sources: T[]): T[] {
  const occupied = new Set(sources.map(source => source.name))
  const seen = new Set<string>()
  return sources.map(source => {
    if (!seen.has(source.name)) {
      seen.add(source.name)
      return source
    }
    const base = source.baseName ?? source.name
    const name = availableName(base, occupied)
    occupied.add(name)
    return { ...source, baseName: base, name }
  })
}
