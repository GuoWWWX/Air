import { tr } from '@/shared/i18n/messages'
import { Check, Copy } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { cn } from '@/shared/lib/utils'
import { Button } from './button'
import { showMessage } from './message'

type WriteText = (text: string) => Promise<unknown>

async function writeClipboard(text: string) {
  if (!navigator.clipboard) throw new Error(tr('当前环境不支持剪贴板'))
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

export function CopySubscriptionLink({
  url,
  write,
  onError,
  size = 'icon-sm',
  className,
}: {
  url: string
  write?: WriteText
  onError: (message: string) => void
  size?: 'icon' | 'icon-sm'
  className?: string
}) {
  const { copied, copy } = useCopyFeedback(write)
  const value = url.trim()
  const success = Boolean(value) && copied === value
  const Icon = success ? Check : Copy
  const label = success ? tr('复制成功') : tr('复制订阅链接')
  return (
    <Button
      type="button"
      size={size}
      variant="ghost"
      disabled={!value}
      title={label}
      aria-label={label}
      className={cn(
        'shrink-0 text-muted-foreground hover:text-foreground',
        success && 'text-success hover:text-success',
        className,
      )}
      onClick={() => {
        if (!value) return
        void copy(value, value)
          .then(() => showMessage({ type: 'success', title: tr('订阅链接已复制') }))
          .catch(() => onError(tr('无法复制订阅链接')))
      }}
    >
      <Icon />
    </Button>
  )
}
