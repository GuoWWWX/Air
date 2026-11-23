import { tr } from '@/shared/i18n/messages'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Check, Search } from 'lucide-react'
import { cn } from '@/shared/lib/utils'
import { AirCheckbox } from './AirCheckbox'
import { Button } from './button'
import { Dialog, DialogContent, DialogTitle } from './dialog'
import { EditorSearchBar, normalizeLineEndings, renderMatchedText, useEditorSearch } from './EditorSearchBar'
import { Input } from './input'
import { showMessage } from './message'
import { Textarea } from './textarea'
import { emptyExtension, type SubscriptionExtension } from '../proxy/subscription-extension'

export type SubscriptionToolData =
  | { kind: 'qr'; url: string }
  | { kind: 'runtime'; yaml: string }
  | { kind: 'extension'; extension: SubscriptionExtension; save: (extension: SubscriptionExtension) => Promise<void> }
  | { kind: 'policy'; enabled: boolean; hours?: number | null; provider?: number | null; save: (enabled: boolean, hours: number | null) => Promise<void> }

export const subscriptionToolLabels = { get qr() { return tr('订阅二维码') }, get runtime() { return tr('运行时配置') }, get extension() { return tr('订阅扩展') }, get policy() { return tr('自动更新') } }

function RuntimeYamlViewer({ yaml, mobile }: { yaml: string; mobile: boolean }) {
  const normalized = useMemo(() => normalizeLineEndings(yaml), [yaml])
  const search = useEditorSearch(normalized, { enableShortcut: true })
  const preRef = useRef<HTMLPreElement>(null)
  const lastScrollTick = useRef(-1)

  useLayoutEffect(() => {
    if (!search.open || search.activeIndex < 0) {
      if (!search.open) lastScrollTick.current = -1
      return
    }
    if (search.scrollTick === lastScrollTick.current) return
    const mark = preRef.current?.querySelector<HTMLElement>('[data-active-match="true"]')
    if (!mark) return
    lastScrollTick.current = search.scrollTick
    mark.scrollIntoView({ block: 'center', inline: 'nearest' })
  }, [search.open, search.activeIndex, search.scrollTick])

  return (
    <div className="flex min-h-0 flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-muted-foreground">YAML</span>
        <Button
          type="button"
          size="icon-sm"
          variant={search.open ? 'subtle' : 'outline'}
          title={!mobile ? tr('查找配置内容 (Ctrl+F)') : tr('查找配置内容')}
          aria-label={tr('查找配置内容')}
          aria-pressed={search.open}
          onClick={search.toggleSearch}
        >
          <Search />
        </Button>
      </div>
      <EditorSearchBar {...search.barProps} compact={mobile} />
      <pre
        ref={preRef}
        aria-label={tr('运行时配置')}
        className={cn('air-runtime-yaml mono', mobile ? 'max-h-[48dvh]' : 'max-h-[380px]')}
      >
        {renderMatchedText(normalized, 0, search.matches, search.activeIndex)}
      </pre>
    </div>
  )
}

