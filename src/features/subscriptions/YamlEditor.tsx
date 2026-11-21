import { Check, Download, RotateCcw, X } from 'lucide-react'
import { useEffect, useRef, useState, type FormEvent, type UIEvent } from 'react'
import { cn } from '@/shared/lib/utils'
import { Button } from '@/shared/ui/button'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/shared/ui/dialog'
import { Segmented } from '@/shared/ui/segmented'
import { showMessage } from '@/shared/ui/message'
import { air } from '@/platform/desktop/air'

const yamlViews = [
  { value: 'local', label: '本地副本' },
  { value: 'original', label: '订阅原文' },
  { value: 'effective', label: '生效配置' },
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

  const source =
    view === 'local'
      ? draft
      : view === 'original'
        ? doc?.original ?? ''
        : runtime

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

  async function save(event: FormEvent) {
    event.preventDefault()
    if (!doc || view !== 'local' || validation !== '') return
    setSaving(true)
    try {
      await air.saveYaml(sourceId, draft)
      showMessage({ type: 'success', title: 'YAML 已保存并应用' })
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
      showMessage({ type: 'success', title: '已恢复订阅原文' })
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
    showMessage({ type: 'success', title: 'YAML 已导出' })
  }

  return (
    <Dialog open onOpenChange={open => { if (!open) onClose() }}>
      <DialogContent className="h-[min(640px,88vh)] max-w-[780px] gap-0 p-5">
        <form onSubmit={event => void save(event)} className="flex min-h-0 flex-1 flex-col gap-3">
          <DialogHeader className="shrink-0 border-b border-border pb-3">
            <DialogTitle>编辑 YAML</DialogTitle>
            <Button type="button" variant="ghost" size="icon-sm" aria-label="关闭 YAML" onClick={onClose}>
              <X />
            </Button>
          </DialogHeader>

          <div className="flex shrink-0 items-center justify-between gap-2">
            <Segmented
              layoutId="yaml-view-tabs"
              ariaLabel="YAML 视图"
              value={view}
              options={yamlViews}
              onChange={setView}
            />
            <Button type="button" variant="secondary" size="sm" disabled={!doc} onClick={exportYaml}>
              <Download data-icon="inline-start" />
              导出 YAML
            </Button>
          </div>

          <div className="yaml-editor-shell">
            <pre ref={highlight} aria-hidden="true">
              {source.split('\n').map((line, lineIndex) => (
                <span key={lineIndex}>
                  <span className="yaml-line-number">{lineIndex + 1}</span>
                  {line
                    .split(/("(?:\\.|[^"\\])*"|'(?:''|[^'])*'|#[^\n]*|[\w-]+(?=\s*:)|\b(?:true|false|null|\d+)\b)/g)
                    .map((token, index) => (
                      <span key={index} className={tokenClass(token, index)}>
                        {token}
                      </span>
                    ))}
                  {'\n'}
                </span>
              ))}
            </pre>
            <textarea
              value={source}
              onChange={event => {
                setDraft(event.target.value)
                setValidation(undefined)
              }}
              aria-label="订阅 YAML"
              spellCheck={false}
              wrap="off"
              disabled={!doc || saving}
              readOnly={view !== 'local'}
              onScroll={scroll}
            />
          </div>

          <DialogFooter className="shrink-0 border-t border-border pt-3">
            <span
              role="status"
              className={cn(
                'text-xs font-medium',
                validation === ''
                  ? 'text-success'
                  : validation
                    ? 'text-destructive'
                    : 'text-muted-foreground',
              )}
            >
              {validation ||
                (view === 'local'
                  ? validation === ''
                    ? '校验通过'
                    : '正在校验…'
                  : view === 'original'
                    ? '订阅原文 · 只读'
                    : '生效配置 · 只读')}
            </span>

            <div className="flex items-center gap-2">
              {view === 'local' && (
                <Button type="submit" variant="default" disabled={!doc || validation !== '' || saving}>
                  <Check data-icon="inline-start" />
                  保存并应用
                </Button>
              )}
              {view === 'original' && (
                <Button
                  type="button"
                  variant="secondary"
                  disabled={!doc?.local || saving}
                  onClick={() => void restore()}
                >
                  <RotateCcw data-icon="inline-start" />
                  使用订阅原文
                </Button>
              )}
            </div>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
