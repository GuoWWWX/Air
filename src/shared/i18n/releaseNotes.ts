const LANG_TAG = /<!--\s*lang:([a-zA-Z0-9_-]+)\s*-->/gi

function trimSeparators(text: string): string {
  return text
    .trim()
    .replace(/^(?:---+\s*\r?\n)+/, '')
    .replace(/(?:\r?\n\s*---+)+$/, '')
    .trim()
}

export function selectLocalizedNotes(raw: string, languageCode: string): string {
  const matches = [...raw.matchAll(LANG_TAG)]
  if (!matches.length) return raw.trim()

  const sections = matches
    .map((match, index) => {
      const start = (match.index ?? 0) + match[0].length
      const end = index + 1 < matches.length ? (matches[index + 1].index ?? raw.length) : raw.length
      return {
        tag: match[1].trim().toLowerCase(),
        body: trimSeparators(raw.slice(start, end)),
      }
    })
    .filter(section => section.body.length > 0)

  if (!sections.length) return raw.trim()

  const target = languageCode.trim().toLowerCase()
  const exact = sections.find(section => section.tag === target)
  if (exact) return exact.body

  const primary = target.split(/[-_]/)[0]
  if (primary) {
    const byPrimary = sections.find(section => section.tag.split(/[-_]/)[0] === primary)
    if (byPrimary) return byPrimary.body
  }

  return (
    sections.find(section => section.tag === 'en' || section.tag.startsWith('en-'))?.body
    ?? sections[0].body
  )
}
