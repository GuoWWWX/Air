import { Check, Copy } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Button } from './button'
import { showMessage } from './message'

type WriteText = (text: string) => Promise<unknown>

async function writeClipboard(text: string) {
  if (!navigator.clipboard) throw new Error('当前环境不支持剪贴板')
  await navigator.clipboard.writeText(text)
}

export function useCopyFeedback(write: WriteText = writeClipboard) {
  const [copied, setCopied] = useState<string>()
  const timer = useRef<number | undefined>(undefined)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; window.clearTimeout(timer.current) }
  }, [])
  async function copy(key: string, text: string) {
    await write(text)
    if (!mounted.current) return
    window.clearTimeout(timer.current)
    setCopied(key)
    timer.current = window.setTimeout(() => setCopied(undefined), 1000)
  }
  return { copied, copy }
}

export function CopySubscriptionLink({ url, write, onError }: {
  url: string; write?: WriteText; onError: (message: string) => void
}) {
  const { copied, copy } = useCopyFeedback(write)
  const value = url.trim()
  if (!value) return null
  const success = copied === value
  const Icon = success ? Check : Copy
  return <Button type="button" size="sm" variant="secondary" className="shrink-0"
    aria-label={success ? '复制成功' : '复制订阅链接'}
    onClick={() => void copy(value, value)
      .then(() => showMessage({ type: 'success', title: '订阅链接已复制' }))
      .catch(() => onError('无法复制订阅链接'))}>
    <Icon data-icon="inline-start" />
    <span aria-live="polite">{success ? '复制成功' : '复制链接'}</span>
  </Button>
}
