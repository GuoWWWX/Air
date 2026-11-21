import { isTauri } from '@tauri-apps/api/core'
import airLogo from '@/assets/air-m1.svg?no-inline'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { Copy, Minus, Square, X } from 'lucide-react'
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

const modes = proxyModes.map(({ value, label }) => ({ value, label }))

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

  const maximizeLabel = maximized ? '还原窗口' : '最大化'
  const nodeName = outboundName ?? (onClearNode ? '节点已失效' : undefined)
  const nodeLabel = nodeName && (
    <span className="block min-w-0 truncate">
      <FlagText text={nodeName} />
    </span>
  )

  return (
    <header className="flex h-10.5 shrink-0 items-center border-b border-border bg-shell pl-3.5 select-none">
      <div className="flex items-center gap-2 self-stretch" data-tauri-drag-region>
        <img src={airLogo} alt="" draggable={false} className="pointer-events-none size-6 shrink-0" />
        <strong className="pointer-events-none text-[15px] font-bold tracking-tight text-foreground">
          Air
        </strong>
      </div>

      {nodeName && (
        <div
          role="status"
          aria-label={`当前节点：${nodeName}`}
          title={nodeName}
          className="ml-3 flex min-w-0 max-w-72 items-center gap-2 border-l border-border pl-3 text-xs font-medium text-secondary-foreground"
        >
          {onClearNode ? (
            <DropdownMenu>
              <DropdownMenuTrigger
                aria-label={`当前节点：${nodeName}`}
                className="min-w-0 rounded-sm text-left outline-none transition-colors hover:text-primary focus-visible:ring-2 focus-visible:ring-ring/60"
              >
                {nodeLabel}
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                <DropdownMenuItem onClick={onClearNode}>
                  <X />
                  清除选择
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : nodeLabel}
          {outboundLatency}
        </div>
      )}

      <div className="min-w-4 flex-1 self-stretch" data-tauri-drag-region />

      <div className="flex items-center gap-2 whitespace-nowrap">
        <div className="hidden items-center sm:flex">
          <Segmented
            layoutId="titlebar-proxy-mode"
            ariaLabel="出站模式"
            size="xs"
            value={status.mode}
            options={modes}
            onChange={mode => onControl({ action: 'mode', mode })}
            className="rounded-[7px]"
          />
        </div>

        <Separator orientation="vertical" className="hidden h-3.5 sm:block" />

        <label
          title={`系统代理 · ${captureModeLabel(status.running, status.systemProxy)}`}
          className={cn(
            'inline-flex h-7 cursor-pointer items-center gap-2 rounded-[7px] border px-2.5 text-[12px] font-medium transition-colors select-none',
            status.systemProxy
              ? 'border-accent-border/75 bg-accent-soft/80 text-primary'
              : 'border-border/80 bg-muted/45 text-muted-foreground hover:border-border hover:bg-muted/80 hover:text-foreground',
          )}
        >
          <span>系统代理</span>
          <Switch
            size="sm"
            aria-label="系统代理"
            disabled={Boolean(pending)}
            checked={status.systemProxy}
            onCheckedChange={enabled => onControl({ action: 'systemProxy', enabled })}
          />
        </label>

        <div className="flex items-center gap-0.5">
          <label
            title={`虚拟网卡 · ${captureModeLabel(status.running, status.tun)}`}
            className={cn(
              'inline-flex h-7 cursor-pointer items-center gap-2 rounded-[7px] border px-2.5 text-[12px] font-medium transition-colors select-none',
              status.tun
                ? 'border-accent-border/75 bg-accent-soft/80 text-primary'
                : 'border-border/80 bg-muted/45 text-muted-foreground hover:border-border hover:bg-muted/80 hover:text-foreground',
            )}
          >
            <span>虚拟网卡</span>
            <Switch
              size="sm"
              aria-label="虚拟网卡"
              disabled={Boolean(pending)}
              checked={status.tun}
              onCheckedChange={enabled => onControl({ action: 'tun', enabled })}
            />
          </label>
          {status.tunServiceReady === false && (
            <TunServiceButton onClick={onTunSetup} disabled={Boolean(pending)} />
          )}
        </div>

        <ProxyPowerButton
          phase={pending === 'start' ? 'starting' : pending === 'stop' ? 'stopping' : status.running ? 'running' : 'idle'}
          tone={proxyPowerTone(status)}
          traffic={traffic}
          onToggle={onToggle}
        />
      </div>

      <Separator orientation="vertical" className="ml-2.5 mr-0.5 h-3.5 opacity-70" />

      <div className="flex h-full items-stretch" role="group" aria-label="窗口控制">
        <button
          type="button"
          aria-label="最小化"
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
          aria-label="隐藏到托盘"
          title="隐藏到托盘"
          onClick={() => void run('close')}
          className="grid w-10.5 place-items-center text-muted-foreground transition-colors hover:bg-[#c42b1c] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
        >
          <X className="size-3.5 stroke-[1.6]" />
        </button>
      </div>
    </header>
  )
}
