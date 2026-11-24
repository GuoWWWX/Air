import { tr } from '@/shared/i18n/messages'
import { isTauri } from '@tauri-apps/api/core'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { Copy, Minus, Network, Plug, Square, X } from 'lucide-react'
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { cn } from '@/shared/lib/utils'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/shared/ui/dropdown-menu'
import { ProxyPowerButton } from '@/shared/ui/ProxyPowerButton'
import { FlagText } from '@/shared/ui/FlagText'
import { Segmented } from '@/shared/ui/segmented'
import { Separator } from '@/shared/ui/separator'
import { Switch } from '@/shared/ui/switch'
import type { ProxyModeAction, ProxyStatus, ProxyTraffic } from '@/platform/desktop/air'
import { captureModeLabel, proxyModes, proxyPowerTone } from '@/shared/proxy/modes'
import { TunServiceButton } from '../features/proxy/TunServiceButton'


export function AppTitlebar({
  onError,
  status,
  outboundName,
  outboundLatency,
  onClearNode,
  traffic,
  pending,
  onControl,
  onTunSetup,
  onToggle,
}: {
  onError: (error: unknown) => void
  status: ProxyStatus
  outboundName?: string
  outboundLatency?: ReactNode
  onClearNode?: () => void
  traffic?: ProxyTraffic
  pending: 'start' | 'stop' | undefined
  onControl: (action: ProxyModeAction) => void
  onTunSetup: () => void
  onToggle: () => void
}) {
  const modes = proxyModes.map(({ value, label }) => ({ value, label }))
  const [maximized, setMaximized] = useState(false)

  const refresh = useCallback(async () => {
    if (!isTauri()) return
    try {
      setMaximized(await getCurrentWindow().isMaximized())
    } catch (error) {
      onError(error)
    }
  }, [onError])

  async function run(action: 'minimize' | 'toggleMaximize' | 'close') {
    if (!isTauri()) return
    try {
      await getCurrentWindow()[action]()
      if (action === 'toggleMaximize') await refresh()
    } catch (error) {
      onError(error)
    }
  }

  useEffect(() => {
    void refresh()
    window.addEventListener('resize', refresh)
    return () => window.removeEventListener('resize', refresh)
  }, [refresh])

  const maximizeLabel = maximized ? tr('还原窗口') : tr('最大化')
  const nodeName = outboundName ?? (onClearNode ? tr('节点已失效') : undefined)
  const nodeLabel = nodeName && (
    <span className="block min-w-0 truncate">
      <FlagText text={nodeName} />
    </span>
  )

  return (
    <header className="@container flex h-10.5 shrink-0 items-center overflow-hidden border-b border-border bg-shell pl-3.5 select-none">
      {nodeName && (
        <div
          role="status"
          aria-label={tr("当前节点：{0}", nodeName)}
          title={nodeName}
          className="hidden min-w-0 max-w-72 items-center gap-2 text-xs font-medium text-secondary-foreground @[42rem]:flex"
        >
          {onClearNode ? (
            <DropdownMenu>
              <DropdownMenuTrigger
                aria-label={tr("当前节点：{0}", nodeName)}
                className="min-w-0 rounded-sm text-left outline-none transition-colors hover:text-primary focus-visible:ring-2 focus-visible:ring-ring/60"
              >
                {nodeLabel}
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                <DropdownMenuItem onClick={onClearNode}>
                  <X />{tr("清除选择")}</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : nodeLabel}
          {outboundLatency}
        </div>
      )}

      <div className="min-w-4 flex-1 self-stretch" data-tauri-drag-region />

      <div className="flex items-center gap-2 whitespace-nowrap">
        <div className="hidden items-center xl:flex">
          <Segmented
            layoutId="titlebar-proxy-mode"
            ariaLabel={tr("出站模式")}
            size="xs"
            value={status.mode}
            options={modes}
            onChange={mode => onControl({ action: 'mode', mode })}
            className="rounded-[7px]"
          />
        </div>

        <Separator orientation="vertical" className="hidden h-3.5 xl:block" />

        {(
          [
            {
              action: 'systemProxy' as const,
              label: tr('系统代理'),
              titleKey: '系统代理 · {0}',
              checked: status.systemProxy,
              tone: 'primary' as const,
              icon: Plug,
              activeClass:
                'border-[#2f63e8]/45 bg-[#2f63e8]/[0.1] text-[#214ecc] shadow-[0_1px_6px_-2px_rgba(47,99,232,0.28)] dark:border-[#608eff]/40 dark:bg-[#3b6ae8]/18 dark:text-[#a3b8ff]',
            },
            {
              action: 'tun' as const,
              label: tr('虚拟网卡'),
              titleKey: '虚拟网卡 · {0}',
              checked: status.tun,
              tone: 'success' as const,
              icon: Network,
              activeClass:
                'border-[#008b78]/45 bg-[#008b78]/[0.1] text-[#007363] shadow-[0_1px_6px_-2px_rgba(0,139,120,0.28)] dark:border-[#34d399]/35 dark:bg-[#0ea58a]/18 dark:text-[#6ee7b7]',
            },
          ] as const
        ).map(({ action, label, titleKey, checked, tone, icon: Icon, activeClass }) => (
          <div key={action} className="flex items-center gap-0.5">
            <label
              title={tr(titleKey, captureModeLabel(status.running, checked))}
              className={cn(
                'inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-[7px] border px-2 text-[12px] font-medium transition-[transform,color,background-color,border-color,box-shadow] duration-200 select-none active:scale-[0.97]',
                checked
                  ? activeClass
                  : 'border-border/80 bg-muted/45 text-muted-foreground hover:border-border hover:bg-muted/80 hover:text-foreground',
              )}
            >
              <Icon className="size-3.5 shrink-0" />
              <span className="hidden @[30rem]:inline">{label}</span>
              {status.running && checked && (
                <span aria-hidden="true" className="size-1.5 rounded-full bg-current motion-safe:animate-pulse" />
              )}
              <Switch
                size="sm"
                tone={tone}
                aria-label={label}
                disabled={Boolean(pending)}
                checked={checked}
                onCheckedChange={enabled => onControl({ action, enabled })}
              />
            </label>
            {action === 'tun' && status.tunServiceReady === false && (
              <TunServiceButton onClick={onTunSetup} disabled={Boolean(pending)} />
            )}
          </div>
        ))}

        <ProxyPowerButton
          phase={pending === 'start' ? 'starting' : pending === 'stop' ? 'stopping' : status.running ? 'running' : 'idle'}
          tone={proxyPowerTone(status)}
          traffic={traffic}
          onToggle={onToggle}
        />
      </div>

      <Separator orientation="vertical" className="ml-2.5 mr-0.5 h-3.5 shrink-0 opacity-70" />

      <div className="flex h-full shrink-0 items-stretch" role="group" aria-label={tr("窗口控制")}>
        <button
          type="button"
          aria-label={tr("最小化")}
          onClick={() => void run('minimize')}
          className="grid w-10.5 place-items-center text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
        >
          <Minus className="size-3.5 stroke-[1.6]" />
        </button>
        <button
          type="button"
          aria-label={maximizeLabel}
          onClick={() => void run('toggleMaximize')}
          className="grid w-10.5 place-items-center text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
        >
          {maximized ? <Copy className="size-3 stroke-[1.6]" /> : <Square className="size-3 stroke-[1.6]" />}
        </button>
        <button
          type="button"
          aria-label={tr("隐藏到托盘")}
          title={tr("隐藏到托盘")}
          onClick={() => void run('close')}
          className="grid w-10.5 place-items-center text-muted-foreground transition-colors hover:bg-[#c42b1c] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
        >
          <X className="size-3.5 stroke-[1.6]" />
        </button>
      </div>
    </header>
  )
}
