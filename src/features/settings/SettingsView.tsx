import {
  Activity,
  ArrowLeft,
  Check,
  ChevronRight,
  Info,
  Monitor,
  Network,
  Globe,
  FileCode2,
  Plug,
  Moon,
  Palette,
  Settings,
  Sun,
  Waypoints,
} from 'lucide-react'
import { lazy, Suspense, type ReactNode } from 'react'
import { cn } from '@/shared/lib/utils'
import { Badge } from '@/shared/ui/badge'
import { Button } from '@/shared/ui/button'
import { Card } from '@/shared/ui/card'
import { Input } from '@/shared/ui/input'
import { Label } from '@/shared/ui/label'
import { showMessage } from '@/shared/ui/message'
import { Separator } from '@/shared/ui/separator'
import { Switch } from '@/shared/ui/switch'
import { TraceLines } from '@/shared/ui/TraceLines'
import type { Nodes } from '../nodes/useNodes'
import { AboutPanel } from '../updates/AboutPanel'
import type { Updates } from '../updates/useUpdates'
import { NetworkPanel, type NetworkPage } from './NetworkPanel'
import { StartupSettingsCard } from './StartupSettingsCard'
const ConfigFilePanel = lazy(() => import('./ConfigFilePanel'))

export type ThemeMode = 'system' | 'light' | 'dark'
export type SettingsPage = 'overview' | 'theme' | 'kernel' | 'monitoring' | 'routing' | 'about' | 'configFile' | NetworkPage

export const themeOptions = [
  { id: 'system', label: '跟随系统', desc: '自动匹配 Windows 外观偏好', icon: Monitor },
  { id: 'light', label: '浅色', desc: '明亮清透的冷白工作区', icon: Sun },
  { id: 'dark', label: '深色', desc: '纯粹沉稳的中性碳黑', icon: Moon },
] as const

function ThemeThumbnail({ mode }: { mode: ThemeMode }) {
  if (mode === 'system') {
    return (
      <div className="relative grid h-20 w-full grid-cols-2 overflow-hidden rounded-[7px] border border-border">
        <div className="flex flex-col gap-1.5 bg-[#f3f5f9] p-2">
          <div className="h-2.5 w-full rounded-xs bg-white shadow-2xs" />
          <div className="flex flex-1 gap-1.5">
            <div className="w-5 rounded-xs bg-white" />
            <div className="flex-1 rounded-xs border border-[#c5d7fb] bg-[#ebf1ff]" />
          </div>
        </div>
        <div className="flex flex-col gap-1.5 bg-[#161618] p-2">
          <div className="h-2.5 w-full rounded-xs bg-[#1e1e21]" />
          <div className="flex flex-1 gap-1.5">
            <div className="w-5 rounded-xs bg-[#121214]" />
            <div className="flex-1 rounded-xs border border-[#3f4352] bg-[#262830]" />
          </div>
        </div>
      </div>
    )
  }

  const dark = mode === 'dark'
  return (
    <div
      className={cn(
        'flex h-20 w-full flex-col gap-1.5 overflow-hidden rounded-[7px] border p-2',
        dark ? 'border-[#2c2c31] bg-[#161618]' : 'border-[#e1e7f0] bg-[#f3f5f9]',
      )}
    >
      <div
        className={cn(
          'flex h-3 items-center justify-between rounded-xs px-1.5',
          dark ? 'bg-[#121214]' : 'bg-white',
        )}
      >
        <span className={cn('size-1.5 rounded-full', dark ? 'bg-[#a3b8ff]' : 'bg-[#2956d4]')} />
        <span className={cn('h-1 w-6 rounded-full', dark ? 'bg-[#2c2c31]' : 'bg-[#dce3ee]')} />
      </div>
      <div className="flex flex-1 gap-1.5">
        <div
          className={cn(
            'flex w-7 flex-col gap-1 rounded-xs p-1',
            dark ? 'bg-[#121214]' : 'bg-white',
          )}
        >
          <span className={cn('h-1 w-full rounded-xs', dark ? 'bg-[#262830]' : 'bg-[#ebf1ff]')} />
          <span className={cn('h-1 w-4/5 rounded-xs', dark ? 'bg-[#27272b]' : 'bg-[#eef2f7]')} />
        </div>
        <div className="grid flex-1 grid-cols-2 gap-1.5">
          <div
            className={cn(
              'rounded-xs border',
              dark ? 'border-[#3f4352] bg-[#262830]' : 'border-[#b2c6fa] bg-[#ebf1ff]',
            )}
          />
          <div
            className={cn(
              'rounded-xs border',
              dark ? 'border-[#2c2c31] bg-[#1e1e21]' : 'border-[#e1e7f0] bg-white',
            )}
          />
        </div>
      </div>
    </div>
  )
}

