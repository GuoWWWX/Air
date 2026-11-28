import { Popover } from '@base-ui/react/popover'
import { ChevronDown, Globe, RefreshCw } from 'lucide-react'
import { air } from '@/platform/desktop/air'
import { tr } from '@/shared/i18n/messages'
import { cn } from '@/shared/lib/utils'
import { Button } from '@/shared/ui/button'
import { Card, CardHeader } from '@/shared/ui/card'
import { showMessage } from '@/shared/ui/message'
import type { ConnectivityLookup } from '../proxy/useProxy'
import bingLogo from './service-logos/bing.png'
import chatgptLogo from './service-logos/chatgpt.svg'
import cloudflareLogo from './service-logos/cloudflare.png'
import githubLogo from './service-logos/github.svg'
import googleLogo from './service-logos/google.png'
import wikipediaLogo from './service-logos/wikipedia.png'
import youtubeLogo from './service-logos/youtube.png'

const services = [
  { id: 'google', name: 'Google', logo: googleLogo },
  { id: 'github', name: 'GitHub', logo: githubLogo },
  { id: 'youtube', name: 'YouTube', logo: youtubeLogo },
  { id: 'chatgpt', name: 'ChatGPT', logo: chatgptLogo },
  { id: 'wikipedia', name: 'Wikipedia', logo: wikipediaLogo },
  { id: 'cloudflare', name: 'Cloudflare', logo: cloudflareLogo },
  { id: 'bing', name: 'Bing', logo: bingLogo },
] as const
type Service = (typeof services)[number]

export function ServiceConnectivityCard({ connectivity, checking, failed, onRefresh }: ConnectivityLookup) {
  const title = tr('服务连通性')
  const refresh = tr('重新检测服务连通性')

  function renderService(service: Service, showName: boolean) {
    const latency = connectivity?.[service.id]
    const reachable = latency != null
    const unavailable = !reachable && (connectivity != null || failed)
    const status = reachable ? `${latency} ms` : unavailable ? tr('未通过') : checking ? '…' : '—'
    const linkLabel = `${tr('用默认浏览器打开 {0}', service.name)} · ${checking ? tr('正在检测…') : status}`

    return (
      <li key={service.id} className="min-w-0">
        <Button
          variant="ghost"
          aria-label={linkLabel}
          title={linkLabel}
          className={cn(
            'w-full cursor-pointer border-0',
            showName ? 'justify-start px-1.5' : 'h-10 justify-center gap-1 bg-muted/65 px-1 @[12rem]:gap-1.5',
          )}
          onClick={() => void air.openServiceLink(service.id).catch(() => {
            showMessage({ type: 'error', title: tr('无法打开浏览器') })
          })}
        >
          <span className={cn('relative grid size-5 shrink-0 place-items-center', !showName && '@[12rem]:size-5.5')}>
            <img
              src={service.logo}
              alt=""
              width={16}
              height={16}
              className={cn('object-contain', showName ? 'size-4' : 'size-4.5 @[12rem]:size-5', service.id === 'github' && 'dark:invert')}
            />
            <span
              aria-hidden="true"
              className={cn(
                'absolute -right-0.5 bottom-0 size-1.5 rounded-full ring-1 ring-card',
                reachable ? 'bg-success' : unavailable ? 'bg-destructive' : checking ? 'bg-primary motion-safe:animate-pulse' : 'bg-icon-muted',
              )}
            />
          </span>
          {showName && <span className="flex-1 truncate text-left text-xs text-foreground">{service.name}</span>}
          <span className={cn(
            'whitespace-nowrap tabular-nums',
            showName ? 'ml-auto text-xs' : 'text-xs @[12rem]:text-sm',
            reachable ? 'font-semibold text-foreground' : 'text-muted-foreground',
          )}>
            {status}
          </span>
        </Button>
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
              </Popover.Popup>
            </Popover.Positioner>
          </Popover.Portal>
        </Popover.Root>
      </CardHeader>
      <ul className="@container grid w-[calc(100%+0.5rem)] max-w-60 flex-1 grid-cols-2 content-center gap-2 self-center" aria-label={title} aria-live="polite" aria-busy={checking}>
        {services.slice(0, 2).map(service => renderService(service, false))}
      </ul>
    </Card>
  )
}
