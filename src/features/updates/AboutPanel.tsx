import { diagnostic, tr } from '@/shared/i18n/messages'
import { isTauri } from '@tauri-apps/api/core'
import airLogo from '@/assets/air-m1.svg?no-inline'
import { RefreshCw } from 'lucide-react'
import { cn, formatBytes } from '@/shared/lib/utils'
import { Badge } from '@/shared/ui/badge'
import { Button } from '@/shared/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/shared/ui/card'
import { openUpdateLink, type Updates } from './useUpdates'

const github = 'https://github.com/GuoWWWX'

export function AboutPanel({ updates }: { updates: Updates }) {
  const { status, busy } = updates
  const message = status.message ?? (
    status.phase === 'checking' ? tr('正在检查更新…')
      : status.phase === 'current' ? tr('当前没有可用更新。')
        : status.version ? (status.ignored ? tr("已忽略 Air Proxy {0}", status.version)
          : status.phase === 'downloading' && status.progress.total
            ? tr("已下载 {0} / {1}", formatBytes(status.progress.received), formatBytes(status.progress.total))
            : busy ? tr('正在准备安装更新…') : tr("发现新版本 Air Proxy {0}", status.version))
          : tr('Air Proxy 会在启动时和后台定期检查更新。')
  )
  return (
    <div className="flex flex-col gap-3">
      <Card className="gap-4 p-4">
        <CardHeader className="justify-start">
          <img src={airLogo} alt="" className="size-10 shrink-0" />
          <div className="flex flex-1 items-center gap-2">
            <CardTitle>Air Proxy</CardTitle>
            <Badge variant="default">v{status.current}</Badge>
          </div>
          <Button variant="outline" size="icon-sm" aria-label={tr("作者的 GitHub 主页")} title="GuoWWWX · GitHub"
            onClick={() => void openUpdateLink(github).catch(updates.onError)}>
            <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
              <path d="M8 0C3.58 0 0 3.58 0 8a8.01 8.01 0 0 0 5.47 7.59c.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.65 7.65 0 0 1 2-.27c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
            </svg>
          </Button>
        </CardHeader>
        <CardContent>
          <p className="text-sm leading-relaxed text-muted-foreground">{tr("Air Proxy 是一个基于 Mihomo 的 Windows 桌面代理客户端，支持管理订阅与节点、配置出站规则与多跳链路，并查看延迟和实时连接。")}</p>
        </CardContent>
      </Card>
      <Card className="flex-row flex-wrap items-center justify-between gap-4 p-4">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <CardTitle>{tr("软件更新")}</CardTitle>
          <p
            className={cn(
              'text-xs break-words',
              status.phase === 'interrupted' ? 'font-medium text-destructive' : 'text-muted-foreground',
            )}
            role="status"
          >
            {diagnostic(message)}
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          {status.version && (
            <Button variant="default" size="sm" onClick={() => updates.setOpen(true)}>{tr("查看更新")}</Button>
          )}
          <Button variant="outline" size="sm" disabled={!isTauri() || busy || status.phase === 'checking'} onClick={() => void updates.check()}>
            <RefreshCw data-icon="inline-start" className={cn(status.phase === 'checking' && 'motion-safe:animate-spin')} />{tr("检查更新")}</Button>
        </div>
      </Card>
    </div>
  )
}
