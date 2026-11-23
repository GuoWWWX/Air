import { useEffect, useLayoutEffect, useRef } from 'react'
import { EditorState } from '@codemirror/state'
import { EditorView, highlightActiveLine, keymap, lineNumbers } from '@codemirror/view'
import { defaultKeymap } from '@codemirror/commands'
import { defaultHighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { yaml } from '@codemirror/lang-yaml'
import type { EditorSearchState } from '@/shared/ui/EditorSearchBar'
import { searchHighlightExtension, syncCodeMirrorSearch } from '@/shared/ui/cmSearch'

export default function YamlCodeEditor({ initial, editable, search, update }: {
  initial: string
  editable: boolean
  search?: EditorSearchState
  update: (text: string) => void
}) {
  const target = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const lastScrollTick = useRef(-1)
  const props = useRef({ initial, editable, search, update })
  useLayoutEffect(() => {
    props.current = { initial, editable, search, update }
  })
  useEffect(() => {
    const config = props.current
    const view = new EditorView({
      parent: target.current!,
      state: EditorState.create({
        doc: config.initial.includes('\r\n') ? config.initial.replace(/\r\n/g, '\n') : config.initial,
        extensions: [
          lineNumbers(), highlightActiveLine(), searchHighlightExtension,
          keymap.of(defaultKeymap), yaml(), syntaxHighlighting(defaultHighlightStyle),
          EditorState.readOnly.of(!config.editable), EditorView.editable.of(config.editable),
          EditorView.updateListener.of(event => { if (event.docChanged) config.update(event.state.doc.toString()) }),
        ],
      }),
    })
    viewRef.current = view
    if (props.current.search) {
      lastScrollTick.current = props.current.search.scrollTick
      syncCodeMirrorSearch(view, props.current.search, true)
    }
    return () => {
      viewRef.current = null
      lastScrollTick.current = -1
      view.destroy()
    }
  }, [])
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    const nextTick = search ? search.scrollTick : -1
    const shouldScroll = Boolean(search && nextTick !== lastScrollTick.current)
    lastScrollTick.current = nextTick
    syncCodeMirrorSearch(view, search, shouldScroll)
  }, [search])
  return <div className="yaml-editor" ref={target} />
}
