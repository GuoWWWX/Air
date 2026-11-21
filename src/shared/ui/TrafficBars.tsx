import { cn } from '@/shared/lib/utils'

export const idleHeights = [14, 18, 12, 22, 28, 18, 14, 24, 16, 20, 30, 22, 16, 12, 18, 24, 20]

export function trafficHeights(history: number[]) {
  const scale = Math.max(...history, 1)
  return [
    ...Array<number>(idleHeights.length - history.length).fill(4),
    ...history.map(rate => Math.max(4, Math.round((rate / scale) * 96))),
  ]
}

export function TrafficBars({ running, heights }: { running: boolean; heights: readonly number[] }) {
  return (
    <div
      className="flex h-7 items-end gap-1 border-b border-border-subtle pt-1 pb-0.5"
      aria-hidden="true"
    >
      {heights.map((height, index) => {
        const last = index === heights.length - 1
        return (
          <span
            key={index}
            style={{ height: `${running ? height : Math.max(12, Math.round(height * 0.45))}%` }}
            className={cn(
              'flex-1 rounded-t-[2px] transition-all duration-300',
              running
                ? last
                  ? 'bg-primary'
                  : 'bg-primary/40'
                : last
                  ? 'bg-muted-foreground/30'
                  : 'bg-muted',
            )}
          />
        )
      })}
    </div>
  )
}
