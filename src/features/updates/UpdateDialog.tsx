import { diagnostic, tr } from '@/shared/i18n/messages'
import { ArrowDownToLine } from 'lucide-react'
import { lazy, Suspense } from 'react'
import { formatBytes, formatRate } from '@/shared/lib/utils'
import { Badge } from '@/shared/ui/badge'
import { Button } from '@/shared/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/shared/ui/dialog'
import type { Updates } from './useUpdates'

const ReleaseNotes = lazy(() => import('./ReleaseNotes'))

export function UpdateDialog({ updates }: { updates: Updates }) {
  const { status, busy, open, setOpen } = updates
  if (!status.version) return null
  const { received, total, speed } = status.progress
  const installing = status.phase === 'installing'
  const showProgress = busy || received > 0
  return (
    <Dialog open={open} onOpenChange={value => { if (!installing) setOpen(value) }}>
      <DialogContent className="max-w-[510px] gap-4">
        <DialogHeader className="items-start">
          <span className="grid size-9 shrink-0 place-items-center rounded-lg border border-accent-border bg-accent-soft text-primary">
            <ArrowDownToLine className="size-4.5" />
          </span>
          <div className="flex flex-1 flex-col gap-1">
            <DialogTitle>Air Proxy {status.version}{tr(" 可更新")}</DialogTitle>
            <DialogDescription>{tr('当前版本 {0}。下载完成后，Air Proxy 会关闭代理、覆盖安装并重新打开。', status.current)}</DialogDescription>
          </div>
          <Badge variant="accent">v{status.version}</Badge>
        </DialogHeader>
        <div className="air-scroll min-h-0 overflow-y-auto rounded-lg border border-border bg-muted/55 p-3.5 dark:bg-background/60">
          <h3 className="mb-2 text-xs font-semibold text-muted-foreground">{tr("更新内容")}</h3>
          {status.notes ? (
            <Suspense fallback={<p className="text-xs text-muted-foreground">{tr("正在加载更新说明…")}</p>}>
              <ReleaseNotes notes={status.notes} onError={updates.onError} />
            </Suspense>
          ) : <p className="text-sm text-muted-foreground">{tr("此版本没有附带更新说明。")}</p>}
        </div>
        {showProgress && (
          <div className="flex shrink-0 flex-col gap-2">
            <div className="flex justify-between gap-2 text-xs">
              <span>{installing ? tr('正在安装并重启') : status.phase === 'preparing' ? tr('正在准备更新') : status.phase === 'interrupted' ? tr('下载中断') : tr('正在下载增量包')}</span>
              {total > 0 && <strong className="mono">{Math.floor(received / total * 100)}%</strong>}
            </div>
            {total > 0 ? (
              <progress
                className="h-2 w-full appearance-none overflow-hidden rounded-full [&::-webkit-progress-bar]:rounded-full [&::-webkit-progress-bar]:bg-muted [&::-webkit-progress-value]:rounded-full [&::-webkit-progress-value]:bg-primary [&::-webkit-progress-value]:transition-[width]"
                aria-label={tr("更新下载进度")}
                max={total}
                value={received}
              />
            ) : (
              <div
                role="progressbar"
                aria-label={tr("更新下载进度")}
                className="relative h-2 w-full overflow-hidden rounded-full bg-muted"
              >
                <span className="block h-full w-2/5 animate-pulse rounded-full bg-primary" />
              </div>
            )}
            <div className="mono flex justify-between gap-2 text-xs text-muted-foreground">
              <span>{total ? `${formatBytes(received)} / ${formatBytes(total)}` : tr('正在计算下载大小')}</span>
              <span>{status.phase === 'downloading' && speed > 0 ? formatRate(speed) : '—'}</span>
            </div>
          </div>
        )}
        {status.message && (
          <p
            role={status.phase === 'interrupted' ? 'alert' : 'status'}
            className={status.phase === 'interrupted' ? 'text-xs font-medium text-destructive' : 'text-xs text-muted-foreground'}
          >
            {diagnostic(status.message)}
          </p>
        )}
        <DialogFooter className="shrink-0">
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => void updates.ignore()}>{tr("忽略")}</Button>
          <div className="ml-auto flex gap-2">
            <Button variant="outline" size="sm" disabled={installing} onClick={() => setOpen(false)}>{tr("稍后")}</Button>
            <Button variant="default" size="sm" disabled={busy || status.phase === 'checking'} onClick={updates.start}>
              <ArrowDownToLine data-icon="inline-start" />
              {busy ? tr('更新中') : status.phase === 'interrupted' ? tr('重试更新') : tr('立即更新')}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
