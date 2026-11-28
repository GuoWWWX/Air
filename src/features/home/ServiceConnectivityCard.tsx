import { Popover } from '@base-ui/react/popover'
import { ChevronDown, Globe, RefreshCw } from 'lucide-react'
import { tr } from '@/shared/i18n/messages'
import { cn } from '@/shared/lib/utils'
import { Button } from '@/shared/ui/button'
import { Card, CardHeader } from '@/shared/ui/card'
import type { ConnectivityLookup } from '../proxy/useProxy'
import chatgptLogo from './service-logos/chatgpt.svg'
import githubLogo from './service-logos/github.svg'
import googleLogo from './service-logos/google.png'
import youtubeLogo from './service-logos/youtube.png'

const services = [
  { id: 'google', name: 'Google', logo: googleLogo },
  { id: 'github', name: 'GitHub', logo: githubLogo },
  { id: 'youtube', name: 'YouTube', logo: youtubeLogo },
  { id: 'chatgpt', name: 'ChatGPT', logo: chatgptLogo },
] as const
type Service = (typeof services)[number]

export function ServiceConnectivityCard({ connectivity, checking, failed, onRefresh }: ConnectivityLookup) {
  const title = tr('服务连通性')
  const measurement = tr('通过当前分流规则测量 HTTPS 响应耗时')
  const refresh = tr('重新检测服务连通性')

  function renderService(service: Service, showName: boolean) {
    const latency = connectivity?.[service.id]
    const reachable = latency != null
    const unavailable = !reachable && (connectivity != null || failed)
    const status = reachable ? `${latency} ms` : unavailable ? tr('未通过') : checking ? '…' : '—'

    return (
      <li
        key={service.id}
        title={`${service.name} · ${checking ? tr('正在检测…') : status}`}
        className={cn('flex min-w-0 items-center rounded-[7px]', showName ? 'h-8.5 gap-1.5 px-1.5' : 'h-8 gap-1 px-1 bg-muted/65')}
      >
        <span className={cn('relative grid shrink-0 place-items-center', showName ? 'size-5' : 'size-4.5')}>
          <img src={service.logo} alt="" width={16} height={16} className={cn('size-4 object-contain', service.id === 'github' && 'dark:invert')} />
          <span
            aria-hidden="true"
            className={cn(
              'absolute -right-0.5 bottom-0 size-1.5 rounded-full ring-1 ring-card',
              reachable ? 'bg-success' : unavailable ? 'bg-destructive' : checking ? 'bg-primary motion-safe:animate-pulse' : 'bg-icon-muted',
            )}
          />
        </span>
        <span className={showName ? 'flex-1 text-xs text-foreground' : 'sr-only'}>{service.name}</span>
        <span className={cn('whitespace-nowrap tabular-nums', showName ? 'ml-auto text-xs' : 'text-[11px]', reachable ? 'font-semibold text-foreground' : 'text-muted-foreground')}>
          {status}
        </span>
      </li>
    )
  }

  return (
    <Card className="gap-2 p-3.5">
      <CardHeader className="min-h-7">
        <span className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
          <Globe className="size-3.5 shrink-0 text-muted-foreground" />{title}
        </span>
        <Popover.Root>
          <Popover.Trigger
            aria-label={title}
            title={title}
            render={<Button variant="ghost" size="icon-sm" className="group" />}
          >
            <ChevronDown className="transition-transform motion-reduce:transition-none group-data-[popup-open]:rotate-180" />
          </Popover.Trigger>
          <Popover.Portal>
            <Popover.Positioner align="end" sideOffset={6} className="z-50">
              <Popover.Popup className="w-60 max-w-[var(--available-width)] max-h-[var(--available-height)] overflow-auto rounded-[11px] border border-border bg-popover px-3 py-2.5 text-popover-foreground shadow-lg outline-none">
                <div className="flex items-center justify-between gap-2">
                  <Popover.Title className="pl-1.5 text-sm font-semibold">{title}</Popover.Title>
                  <Button variant="ghost" size="icon-sm" aria-label={refresh} title={refresh} disabled={!onRefresh || checking} onClick={onRefresh}>
                    <RefreshCw className={checking ? 'text-primary motion-safe:animate-spin' : undefined} />
                  </Button>
                </div>
                <ul className="mt-1" aria-live="polite" aria-busy={checking}>
                  {services.map(service => renderService(service, true))}
                </ul>
                <Popover.Description className="mx-1.5 mt-1.5 border-t border-border pt-2 text-xs text-muted-foreground">
                  {measurement}
                </Popover.Description>
              </Popover.Popup>
            </Popover.Positioner>
          </Popover.Portal>
        </Popover.Root>
      </CardHeader>
      <ul className="grid grid-cols-[repeat(2,minmax(0,6rem))] gap-1.5" aria-label={title} aria-live="polite" aria-busy={checking}>
        {services.slice(0, 2).map(service => renderService(service, false))}
      </ul>
    </Card>
  )
}
