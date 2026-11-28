import { Globe, RefreshCw } from 'lucide-react'
import { tr } from '@/shared/i18n/messages'
import { cn } from '@/shared/lib/utils'
import { Button } from '@/shared/ui/button'
import { Card, CardHeader } from '@/shared/ui/card'
import type { ConnectivityLookup } from '../proxy/useProxy'

const services = [
  { id: 'youtube', name: 'YouTube' },
  { id: 'google', name: 'Google' },
  { id: 'github', name: 'GitHub' },
  { id: 'chatgpt', name: 'ChatGPT' },
] as const

export function ServiceConnectivityCard({ connectivity, checking, failed, onRefresh }: ConnectivityLookup) {
  const title = tr('服务连通性')
  const measurement = tr('通过当前分流规则测量 HTTPS 响应耗时')
  const refresh = tr('重新检测服务连通性')

  return (
    <Card className="gap-2 p-3.5">
      <CardHeader className="min-h-7">
        <span className="flex items-center gap-1.5 text-xs font-semibold text-foreground" title={measurement}>
          <Globe className="size-3.5 shrink-0 text-muted-foreground" />{title}
        </span>
        {onRefresh && (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={refresh}
            title={refresh}
            disabled={checking}
            onClick={onRefresh}
          >
            <RefreshCw className={checking ? 'text-primary motion-safe:animate-spin' : undefined} />
          </Button>
        )}
      </CardHeader>
      <ul className="grid grid-cols-2 gap-x-2.5 gap-y-2" aria-label={measurement} aria-live="polite" aria-busy={checking}>
        {services.map(({ id, name }) => {
          const latency = connectivity?.[id]
          const reachable = latency != null
          const unavailable = !reachable && (connectivity != null || failed)
          return (
            <li key={id} className="min-w-0">
              <div className="truncate text-xs leading-4 text-muted-foreground" title={name}>{name}</div>
              <div className={cn('flex items-center gap-1.5 whitespace-nowrap text-xs leading-5 tabular-nums', reachable ? 'font-semibold text-foreground' : 'text-muted-foreground')}>
                <span
                  aria-hidden="true"
                  className={cn('size-1.5 shrink-0 rounded-full', reachable ? 'bg-success' : unavailable ? 'bg-destructive' : checking ? 'bg-primary motion-safe:animate-pulse' : 'bg-icon-muted')}
                />
                {reachable ? `${latency} ms` : unavailable ? tr('未通过') : checking ? <span aria-label={tr('正在检测…')}>…</span> : '—'}
              </div>
            </li>
          )
        })}
      </ul>
    </Card>
  )
}
