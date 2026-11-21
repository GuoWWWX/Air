import { Camera, FileUp, Image, Link, Plus, ScanLine } from 'lucide-react'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { CopySubscriptionLink } from '@/shared/ui/CopySubscriptionLink'
import { Button } from '@/shared/ui/button'
import { Input } from '@/shared/ui/input'
import { Label } from '@/shared/ui/label'
import { showMessage } from '@/shared/ui/message'
import { Segmented } from '@/shared/ui/segmented'
import type { ImportInput } from '@/platform/desktop/air'
import { startBackgroundSubscriptionImport } from './importTasks'
import { SubscriptionDialog } from './SubscriptionDialog'

type Mode = 'url' | 'file' | 'qr'

const importModes = [
  { value: 'url', label: 'URL 链接', icon: <Link /> },
  { value: 'file', label: '本地文件', icon: <FileUp /> },
  { value: 'qr', label: '二维码', icon: <ScanLine /> },
] as const

function qrUrl(value: string) {
  const url = new URL(value.trim())
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('二维码中没有 HTTP 或 HTTPS 订阅链接')
  }
  return url.href
}

async function readQr(frame: HTMLVideoElement | ImageBitmap) {
  const width = frame instanceof HTMLVideoElement ? frame.videoWidth : frame.width
  const height = frame instanceof HTMLVideoElement ? frame.videoHeight : frame.height
  const scale = Math.min(1, 1280 / Math.max(width, height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(width * scale)
  canvas.height = Math.round(height * scale)
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context || !canvas.width || !canvas.height) return undefined
  context.drawImage(frame, 0, 0, canvas.width, canvas.height)
  const { data } = context.getImageData(0, 0, canvas.width, canvas.height)
  const { default: decode } = await import('jsqr')
  return decode(data, canvas.width, canvas.height)?.data
}

export function SubscriptionImport({
  onClose,
  onImported,
}: {
  onClose: () => void
  onImported: () => Promise<void>
}) {
  const [mode, setMode] = useState<Mode>('url')
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [file, setFile] = useState<File>()
  const [pending, setPending] = useState(false)
  const [scanning, setScanning] = useState(false)
  const [qrLink, setQrLink] = useState('')
  const fileInput = useRef<HTMLInputElement>(null)
  const imageInput = useRef<HTMLInputElement>(null)
  const video = useRef<HTMLVideoElement>(null)

  function acceptQr(value: string) {
    try {
      setQrLink(qrUrl(value))
      showMessage({ type: 'success', title: '已识别订阅链接' })
    } catch {
      showMessage({ type: 'error', title: '二维码中没有 HTTP 或 HTTPS 订阅链接' })
    }
    setScanning(false)
  }

  useEffect(() => {
    if (!scanning || mode !== 'qr') return
    let stopped = false
    let stream: MediaStream | undefined
    let timer: number | undefined

    async function scan() {
      const frame = video.current
      try {
        const value = frame && frame.readyState >= 2 ? await readQr(frame) : undefined
        if (stopped) return
        if (value) acceptQr(value)
        else timer = window.setTimeout(() => void scan(), 230)
      } catch {
        if (!stopped) {
          showMessage({ type: 'error', title: '读取摄像头画面失败' })
          setScanning(false)
        }
      }
    }

    async function start() {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: { facingMode: { ideal: 'environment' } },
        })
        if (stopped || !video.current) {
          stream.getTracks().forEach(track => track.stop())
          return
        }
        video.current.srcObject = stream
        await video.current.play()
        if (!stopped) void scan()
      } catch {
        if (!stopped) {
          showMessage({ type: 'error', title: '无法打开摄像头，请检查 Windows 权限，或选择二维码图片' })
          setScanning(false)
        }
      }
    }

    void start()
    return () => {
      stopped = true
      window.clearTimeout(timer)
      stream?.getTracks().forEach(track => track.stop())
    }
  }, [scanning, mode])

  async function recognize(selectedFile: File) {
    setScanning(false)
    try {
      const image = await createImageBitmap(selectedFile)
      let result: string | undefined
      try {
        result = await readQr(image)
      } finally {
        image.close()
      }
      if (!result) throw new Error('图片中没有识别到二维码')
      acceptQr(result)
    } catch (failure) {
      showMessage({ type: 'error', title: failure instanceof Error ? failure.message : String(failure) })
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (pending) return
    setPending(true)
    setScanning(false)
    try {
      let input: ImportInput
      if (mode === 'file') {
        if (!file) return
        if (file.size > 8 * 1024 * 1024) throw new Error('订阅文件超过 8 MB')
        input = { kind: 'file', name, filename: file.name, yaml: await file.text() }
      } else {
        const raw = (mode === 'qr' ? qrLink : url).trim()
        const parsed = new URL(raw)
        if (!['http:', 'https:'].includes(parsed.protocol)) {
          throw new Error('请输入 HTTP 或 HTTPS 订阅链接')
        }
        input = { kind: 'url', name, url: parsed.href, qr: mode === 'qr' }
      }
      startBackgroundSubscriptionImport(input, onImported)
      onClose()
    } catch (failure) {
      showMessage({
        type: 'error',
        title: failure instanceof Error ? failure.message : String(failure),
      })
    } finally {
      setPending(false)
    }
  }

  return (
    <SubscriptionDialog
      title="导入订阅"
      pending={pending}
      onClose={onClose}
      onSubmit={event => void submit(event)}
      footer={
        mode === 'qr' && !qrLink ? undefined : (
          <>
            <Button
              type="button"
              variant="secondary"
              disabled={pending}
              onClick={onClose}
            >
              取消
            </Button>
            <Button
              type="submit"
              variant="default"
              disabled={
                pending ||
                (mode === 'file' ? !file : !(mode === 'qr' ? qrLink : url).trim())
              }
            >
              <Plus data-icon="inline-start" />
              {pending ? '准备中…' : '导入订阅'}
            </Button>
          </>
        )
      }
    >
      <Segmented
        layoutId="subscription-import-mode"
        ariaLabel="导入方式"
        value={mode}
        options={importModes}
        size="md"
        fullWidth
        onChange={next => {
          setMode(next)
          setScanning(false)
        }}
      />

      {mode === 'url' && (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="sub-import-url">订阅链接</Label>
          <div className="flex items-center gap-2">
            <Input
              id="sub-import-url"
              required
              autoComplete="off"
              spellCheck={false}
              placeholder="粘贴机场提供的订阅链接"
              value={url}
              onChange={e => setUrl(e.target.value)}
            />
            <CopySubscriptionLink url={url} onError={title => showMessage({ type: 'error', title })} />
          </div>
        </div>
      )}

      {mode === 'file' && (
        <div>
          <input
            ref={fileInput}
            className="sr-only"
            tabIndex={-1}
            type="file"
            accept=".yaml,.yml"
            aria-label="本地 YAML 文件"
            onChange={event => setFile(event.target.files?.[0])}
          />
          <div
            onDragOver={event => event.preventDefault()}
            onDrop={event => {
              event.preventDefault()
              setFile(event.dataTransfer.files[0])
            }}
            className="flex min-h-36 flex-col items-center justify-center gap-2 rounded-[10px] border border-dashed border-border bg-input-bg p-4 text-center transition-colors hover:border-accent-border"
          >
            <span className="grid size-10 place-items-center rounded-full bg-accent-soft text-primary">
              <FileUp className="size-5" />
            </span>
            <strong className="text-xs font-semibold text-foreground">
              {file?.name ?? '拖入本地订阅文件'}
            </strong>
            <small className="text-[12px] text-muted-foreground">支持 .yml、.yaml（最大 8 MB）</small>
            <Button type="button" variant="secondary" size="sm" onClick={() => fileInput.current?.click()}>
              选择文件
            </Button>
          </div>
        </div>
      )}

      {mode === 'qr' && (
        <div className="flex flex-col gap-3">
          <div className="relative flex min-h-48 flex-col items-center justify-center gap-3 overflow-hidden rounded-[10px] border border-border bg-input-bg p-4 text-center">
            <span className="pointer-events-none absolute top-3 left-3 size-3.5 border-t-2 border-l-2 border-primary/50" />
            <span className="pointer-events-none absolute top-3 right-3 size-3.5 border-t-2 border-r-2 border-primary/50" />
            <span className="pointer-events-none absolute bottom-3 left-3 size-3.5 border-b-2 border-l-2 border-primary/50" />
            <span className="pointer-events-none absolute right-3 bottom-3 size-3.5 border-r-2 border-b-2 border-primary/50" />
            {scanning ? (
              <video ref={video} autoPlay muted playsInline className="max-h-52 max-w-full rounded-[6px]" />
            ) : (
              <>
                <ScanLine className="size-10 text-primary" />
                <strong className="text-xs font-medium text-foreground">
                  {qrLink ? '已获取订阅链接' : '将二维码置于取景框内'}
                </strong>
              </>
            )}
          </div>

          <input
            ref={imageInput}
            className="sr-only"
            tabIndex={-1}
            type="file"
            accept="image/*"
            aria-label="二维码图片"
            onChange={event => {
              const selected = event.target.files?.[0]
              event.target.value = ''
              if (selected) void recognize(selected)
            }}
          />

          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button
              type="button"
              variant="default"
              onClick={() => setScanning(value => !value)}
            >
              <Camera data-icon="inline-start" />
              {scanning ? '关闭摄像头' : '启用摄像头'}
            </Button>
            <Button type="button" variant="secondary" onClick={() => imageInput.current?.click()}>
              <Image data-icon="inline-start" />
              选择二维码图片
            </Button>
          </div>

          {qrLink && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="sub-import-qr-link">识别结果</Label>
              <Input
                id="sub-import-qr-link"
                autoComplete="off"
                spellCheck={false}
                value={qrLink}
                onChange={e => setQrLink(e.target.value)}
              />
            </div>
          )}
        </div>
      )}

      {(mode === 'url' || (mode === 'qr' && qrLink)) && (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="sub-import-name">名称（选填）</Label>
          <Input
            id="sub-import-name"
            maxLength={80}
            placeholder="使用订阅提供的名称"
            value={name}
            onChange={e => setName(e.target.value)}
          />
        </div>
      )}
    </SubscriptionDialog>
  )
}
