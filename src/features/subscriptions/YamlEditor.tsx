import { tr } from '@/shared/i18n/messages'
import { Check, Download, RotateCcw, Search, X } from 'lucide-react'
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type UIEvent } from 'react'
import { cn } from '@/shared/lib/utils'
import { Button } from '@/shared/ui/button'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/shared/ui/dialog'
import { EditorSearchBar, normalizeLineEndings, renderMatchedText, useEditorSearch } from '@/shared/ui/EditorSearchBar'
import { Segmented } from '@/shared/ui/segmented'
import { showMessage } from '@/shared/ui/message'
import { air } from '@/platform/desktop/air'

const yamlViews = [
  { value: 'local', get label() { return tr('本地副本') } },
  { value: 'original', get label() { return tr('订阅原文') } },
  { value: 'effective', get label() { return tr('生效配置') } },
] as const

function tokenClass(token: string, index: number) {
  if (index % 2 === 0) return ''
  if (token.startsWith('#')) return 'yaml-comment'
  if (/^["']/.test(token)) return 'yaml-string'
  if (/^(?:true|false|null|\d+)$/.test(token)) return 'yaml-value'
  return 'yaml-key'
}

export function YamlEditor({
  sourceId,
  onClose,
  onSaved,
  onError,
}: {
  sourceId: string
  onClose: () => void
  onSaved: () => void
  onError: (error: unknown) => void
}) {
  const [doc, setDoc] = useState<{ original: string; local: string | null }>()
  const [runtime, setRuntime] = useState('')
  const [draft, setDraft] = useState('')
  const [view, setView] = useState<'local' | 'original' | 'effective'>('local')
  const [validation, setValidation] = useState<string>()
  const [saving, setSaving] = useState(false)
  const highlight = useRef<HTMLPreElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const lastScrollTick = useRef(-1)

  const source =
    view === 'local'
      ? draft
      : view === 'original'
        ? doc?.original ?? ''
        : runtime

  const normalizedSource = useMemo(() => normalizeLineEndings(source), [source])
  const search = useEditorSearch(normalizedSource, {
    enableShortcut: true,
    canOpen: Boolean(doc),
    resetKey: view,
  })

  useEffect(() => {
    let current = true
    void air
      .sourceDocument(sourceId)
      .then(yaml => {
        if (current) {
          setDoc(yaml)
          setDraft(yaml.local ?? yaml.original)
        }
      })
      .catch(error => {
        if (current) {
          onError(error)
          onClose()
        }
      })
    return () => {
      current = false
    }
  }, [sourceId])

  useEffect(() => {
    setValidation(undefined)
    if (!doc || view !== 'local') return
    let current = true
    const timer = setTimeout(async () => {
      try {
        await air.validateYaml(draft)
        if (current) setValidation('')
      } catch (error) {
        if (current) setValidation(String(error))
      }
    }, 280)
    return () => {
      current = false
      clearTimeout(timer)
    }
  }, [draft, doc, view])

  useEffect(() => {
    if (view !== 'effective') return
    let active = true
    void air.subscriptionYaml(sourceId, true).then(yaml => { if (active) setRuntime(yaml) })
      .catch(error => {
        if (active) showMessage({ type: 'error', title: error instanceof Error ? error.message : String(error) })
      })
    return () => { active = false }
  }, [sourceId, view])

  function scroll(event: UIEvent<HTMLTextAreaElement>) {
    if (!highlight.current) return
    highlight.current.scrollTop = event.currentTarget.scrollTop
    highlight.current.scrollLeft = event.currentTarget.scrollLeft
  }

  useLayoutEffect(() => {
    if (!search.open || search.activeIndex < 0) {
      if (!search.open) lastScrollTick.current = -1
      return
    }
    if (search.scrollTick === lastScrollTick.current) return
    const pre = highlight.current
    const ta = textareaRef.current
    const mark = pre?.querySelector<HTMLElement>('[data-active-match="true"]')
    if (!pre || !ta || !mark) return
    lastScrollTick.current = search.scrollTick
    const maxTop = Math.max(0, ta.scrollHeight - ta.clientHeight)
    const targetTop = Math.min(maxTop, Math.max(0, mark.offsetTop - ta.clientHeight / 2 + mark.offsetHeight / 2))
    let targetLeft = ta.scrollLeft
    const gutterWidth = 54
    if (mark.offsetLeft < ta.scrollLeft + gutterWidth + 8 || mark.offsetLeft + mark.offsetWidth > ta.scrollLeft + ta.clientWidth - 20) {
      const maxLeft = Math.max(0, ta.scrollWidth - ta.clientWidth)
      targetLeft = Math.min(maxLeft, Math.max(0, mark.offsetLeft - Math.max(gutterWidth + 18, ta.clientWidth * 0.25)))
    }
    ta.scrollTop = targetTop
    pre.scrollTop = targetTop
    ta.scrollLeft = targetLeft
    pre.scrollLeft = targetLeft
  }, [search.open, search.activeIndex, search.scrollTick, view])

  async function save(event: FormEvent) {
    event.preventDefault()
    if (!doc || view !== 'local' || validation !== '') return
    setSaving(true)
    try {
      await air.saveYaml(sourceId, draft)
      showMessage({ type: 'success', title: tr('YAML 已保存并应用') })
      onSaved()
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      setValidation(msg)
      showMessage({ type: 'error', title: msg })
    } finally {
      setSaving(false)
    }
  }

  async function restore() {
    setSaving(true)
    try {
      await air.restoreSourceYaml(sourceId)
      showMessage({ type: 'success', title: tr('已恢复订阅原文') })
      onSaved()
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      setValidation(msg)
      showMessage({ type: 'error', title: msg })
    } finally {
      setSaving(false)
    }
  }

  function exportYaml() {
    const url = URL.createObjectURL(new Blob([source], { type: 'application/yaml' }))
    const link = window.document.createElement('a')
    link.href = url
    link.download = 'subscription.yaml'
    link.click()
    window.setTimeout(() => URL.revokeObjectURL(url), 1000)
    showMessage({ type: 'success', title: tr('YAML 已导出') })
  }

  const renderedLines = useMemo(() => {
    const lines = normalizedSource.split('\n')
    const matches = search.searchState?.matches ?? []
    const activeIndex = search.searchState?.activeIndex ?? -1
    let lineOffset = 0
    let matchCursor = 0
    return lines.map((line, lineIndex) => {
      const lineStart = lineOffset
      const lineEnd = lineStart + line.length
      lineOffset = lineEnd + 1
      while (matchCursor < matches.length && matches[matchCursor].to <= lineStart) {
        matchCursor++
      }
      let lineMatchEnd = matchCursor
      while (lineMatchEnd < matches.length && matches[lineMatchEnd].from < lineEnd) {
        lineMatchEnd++
      }
      const lineMatches = matchCursor < lineMatchEnd ? matches.slice(matchCursor, lineMatchEnd) : undefined
      const localActiveIndex = lineMatches ? activeIndex - matchCursor : -1
      let tokenOffset = lineStart
      return (
        <span key={lineIndex}>
          <span className="yaml-line-number">{lineIndex + 1}</span>
          {line
            .split(/("(?:\\.|[^"\\])*"|'(?:''|[^'])*'|#[^\n]*|[\w-]+(?=\s*:)|\b(?:true|false|null|\d+)\b)/g)
            .map((token, index) => {
              const start = tokenOffset
              tokenOffset += token.length
              return (
                <span key={index} className={tokenClass(token, index)}>
                  {lineMatches ? renderMatchedText(token, start, lineMatches, localActiveIndex) : token}
                </span>
              )
            })}
          {'\n'}
        </span>
      )
    })
  }, [normalizedSource, search.searchState])

  return (
    <Dialog open onOpenChange={open => { if (!open && !saving) onClose() }}>
      <DialogContent className="h-[min(640px,88vh)] max-w-[780px] gap-0 p-5">
        <form onSubmit={event => void save(event)} className="flex min-h-0 flex-1 flex-col gap-3">
          <DialogHeader className="shrink-0 border-b border-border pb-3">
            <DialogTitle>{tr("编辑 YAML")}</DialogTitle>
            <Button type="button" variant="ghost" size="icon-sm" disabled={saving} aria-label={tr("关闭 YAML")} onClick={onClose}>
              <X />
            </Button>
          </DialogHeader>

          <div className="flex shrink-0 items-center justify-between gap-2">
            <Segmented
              layoutId="yaml-view-tabs"
              ariaLabel={tr("YAML 视图")}
              value={view}
              options={yamlViews}
              onChange={setView}
            />
            <div className="flex items-center gap-1.5">
              <Button
                type="button"
                variant={search.open ? 'subtle' : 'outline'}
                size="icon-sm"
                title={tr("查找配置内容 (Ctrl+F)")}
                aria-label={tr("查找配置内容")}
                aria-pressed={search.open}
                disabled={!doc}
                onClick={search.toggleSearch}
              >
                <Search />
              </Button>
              <Button type="button" variant="secondary" size="sm" disabled={!doc} onClick={exportYaml}>
                <Download data-icon="inline-start" />{tr("导出 YAML")}</Button>
            </div>
          </div>

          <EditorSearchBar {...search.barProps} className="rounded-lg border border-border bg-muted/55 px-2.5 py-1.5 dark:bg-background/60" />

          <div className="yaml-editor-shell">
            <pre ref={highlight} aria-hidden="true">
              {renderedLines}
            </pre>
            <textarea
              ref={textareaRef}
              value={source}
              onChange={event => {
                setDraft(event.target.value)
                setValidation(undefined)
              }}
              aria-label={tr("订阅 YAML")}
              spellCheck={false}
              wrap="off"
              disabled={!doc || saving}
              readOnly={view !== 'local'}
              onScroll={scroll}
            />
          </div>

          <DialogFooter className="shrink-0 gap-3 border-t border-border pt-3">
            {(() => {
              const statusText =
                validation ||
                (view === 'local'
                  ? validation === ''
                    ? tr('校验通过')
                    : tr('正在校验…')
                  : view === 'original'
                    ? tr('订阅原文 · 只读')
                    : tr('生效配置 · 只读'))
              return (
                <span
                  role="status"
                  title={statusText}
                  className={cn(
                    'min-w-0 flex-1 truncate text-xs font-medium',
                    validation === ''
                      ? 'text-success'
                      : validation
                        ? 'text-destructive'
                        : 'text-muted-foreground',
                  )}
                >
                  {statusText}
                </span>
              )
            })()}

            <div className="flex shrink-0 items-center gap-2">
              {view === 'local' && (
                <Button type="submit" variant="default" disabled={!doc || validation !== '' || saving}>
                  <Check data-icon="inline-start" />{tr("保存并应用")}</Button>
              )}
              {view === 'original' && (
                <Button
                  type="button"
                  variant="secondary"
                  disabled={!doc?.local || saving}
                  onClick={() => void restore()}
                >
                  <RotateCcw data-icon="inline-start" />{tr("使用订阅原文")}</Button>
              )}
            </div>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