function SettingRow({
  icon,
  title,
  description,
  trailing,
  onClick,
}: {
  icon: ReactNode
  title: string
  description: string
  trailing?: ReactNode
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-3 px-4 py-3.5 text-left transition-colors hover:bg-muted/55 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/60"
    >
      <span className="grid size-8.5 shrink-0 place-items-center rounded-[8px] border border-border-subtle bg-muted/70 text-muted-foreground [&_svg]:size-4">
        {icon}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <strong className="text-sm font-semibold text-foreground">{title}</strong>
        <small className="text-xs text-muted-foreground">{description}</small>
      </span>
      {trailing}
      <ChevronRight className="size-4 shrink-0 text-icon-muted" />
    </button>
  )
}

export function SettingsView({
  settingsPage,
  theme,
  activeTheme,
  kernelDraft,
  store,
  updates,
  onOpenSettings,
  onOpenRouting,
  onSetTheme,
  onKernelDraft,
}: {
  settingsPage: Exclude<SettingsPage, 'routing'>
  theme: ThemeMode
  activeTheme: 'light' | 'dark'
  kernelDraft: string
  store: Nodes
  updates: Updates
  onOpenSettings: (page: SettingsPage) => void
  onOpenRouting: () => void
  onSetTheme: (theme: ThemeMode) => void
  onKernelDraft: (value: string) => void
}) {
  const currentThemeLabel = themeOptions.find(item => item.id === theme)?.label
  const nodes = store.library.nodes
  const sampleCounts = { available: 0, timeout: 0, unreachable: 0 }
  if (settingsPage === 'monitoring') {
    for (const { status } of nodes) {
      if (status) sampleCounts[status]++
    }
  }
  const measured = sampleCounts.available + sampleCounts.timeout + sampleCounts.unreachable

  return (
    <section className="air-scroll h-full overflow-y-auto px-5 py-7">
      <div className={cn('mx-auto flex w-full max-w-[640px] flex-col gap-5', settingsPage === 'configFile' && 'h-full min-h-[350px]')}>
        {settingsPage === 'overview' ? (
          <>
            <header className="flex flex-col gap-1">
              <div className="flex items-center justify-between gap-4">
                <h1 className="text-[26px] font-bold tracking-tight text-foreground">设置</h1>
                <TraceLines variant="settings" />
              </div>
              <p className="text-xs text-muted-foreground">管理代理网络、分流规则、配置文件与后台测速</p>
            </header>

            <StartupSettingsCard />

            <section className="flex flex-col gap-2">
              <h2 className="px-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                外观
              </h2>
              <Card className="overflow-hidden p-0">
                <SettingRow
                  icon={<Palette />}
                  title="主题"
                  description="选择浅色、深色或跟随 Windows 系统外观"
                  trailing={<Badge variant="default">{currentThemeLabel}</Badge>}
                  onClick={() => onOpenSettings('theme')}
                />
              </Card>
            </section>

            <section className="flex flex-col gap-2">
              <h2 className="px-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                代理配置
              </h2>
              <Card className="overflow-hidden p-0">
                <SettingRow icon={<Globe />} title="DNS 设置" description="主 DNS、加密解析、分域 DNS 与 Fake-IP" onClick={() => onOpenSettings('dns')} />
                <Separator />
                <SettingRow icon={<Network />} title="虚拟网卡（TUN）" description="协议栈、MTU、DNS 劫持与绕过网段" onClick={() => onOpenSettings('tun')} />
                <Separator />
                <SettingRow icon={<Plug />} title="代理接入" description="本地端口、局域网共享、IPv6 与系统代理绕过" onClick={() => onOpenSettings('inbound')} />
                <Separator />
                <SettingRow
                  icon={<Waypoints />}
                  title="分流规则"
                  description="按域名、IP 网段或 Windows 程序路径选择出站"
                  onClick={onOpenRouting}
                />
                <Separator />
                <SettingRow
                  icon={<Settings />}
                  title="诊断内核"
                  description="配置本机 Mihomo 可执行文件路径"
                  trailing={
                    <Badge variant={store.kernelPath ? 'success' : 'warning'}>
                      {store.kernelPath ? '已就绪' : '未配置'}
                    </Badge>
                  }
                  onClick={() => onOpenSettings('kernel')}
                />
                <Separator />
                <SettingRow icon={<FileCode2 />} title="配置文件" description="编辑和校验 Air 的 YAML 配置" onClick={() => onOpenSettings('configFile')} />
              </Card>
            </section>

            <section className="flex flex-col gap-2">
              <h2 className="px-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                监测
              </h2>
              <Card className="overflow-hidden p-0">
                <SettingRow
                  icon={<Activity />}
                  title="后台监测"
                  description="窗口收起后自动刷新节点可用率与延迟"
                  trailing={
                    <Badge variant={store.background ? 'accent' : 'default'}>
                      {store.background ? '已开启' : '已关闭'}
                    </Badge>
                  }
                  onClick={() => onOpenSettings('monitoring')}
                />
              </Card>
            </section>
            <Card className="overflow-hidden p-0">
              <SettingRow
                icon={<Info />}
                title="关于"
                description="Air 版本、软件更新与作者 GitHub"
                onClick={() => onOpenSettings('about')}
              />
            </Card>
          </>
        ) : (
          <>
            <header className="flex flex-col items-start gap-2.5">
              <Button
                variant="ghost"
                size="sm"
                className="text-[14px]"
                onClick={() => onOpenSettings('overview')}
              >
                <ArrowLeft data-icon="inline-start" />
                返回设置
              </Button>
              <h1 className="text-[24px] font-bold tracking-tight text-foreground">
                {settingsPage === 'theme'
                  ? '主题'
                  : settingsPage === 'kernel'
                    ? '诊断内核'
                    : ({ about: '关于', monitoring: '后台监测', dns: 'DNS 设置', tun: '虚拟网卡（TUN）', inbound: '代理接入', configFile: '配置文件' } as const)[settingsPage]}
              </h1>
            </header>

            {settingsPage === 'about' && <AboutPanel updates={updates} />}
            {settingsPage === 'configFile' && (
              <Suspense fallback={<span role="status">正在打开编辑器…</span>}><ConfigFilePanel /></Suspense>
            )}
            {(['dns', 'tun', 'inbound'] as const).map(page =>
              settingsPage === page && <NetworkPanel key={page} page={page} kernelPath={store.kernelPath} sources={store.library.sources} />)}

            {settingsPage === 'theme' && (
              <div className="flex flex-col gap-4">
                <Card className="flex-row items-center justify-between gap-4 p-4">
                  <div className="flex flex-col gap-1">
                    <strong className="text-sm font-semibold text-foreground">当前外观</strong>
                    <p className="text-xs text-muted-foreground">
                      正在使用{activeTheme === 'dark' ? '深色' : '浅色'}主题（{currentThemeLabel}）
                    </p>
                  </div>
                  <Badge variant="accent">
                    {activeTheme === 'dark' ? 'Dark Mode' : 'Light Mode'}
                  </Badge>
                </Card>

                <div className="grid grid-cols-1 gap-3 sm:grid-cols-3" role="group" aria-label="主题模式">
                  {themeOptions.map(({ id, label, desc, icon: Icon }) => {
                    const selected = theme === id
                    return (
                      <button
                        key={id}
                        type="button"
                        aria-pressed={selected}
                        onClick={() => onSetTheme(id)}
                        className={cn(
                          'air-card-surface flex flex-col gap-3 rounded-[11px] border p-3 text-left transition-all duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60',
                          selected
                            ? 'border-primary bg-accent-soft/45 ring-2 ring-primary/20'
                            : 'border-border hover:border-accent-border',
                        )}
                      >
                        <ThemeThumbnail mode={id} />
                        <div className="flex items-start justify-between gap-2">
                          <div className="flex flex-col gap-0.5">
                            <span className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
                              <Icon className="size-3.5 text-primary" />
                              {label}
                            </span>
                            <span className="text-[12px] text-muted-foreground">{desc}</span>
                          </div>
                          {selected && (
                            <span className="grid size-4.5 shrink-0 place-items-center rounded-full bg-primary text-primary-foreground">
                              <Check className="size-3 stroke-[2.6]" />
                            </span>
                          )}
                        </div>
                      </button>
                    )
                  })}
                </div>
              </div>
            )}

            {settingsPage === 'kernel' && (
              <Card className="p-5">
                <form
                  className="flex flex-col gap-4"
                  onSubmit={event => {
                    event.preventDefault()
                    store.setKernelPath(kernelDraft)
                    showMessage({ type: 'success', title: '诊断内核路径已保存' })
                  }}
                >
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="kernel-path-input">Mihomo 可执行文件路径</Label>
                    <Input
                      id="kernel-path-input"
                      value={kernelDraft}
                      onChange={e => onKernelDraft(e.target.value)}
                      placeholder={store.defaultKernelPath || 'C:\\Mihomo\\mihomo.exe'}
                      spellCheck={false}
                      className="mono"
                    />
                    <p className="text-[12px] text-muted-foreground">
                      {store.defaultKernelPath
                        ? '已检测到随 Air 放置的默认内核，留空即可自动使用。'
                        : '请填写本机 Mihomo 可执行文件的完整路径。'}
                    </p>
                  </div>
                  <div className="flex items-center justify-end gap-2">
                    <Button type="submit" variant="default">
                      保存路径
                    </Button>
                  </div>
                </form>
              </Card>
            )}

            {settingsPage === 'monitoring' && (
              <Card className="gap-4 p-5">
                <label className="flex cursor-pointer items-center justify-between gap-4">
                  <div className="flex flex-col gap-1">
                    <strong className="text-sm font-semibold text-foreground">
                      后台定时测速
                    </strong>
                    <span className="text-xs text-muted-foreground">
                      {store.kernelPath
                        ? '窗口最小化或隐藏到托盘时更新测速结果，打开窗口时显示已保存的结果。'
                        : '请先在「诊断内核」配置 Mihomo 路径后再开启后台监测。'}
                    </span>
                  </div>
                  <Switch
                    aria-label="后台定时测速"
                    checked={store.background}
                    disabled={!store.kernelPath}
                    onCheckedChange={enabled => {
                      store.toggleBackground(enabled)
                      showMessage({ type: 'success', title: enabled ? '已开启后台定时测速' : '已关闭后台定时测速' })
                    }}
                  />
                </label>

                {store.backgroundError || store.progress?.error ? (
                  <p className="rounded-[7px] border border-destructive/25 bg-danger-soft px-3 py-2 text-xs text-destructive">
                    {store.backgroundError || store.progress?.error}
                  </p>
                ) : (
                  measured > 0 && (
                    <div className="flex flex-wrap items-center gap-2 rounded-[8px] border border-border-subtle bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
                      <span className="mono font-semibold text-foreground">
                        {measured} / {nodes.length}
                      </span>
                      <Separator orientation="vertical" className="h-3.5" />
                      <span className="text-success">{sampleCounts.available} 可用</span>
                      <span>·</span>
                      <span className="text-warning">{sampleCounts.timeout} 超时</span>
                      <span>·</span>
                      <span className="text-destructive">{sampleCounts.unreachable} 失败</span>
                    </div>
                  )
                )}
              </Card>
            )}
            {settingsPage === 'monitoring' && <NetworkPanel page="monitoring" />}
          </>
        )}
      </div>
    </section>
  )
}
