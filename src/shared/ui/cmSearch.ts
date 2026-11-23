import { EditorSelection, StateEffect, StateField } from '@codemirror/state'
import { Decoration, EditorView, type DecorationSet } from '@codemirror/view'
import { foldedRanges, unfoldEffect } from '@codemirror/language'
import type { EditorSearchState } from './EditorSearchBar'

interface SearchHighlightPayload {
  matches: readonly { from: number; to: number }[]
  activeIndex: number
}

const setSearchHighlight = StateEffect.define<SearchHighlightPayload>()
const matchMark = Decoration.mark({ class: 'air-cm-search-match' })
const activeMatchMark = Decoration.mark({ class: 'air-cm-search-match-active' })

export const searchHighlightExtension = StateField.define<DecorationSet>({
  create() {
    return Decoration.none
  },
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setSearchHighlight)) {
        const docLen = tr.state.doc.length
        const { matches, activeIndex } = effect.value
        const ranges = []
        for (let i = 0; i < matches.length; i++) {
          const from = Math.min(docLen, Math.max(0, matches[i].from))
          const to = Math.min(docLen, Math.max(0, matches[i].to))
          if (to > from) {
            ranges.push((i === activeIndex ? activeMatchMark : matchMark).range(from, to))
          }
        }
        return Decoration.set(ranges, true)
      }
    }
    return tr.docChanged ? value.map(tr.changes) : value
  },
  provide: field => EditorView.decorations.from(field),
})

export function syncCodeMirrorSearch(
  view: EditorView,
  search: EditorSearchState | undefined,
  shouldScroll: boolean,
) {
  if (!search || search.matches.length === 0) {
    view.dispatch({ effects: setSearchHighlight.of({ matches: [], activeIndex: -1 }) })
    return
  }
  const docLen = view.state.doc.length
  const idx = search.activeIndex
  const effects: StateEffect<unknown>[] = [
    setSearchHighlight.of({ matches: search.matches, activeIndex: idx }),
  ]
  if (shouldScroll && idx >= 0 && idx < search.matches.length) {
    const match = search.matches[idx]
    const from = Math.min(docLen, Math.max(0, match.from))
    const to = Math.min(docLen, Math.max(from, match.to))
    foldedRanges(view.state).between(from, to, (fFrom, fTo) => {
      effects.push(unfoldEffect.of({ from: fFrom, to: fTo }))
    })
    effects.push(EditorView.scrollIntoView(EditorSelection.range(from, to), { y: 'center', x: 'nearest' }))
    view.dispatch({ selection: EditorSelection.range(from, to), effects })
    return
  }
  view.dispatch({ effects })
}