export function SubscriptionToolBody({ data, close, mobile = false, onBusyChange }: {
  data: SubscriptionToolData
  close: () => void
  mobile?: boolean
  onBusyChange?: (busy: boolean) => void
}) {
  const ext = data.kind === 'extension' ? data.extension : emptyExtension
  const [script, setScript] = useState(ext.script)
  const [rules, setRules] = useState(ext.rules.join('\n'))
  const [enabled, setEnabled] = useState(data.kind === 'policy' && data.enabled)
  const [hours, setHours] = useState(data.kind === 'policy' && data.hours ? String(data.hours) : '')
  const [image, setImage] = useState('')
  const [qrFailed, setQrFailed] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (data.kind === 'extension') {
      setScript(data.extension.script)
      setRules(data.extension.rules.join('\n'))
    } else if (data.kind === 'policy') {
      setEnabled(data.enabled)
      setHours(data.hours ? String(data.hours) : '')
    }
  }, [data])

  useEffect(() => {
    onBusyChange?.(busy)
  }, [busy, onBusyChange])

  useEffect(() => {
    if (data.kind !== 'qr') return
    let active = true
    setImage('')
    setQrFailed(false)
    void import('qrcode').then(qr => qr.toDataURL(data.url, { width: 300, margin: 4 }))
      .then(url => { if (active) setImage(url) })
      .catch(() => {
        if (!active) return
        setQrFailed(true)
        showMessage({ type: 'error', title: tr('链接过长或二维码生成失败') })
      })
    return () => { active = false }
  }, [data])

  async function submit() {
    setBusy(true)
    try {
      if (data.kind === 'extension') {
        await data.save({ script, rules: rules.split('\n').map(rule => rule.trim()).filter(Boolean) })
        showMessage({ type: 'success', title: tr('订阅扩展已保存') })
      }
      if (data.kind === 'policy') {
        const interval = hours.trim() ? Number(hours) : null
        if (interval !== null && (!Number.isInteger(interval) || interval < 1 || interval > 720)) throw new Error(tr('请输入 1 到 720 之间的整数小时'))
        await data.save(enabled, interval)
        showMessage({ type: 'success', title: tr('自动更新设置已保存') })
      }
      close()
    } catch (e) {
      showMessage({ type: 'error', title: e instanceof Error ? e.message : String(e) })
    } finally {
      setBusy(false)
    }
  }

  const hasSubmit = data.kind === 'policy' || data.kind === 'extension'
  const content = (
    <>
      {data.kind === 'qr' && (image ? <img src={image} alt={tr("订阅链接二维码")} className="mx-auto max-w-full rounded-md" /> : !qrFailed && <p className="text-sm text-muted-foreground">{tr("正在生成二维码…")}</p>)}
      {data.kind === 'runtime' && <RuntimeYamlViewer yaml={data.yaml} mobile={mobile} />}
      {data.kind === 'extension' && <>
        <label className="grid gap-1 text-sm">{tr("扩展脚本")}<Textarea value={script} onChange={e => setScript(e.target.value)} rows={6} spellCheck={false} className="font-mono text-xs" placeholder="function main(config) { return config }" /></label>
        <label className="grid gap-1 text-sm">{tr("附加规则（每行一条，优先匹配）")}<Textarea value={rules} onChange={e => setRules(e.target.value)} rows={4} spellCheck={false} className="font-mono text-xs" placeholder="DOMAIN-SUFFIX,example.com,DIRECT" /></label>
      </>}
      {data.kind === 'policy' && <>
        <AirCheckbox label={tr("自动更新此订阅")} checked={enabled} onChange={setEnabled}>
          <span className="text-sm">{tr("自动更新此订阅")}</span>
        </AirCheckbox>
        <label className="grid gap-1.5 text-sm">
          {tr("更新间隔（小时）")}
          <Input
            type="number"
            min={1}
            max={720}
            value={hours}
            className={mobile ? 'h-[41px] text-sm' : 'h-9 text-sm'}
            placeholder={tr('跟随订阅，当前 ') + (data.provider ?? 24) + tr(' 小时')}
            onChange={e => setHours(e.target.value)}
          />
        </label>
        <p className="text-xs text-muted-foreground">{tr("留空时跟随服务商的间隔。编辑本地配置后会暂停自动更新，可在这里恢复。")}</p>
      </>}
      {mobile ? (
        hasSubmit && (
          <div className="sheet-actions">
            <Button variant="default" className="ml-auto" disabled={busy} onClick={() => void submit()}>
              <Check />
              {busy ? tr('保存中…') : tr('保存')}
            </Button>
          </div>
        )
      ) : (
        <div className="flex justify-end gap-2">
          <Button variant="outline" disabled={busy} onClick={close}>{tr("关闭")}</Button>
          {hasSubmit && <Button variant="default" disabled={busy} onClick={() => void submit()}>{busy ? tr('保存中…') : tr('保存')}</Button>}
        </div>
      )}
    </>
  )

  return mobile ? <div className="sheet-form">{content}</div> : content
}

export function SubscriptionTool({ data, name, close }: { data: SubscriptionToolData; name: string; close: () => void }) {
  const [busy, setBusy] = useState(false)
  return <Dialog open onOpenChange={open => { if (!open && !busy) close() }}>
    <DialogContent showCloseButton className="max-h-[85dvh] max-w-[min(92vw,640px)] gap-4 overflow-y-auto p-5">
      <DialogTitle className="min-w-0 pr-8 [overflow-wrap:anywhere]">{subscriptionToolLabels[data.kind]} · {name}</DialogTitle>
      <SubscriptionToolBody data={data} close={close} onBusyChange={setBusy} />
    </DialogContent>
  </Dialog>
}
