import { tr } from '@/shared/i18n/messages'
import { useEffect, useRef, useState } from 'react'
import { Check, CircleAlert, FileCode2, FolderOpen, RotateCw, Save, Search } from 'lucide-react'
import { isTauri } from '@tauri-apps/api/core'
import { air } from '@/platform/desktop/air'
import { Button } from '@/shared/ui/button'
import { Card, CardTitle } from '@/shared/ui/card'
import { ConfigCodeEditor } from '@/shared/ui/ConfigCodeEditor'
import { EditorSearchBar, useEditorSearch } from '@/shared/ui/EditorSearchBar'
import { showMessage } from '@/shared/ui/message'

type Source = Awaited<ReturnType<typeof air.readConfigFile>>
type Draft = { source: Source; text: string }
// Keep an unsaved edit and last loaded config when the user visits another Air page and comes back.
let pending: Draft | undefined
let cachedSource: Source | undefined

export default function ConfigFilePanel() {
  const [draft, setDraft] = useState<Draft | undefined>(
    () => pending ?? (cachedSource ? { source: cachedSource, text: cachedSource.contents } : undefined),
  )
  const [generation, setGeneration] = useState(0)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState('')
  const [syntaxCount, setSyntaxCount] = useState(0)
  const [confirmReload, setConfirmReload] = useState(false)
  const [cursor, setCursor] = useState([1, 1])
  const current = useRef(draft)
  const editor = useRef<React.ComponentRef<typeof ConfigCodeEditor>>(null)
  const mounted = useRef(false)
  const working = useRef(false)
  const dirty = !!draft && draft.text !== draft.source.contents
  const search = useEditorSearch(draft?.text ?? '', {
    enableShortcut: true,
    canOpen: Boolean(draft),
    resetKey: generation,
  })

  function accept(next: Draft) {
    cachedSource = next.source
    current.current = next
    pending = next.text === next.source.contents ? undefined : next
    if (mounted.current) setDraft(next)
  }

  async function perform(operation: () => Promise<void>) {
    if (working.current) return
    working.current = true
    setBusy(true); setStatus('')
    try { await operation() }
    catch (err) {
      showMessage({ type: 'error', title: err instanceof Error ? err.message : String(err) })
    }
    finally {
      working.current = false
      if (mounted.current) setBusy(false)
    }
  }

  function reload() {
    const requested = current.current
    setConfirmReload(false)
    return perform(async () => {
      const source = await air.readConfigFile()
      if (!mounted.current) return
      if (current.current !== requested) {
        setStatus(tr('已保留刚才的修改'))
        showMessage({ type: 'info', title: tr('已保留刚才的修改') })
        return
      }
      accept({ source, text: source.contents })
      setSyntaxCount(0)
      setCursor([1, 1])
      setGeneration(n => n + 1)
      if (requested) showMessage({ type: 'success', title: tr('配置已重新读取') })
    })
  }

  useEffect(() => {
    mounted.current = true
    let active = true
    if (!current.current) {
      void reload()
    } else if (!working.current) {
      void air.readConfigFile().then(
        fresh => {
          cachedSource = fresh
          const snapshot = current.current
          if (
            !active ||
            !mounted.current ||
            working.current ||
            !snapshot ||
            snapshot.text !== snapshot.source.contents ||
            fresh.revision === snapshot.source.revision
          ) {
            return
          }
          accept({ source: fresh, text: fresh.contents })
          setSyntaxCount(0)
          setCursor([1, 1])
          setGeneration(n => n + 1)
        },
        () => undefined,
      )
    }
    return () => {
      active = false
      mounted.current = false
    }
  }, [])

  function edit(text: string) {
    if (!current.current) return
    accept({ source: current.current.source, text })
    setStatus(''); setConfirmReload(false)
  }

  function save() {
    const snapshot = current.current
    if (!snapshot) return
    const syntaxError = editor.current?.checkForSave()
    if (syntaxError) {
      setStatus('')
      showMessage({ type: 'error', title: syntaxError })
      return
    }
    void perform(async () => {
      if (snapshot.text === snapshot.source.contents) {
        await air.validateConfigFile(snapshot.text)
        if (mounted.current && current.current === snapshot) setStatus(tr('已保存'))
        showMessage({ type: 'success', title: tr('配置校验通过') })
        return
      }
      const revision = await air.saveConfigFile(snapshot.text, snapshot.source.revision)
      const latest = current.current!
      const next = { source: { contents: snapshot.text, revision }, text: latest.text }
      accept(next)
      if (mounted.current && next.text === snapshot.text) setStatus(tr('已保存'))
      showMessage({ type: 'success', title: tr('配置文件已保存') })
    })
  }

  return (
    <>
      <Card className="shrink-0 flex-row items-center justify-between gap-4 p-4">
        <CardTitle>{tr("配置文件位置")}</CardTitle>
        <Button size="sm" variant="outline" disabled={!isTauri()}
          onClick={() => void air.openConfigFolder().catch(err => showMessage({ type: 'error', title: err instanceof Error ? err.message : String(err) }))}>
          <FolderOpen data-icon="inline-start" aria-hidden />{tr("打开文件夹")}</Button>
      </Card>
      <Card className="flex min-h-64 flex-1 flex-col overflow-hidden"
        onKeyDownCapture={event => {
          if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
            event.preventDefault(); save()
          }
        }}>
        <div className="flex flex-wrap items-stretch justify-between gap-x-3 border-b border-border bg-muted/35 px-3 sm:px-5">
          <div className="flex items-center gap-2.5 border-b-2 border-primary py-3">
            <FileCode2 className="size-5 text-primary" aria-hidden />
            <span className="mono text-sm font-semibold">air-config.yaml</span>
          </div>
          <div className="flex items-center gap-1 py-1.5">
            <Button variant={search.open ? 'subtle' : 'ghost'} size="icon-sm" title={tr("查找配置内容 (Ctrl+F)")} aria-label={tr("查找配置内容")} aria-pressed={search.open} disabled={!draft}
              onClick={search.toggleSearch}><Search /></Button>
            <Button variant="ghost" size="icon-sm" title={tr("重新读取")} aria-label={tr("重新读取")} disabled={busy}
              onClick={() => dirty ? setConfirmReload(true) : void reload()}><RotateCw /></Button>
            <Button variant="default" size="sm" disabled={busy || !draft || (!dirty && !syntaxCount)} title={tr("保存 (Ctrl+S)")} onClick={save}><Save data-icon="inline-start" />{tr("保存")}</Button>
          </div>
        </div>
        <EditorSearchBar {...search.barProps} className="border-b border-border bg-muted/25 px-3 py-1.5 sm:px-5" />
        {confirmReload && <div role="alert" className="flex flex-wrap items-center gap-2 border-b border-warning/35 bg-warning-soft px-4 py-2 text-sm text-foreground">
          <span className="mr-auto">{tr("放弃未保存的修改并重新读取？")}</span>
          <Button size="sm" variant="ghost" onClick={() => setConfirmReload(false)}>{tr("取消")}</Button>
          <Button size="sm" variant="outline" onClick={() => void reload()}>{tr("放弃并读取")}</Button>
        </div>}
        {draft ? <ConfigCodeEditor ref={editor} key={generation} initialText={draft.text} search={search.searchState} onEdit={edit} onSyntaxCount={setSyntaxCount} onCursor={(line, col) => setCursor([line, col])} />
          : <div className="min-h-0 flex-1 p-4 text-muted-foreground">{busy ? tr('正在读取配置…') : ''}</div>}
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border bg-muted/35 px-4 py-2 text-xs text-muted-foreground">
          <span role="status" className="flex items-center gap-2">
            {syntaxCount ? <CircleAlert className="size-3.5 text-destructive" /> : dirty ? <span className="size-2 rounded-full bg-warning" /> : draft && <Check className="size-3.5 text-success" />}
            {syntaxCount ? tr("{0} 处语法错误", syntaxCount) : status || (dirty ? tr('未保存') : draft ? tr('已保存') : '')}
            {!isTauri() && <span>{tr("· 浏览器预览")}</span>}
          </span>
          <span className="mono">{tr('第 {0} 行，第 {1} 列', cursor[0], cursor[1])}<span className="ml-4">UTF-8</span></span>
        </div>
      </Card>
    </>
  )
}
