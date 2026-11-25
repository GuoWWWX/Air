import { diagnostic, tr, useLanguage } from '@/shared/i18n/messages'
import { selectLocalizedNotes } from '@/shared/i18n/releaseNotes'
import { ArrowDownToLine, Pause, Play } from 'lucide-react'
import { lazy, Suspense } from 'react'
import { formatBytes, formatRate } from '@/shared/lib/utils'
import { Badge } from '@/shared/ui/badge'
import { Button } from '@/shared/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/shared/ui/dialog'
import { openUpdateLink, type Updates } from './useUpdates'

const ReleaseNotes = lazy(() => import('@/shared/ui/ReleaseNotes'))

export function UpdateDialog({ updates }: { updates: Updates }) {
  const lang = useLanguage()
  const { status, busy, open, setOpen } = updates
  if (!status.version) return null
  const { received, total, speed } = status.progress
  const installing = status.phase === 'installing'
  const paused = status.phase === 'paused'
  const interrupted = status.phase === 'interrupted'
  const showProgress = busy || paused || received > 0
  const localizedNotes = status.notes ? selectLocalizedNotes(status.notes, lang.code) : ''

  return (
    <Dialog open={open} onOpenChange={value => { if (!installing) setOpen(value) }}>
      <DialogContent className="max-w-[450px] gap-3 p-4">
        <DialogHeader className="items-start pb-1">
          <span className="grid size-8 shrink-0 place-items-center rounded-lg border border-accent-border bg-accent-soft text-primary">
            <ArrowDownToLine className="size-4" />
          </span>
          <div className="flex flex-1 flex-col gap-0.5">
            <DialogTitle className="text-[15px]">Air Proxy {status.version}{tr(" 可更新")}</DialogTitle>
            <DialogDescription className="text-[11.5px] leading-snug">
              {tr('当前版本 {0}。下载完成后，Air Proxy 会关闭代理、覆盖安装并重新打开。', status.current)}
            </DialogDescription>
          </div>
          <Badge variant="accent">v{status.version}</Badge>
        </DialogHeader>
        <div className="air-scroll max-h-[200px] min-h-0 overflow-y-auto rounded-lg border border-border bg-muted/55 p-3 dark:bg-background/60">
          <h3 className="mb-1.5 text-[11px] font-semibold text-muted-foreground">{tr("更新内容")}</h3>
          {localizedNotes ? (
            <Suspense fallback={<p className="text-xs text-muted-foreground">{tr("正在加载更新说明…")}</p>}>
              <ReleaseNotes
                notes={localizedNotes}
                compact
                onOpenLink={url => void openUpdateLink(url).catch(updates.onError)}
              />
            </Suspense>
          ) : <p className="text-xs text-muted-foreground">{tr("此版本没有附带更新说明。")}</p>}
        </div>
        {showProgress && (
          <div className="flex shrink-0 flex-col gap-1.5">
            <div className="flex justify-between gap-2 text-xs">
              <span>
                {installing
                  ? tr('正在安装并重启')
                  : paused
                    ? tr('已暂停')
                    : status.phase === 'preparing'
                      ? tr('正在准备更新')
                      : interrupted
                        ? tr('下载中断')
                        : tr('正在下载增量包')}
              </span>
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
            <div className="mono flex justify-between gap-2 text-[11.5px] text-muted-foreground">
              <span>{total ? `${formatBytes(received)} / ${formatBytes(total)}` : tr('正在计算下载大小')}</span>
              <span>{status.phase === 'downloading' && speed > 0 ? formatRate(speed) : '—'}</span>
            </div>
          </div>
        )}
        {status.message && (
          <p
            role={interrupted ? 'alert' : 'status'}
            className={interrupted ? 'text-xs font-medium text-destructive' : 'text-xs text-muted-foreground'}
          >
            {diagnostic(status.message)}
          </p>
        )}
        <DialogFooter className="shrink-0 pt-2">
          {busy || paused || interrupted ? (
            <Button variant="ghost" size="sm" disabled={installing} onClick={updates.cancel}>{tr("取消")}</Button>
          ) : (
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => void updates.ignore()}>{tr("忽略")}</Button>
          )}
          <div className="ml-auto flex gap-2">
            <Button variant="outline" size="sm" disabled={installing} onClick={() => setOpen(false)}>{tr("稍后")}</Button>
            {status.phase === 'downloading' || status.phase === 'preparing' ? (
              <Button variant="default" size="sm" disabled={installing} onClick={updates.pause}>
                <Pause data-icon="inline-start" />
                {tr("暂停")}
              </Button>
            ) : (
              <Button variant="default" size="sm" disabled={busy || status.phase === 'checking'} onClick={updates.start}>
                {paused ? <Play data-icon="inline-start" /> : <ArrowDownToLine data-icon="inline-start" />}
                {installing
                  ? tr('正在安装并重启')
                  : paused
                    ? tr('继续下载')
                    : interrupted
                      ? tr('重试更新')
                      : tr('立即更新')}
              </Button>
            )}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
