import { useEffect, useState } from 'react'
import { Button } from './button'
import { Dialog, DialogContent, DialogTitle } from './dialog'
import { showMessage } from './message'
import { Textarea } from './textarea'
import { emptyExtension, type SubscriptionExtension } from '../proxy/subscription-extension'

export type SubscriptionToolData =
  | { kind: 'qr'; url: string }
  | { kind: 'runtime'; yaml: string }
  | { kind: 'extension'; extension: SubscriptionExtension; save: (extension: SubscriptionExtension) => Promise<void> }
  | { kind: 'policy'; enabled: boolean; hours?: number | null; provider?: number | null; save: (enabled: boolean, hours: number | null) => Promise<void> }

const labels = { qr: '订阅二维码', runtime: '运行时配置', extension: '订阅扩展', policy: '自动更新' }

export function SubscriptionTool({ data, name, close }: { data: SubscriptionToolData; name: string; close: () => void }) {
  const ext = data.kind === 'extension' ? data.extension : emptyExtension
  const [script, setScript] = useState(ext.script)
  const [rules, setRules] = useState(ext.rules.join('\n'))
  const [enabled, setEnabled] = useState(data.kind === 'policy' && data.enabled)
  const [hours, setHours] = useState(data.kind === 'policy' && data.hours ? String(data.hours) : '')
  const [image, setImage] = useState('')
  const [qrFailed, setQrFailed] = useState(false)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (data.kind !== 'qr') return
    let active = true
    setQrFailed(false)
    void import('qrcode').then(qr => qr.toDataURL(data.url, { width: 300, margin: 4 }))
      .then(url => { if (active) setImage(url) })
      .catch(() => {
        if (!active) return
        setQrFailed(true)
        showMessage({ type: 'error', title: '链接过长或二维码生成失败' })
      })
    return () => { active = false }
  }, [data])
  async function submit() {
    setBusy(true)
    try {
      if (data.kind === 'extension') {
        await data.save({ script, rules: rules.split('\n').map(rule => rule.trim()).filter(Boolean) })
        showMessage({ type: 'success', title: '订阅扩展已保存' })
      }
      if (data.kind === 'policy') {
        const interval = hours.trim() ? Number(hours) : null
        if (interval !== null && (!Number.isInteger(interval) || interval < 1 || interval > 720)) throw new Error('请输入 1 到 720 之间的整数小时')
        await data.save(enabled, interval)
        showMessage({ type: 'success', title: '自动更新设置已保存' })
      }
      close()
    } catch (e) {
      showMessage({ type: 'error', title: e instanceof Error ? e.message : String(e) })
    }
    finally { setBusy(false) }
  }
  return <Dialog open onOpenChange={open => { if (!open && !busy) close() }}>
    <DialogContent className="max-h-[85dvh] max-w-[min(92vw,640px)] overflow-y-auto p-5">
      <DialogTitle>{labels[data.kind]} · {name}</DialogTitle>
      {data.kind === 'qr' && (image ? <img src={image} alt="订阅链接二维码" className="mx-auto max-w-full rounded-md" /> : !qrFailed && <p>正在生成二维码…</p>)}
      {data.kind === 'runtime' && <Textarea value={data.yaml} aria-label="运行时配置" spellCheck={false} rows={16} readOnly className="font-mono text-xs" />}
      {data.kind === 'extension' && <>
        <label className="grid gap-1 text-sm">扩展脚本<Textarea value={script} onChange={e => setScript(e.target.value)} rows={6} spellCheck={false} className="font-mono text-xs" placeholder="function main(config) { return config }" /></label>
        <label className="grid gap-1 text-sm">附加规则（每行一条，优先匹配）<Textarea value={rules} onChange={e => setRules(e.target.value)} rows={4} spellCheck={false} className="font-mono text-xs" placeholder="DOMAIN-SUFFIX,example.com,DIRECT" /></label>
      </>}
      {data.kind === 'policy' && <>
        <label className="flex items-center gap-2"><input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} />自动更新此订阅</label>
        <label className="grid gap-1 text-sm">更新间隔（小时）<input className="rounded-md border px-3 py-2" type="number" min={1} max={720} value={hours} placeholder={'跟随订阅，当前 ' + (data.provider ?? 24) + ' 小时'} onChange={e => setHours(e.target.value)} /></label>
        <p className="text-xs text-muted-foreground">留空时跟随服务商的间隔。编辑本地配置后会暂停自动更新，可在这里恢复。</p>
      </>}
      <div className="flex justify-end gap-2"><Button variant="outline" disabled={busy} onClick={close}>关闭</Button>
        {(data.kind === 'policy' || data.kind === 'extension') && <Button disabled={busy} onClick={() => void submit()}>{busy ? '保存中…' : '保存'}</Button>}
      </div>
    </DialogContent>
  </Dialog>
}
