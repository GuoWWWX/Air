import { useImperativeHandle, useLayoutEffect, useRef, type Ref } from 'react'
import { EditorState } from '@codemirror/state'
import { Decoration, EditorView, ViewPlugin, drawSelection, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers, type ViewUpdate } from '@codemirror/view'
import { HighlightStyle, bracketMatching, foldGutter, foldKeymap, indentUnit, syntaxHighlighting, syntaxTree } from '@codemirror/language'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { yaml } from '@codemirror/lang-yaml'
import { diagnosticCount, linter, setDiagnostics, type Diagnostic } from '@codemirror/lint'
import { tags } from '@lezer/highlight'
import { parseDocument, type YAMLParseError } from 'yaml'

function syntaxMessage(error: YAMLParseError) {
  if (error.message.includes('end with a ]')) return '检查列表的缩进，并补全右方括号 ]'
  if (error.message.includes('end with a }')) return '检查映射的缩进，并补全右花括号 }'
  if (error.message.includes('Missing closing')) return '引号没有闭合'
  switch (error.code) {
    case 'TAB_AS_INDENT': return '缩进请使用空格'
    case 'BAD_INDENT': return '同一层的项目需要对齐，请检查缩进'
    case 'DUPLICATE_KEY': return '同一层出现了重复的键名'
    case 'BAD_DQ_ESCAPE': return '双引号内的转义字符无效'
    case 'MULTIPLE_DOCS': return '配置文件只能包含一个 YAML 文档'
    default: return error.message
  }
}

function syntaxErrors(view: EditorView): Diagnostic[] {
  const text = view.state.doc.toString()
  const { errors } = parseDocument(text, { prettyErrors: false })
  return errors.map(error => {
    let from = Math.min(text.length, error.pos[0])
    // At EOF the parser often points past a trailing newline. Underline a visible character.
    if (from === text.length) from = Math.max(0, text.trimEnd().length - 1)
    const to = Math.min(view.state.doc.lineAt(from).to, Math.max(from + 1, error.pos[1]))
    return { from, to, severity: 'error', message: syntaxMessage(error) }
  })
}

const palette = HighlightStyle.define([
  { tag: tags.definition(tags.propertyName), color: 'var(--primary)', fontWeight: '600' },
  { tag: [tags.content, tags.string], color: 'var(--success)' },
  { tag: [tags.keyword, tags.labelName, tags.typeName], color: 'var(--warning)' },
  { tag: tags.comment, color: 'var(--muted-foreground)', fontStyle: 'italic' },
  { tag: [tags.punctuation, tags.meta], color: 'var(--icon-muted)' },
])

// The YAML grammar marks plain words, numbers and booleans as the same Literal node.
const scalar = Decoration.mark({ class: 'air-yaml-scalar' })
function scalarColors(view: EditorView) {
  const marks = []
  for (const { from, to } of view.visibleRanges) {
    const ranges: ReturnType<typeof scalar.range>[] = []
    syntaxTree(view.state).iterate({ from, to, enter(node) {
      if (node.name !== 'Literal' || node.node.parent?.name === 'Key' || node.to - node.from > 40) return
      if (/^(?:true|false|null|~|[-+]?\d+(?:\.\d+)?)$/i.test(view.state.sliceDoc(node.from, node.to))) {
        ranges.push(scalar.range(node.from, node.to))
      }
    } })
    marks.push(...ranges)
  }
  return Decoration.set(marks, true)
}

const plainScalars = ViewPlugin.fromClass(class {
  decorations
  constructor(view: EditorView) { this.decorations = scalarColors(view) }
  update(update: ViewUpdate) {
    if (update.docChanged || update.viewportChanged || syntaxTree(update.startState) !== syntaxTree(update.state)) {
      this.decorations = scalarColors(update.view)
    }
  }
}, { decorations: plugin => plugin.decorations })

interface Props {
  ref: Ref<{ checkForSave: () => string | undefined }>
  initialText: string
  onEdit: (value: string) => void
  onSyntaxCount: (count: number) => void
  onCursor: (line: number, column: number) => void
}

export function ConfigCodeEditor(props: Props) {
  const host = useRef<HTMLDivElement>(null)
  const editor = useRef<EditorView>(null)
  useImperativeHandle(props.ref, () => ({
    checkForSave() {
      const view = editor.current
      if (!view) return
      const diagnostics = syntaxErrors(view)
      const first = diagnostics[0]
      if (!first) return
      const line = view.state.doc.lineAt(first.from)
      view.dispatch(setDiagnostics(view.state, diagnostics), {
        selection: { anchor: first.from }, scrollIntoView: true,
      })
      view.focus()
      return `未保存 · 第 ${line.number} 行，第 ${first.from - line.from + 1} 列：${first.message}`
    },
  }), [])
  const callbacks = useRef(props)
  useLayoutEffect(() => { callbacks.current = props })
  useLayoutEffect(() => {
    const text = callbacks.current.initialText
    const eol = text.includes('\r\n') ? '\r\n' : '\n'
    const view = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: text.replace(/\r\n/g, '\n'),
        extensions: [
          yaml(), syntaxHighlighting(palette), plainScalars, linter(syntaxErrors, { delay: 220 }),
          lineNumbers(), foldGutter(), history(),
          highlightActiveLine(), highlightActiveLineGutter(), drawSelection(), bracketMatching(),
          indentUnit.of('  '), EditorState.tabSize.of(2),
          keymap.of([...defaultKeymap, ...historyKeymap, ...foldKeymap, indentWithTab]),
          EditorView.contentAttributes.of({ 'aria-label': '配置文件 YAML', spellcheck: 'false' }),
          EditorView.updateListener.of(update => {
            const count = diagnosticCount(update.state)
            if (count !== diagnosticCount(update.startState)) callbacks.current.onSyntaxCount(count)
            if (update.docChanged) callbacks.current.onEdit(update.state.doc.sliceString(0, undefined, eol))
            if (update.selectionSet || update.docChanged) {
              const head = update.state.selection.main.head
              const line = update.state.doc.lineAt(head)
              callbacks.current.onCursor(line.number, head - line.from + 1)
            }
          }),
        ],
      }),
    })
    editor.current = view
    return () => { editor.current = null; view.destroy() }
  }, [])
  return <div ref={host} className="air-config-editor min-h-0 flex-1" />
}
