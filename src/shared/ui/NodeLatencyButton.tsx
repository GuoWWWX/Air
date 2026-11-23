import { tr } from '@/shared/i18n/messages'
import { AnimatePresence, motion } from 'motion/react'
import { cn } from '@/shared/lib/utils'

function ProbeSpinner({ compact }: { compact: boolean }) {
  return (
    <svg
      viewBox="0 0 20 20"
      className={cn('relative z-10 animate-spin', compact ? 'size-3' : 'size-3.5')}
      aria-hidden="true"
    >
      <circle
        cx="10"
        cy="10"
        r="6.5"
        fill="none"
        stroke="currentColor"
        strokeOpacity="0.22"
        strokeWidth="2.2"
      />
      <circle
        cx="10"
        cy="10"
        r="6.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeDasharray="16 28"
      />
    </svg>
  )
}

export function NodeLatencyButton({ node, compact = false, testing, onMeasure, disabled, className }: {
  node: { name: string; latestMs: number | null; status: 'available' | 'timeout' | 'unreachable' | null }
  compact?: boolean
  testing: boolean
  onMeasure: () => void
  disabled?: boolean
  className?: string
}) {
  const ms = node.latestMs
  const label =
    ms !== null
      ? `${ms} ms`
      : node.status === 'timeout'
        ? tr('超时')
        : node.status === 'unreachable'
          ? tr('失败')
          : tr('测延迟')

  let toneClass = 'bg-accent-soft text-primary hover:bg-primary/15'
  if (testing) {
    toneClass = 'bg-accent-soft text-primary'
  } else if (ms !== null) {
    toneClass =
      ms <= 500
        ? 'bg-success-soft text-success hover:bg-success/20'
        : ms < 1000
          ? 'bg-warning-soft text-warning hover:bg-warning/20'
          : 'bg-danger-soft text-destructive hover:bg-destructive/20'
  } else if (node.status === 'timeout' || node.status === 'unreachable') {
    toneClass = 'bg-danger-soft text-destructive hover:bg-destructive/20'
  }

  return (
    <button
      type="button"
      data-testing={testing || undefined}
      disabled={testing || disabled}
      aria-busy={testing || undefined}
      title={testing ? tr('正在测速…') : tr('点击重新测速')}
      aria-label={testing ? tr("{0}，正在测速", node.name) : tr("{0}，{1}，点击测速", node.name, label)}
      onClick={event => {
        event.stopPropagation()
        onMeasure()
      }}
      className={cn(
        'air-latency-btn mono relative inline-flex shrink-0 items-center justify-center overflow-hidden whitespace-nowrap font-semibold tabular-nums transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/60 disabled:cursor-wait',
        compact
          ? 'h-5.5 w-[60px] rounded-[4px] px-1 text-[12px]'
          : 'h-6 w-[72px] rounded-[5px] px-1.5 text-xs',
        toneClass,
        className,
      )}
    >
      {testing && <span aria-hidden="true" className="air-latency-shimmer" />}
      <AnimatePresence mode="wait" initial={false}>
        {testing ? (
          <motion.span
            key="loading"
            initial={{ opacity: 0, scale: 0.8 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.8 }}
            transition={{ duration: 0.14 }}
            className="relative z-10 flex size-full items-center justify-center"
          >
            <ProbeSpinner compact={compact} />
          </motion.span>
        ) : (
          <motion.span
            key={label}
            initial={{ opacity: 0, y: 2 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -2 }}
            transition={{ duration: 0.14 }}
            className="relative z-10 inline-flex items-center justify-center"
          >
            {label}
          </motion.span>
        )}
      </AnimatePresence>
    </button>
  )
}
