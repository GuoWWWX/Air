import { tr } from '@/shared/i18n/messages'
import { Play, Square } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { useState } from 'react'
import { cn, formatCompactRate } from '@/shared/lib/utils'
import type { ProxyTraffic } from '@/shared/proxy/state'

const minimumMotionTime = { start: 650, stop: 320 }

export function waitForProxyPowerAnimation(action: 'start' | 'stop', startedAt: number) {
  const remaining = minimumMotionTime[action] - (performance.now() - startedAt)
  return remaining <= 0 ? Promise.resolve() : new Promise<void>(resolve => {
    window.setTimeout(resolve, remaining)
  })
}

function OrbitRing({ duration }: { duration: number }) {
  return (
    <motion.svg
      viewBox="0 0 20 20"
      className="size-4"
      aria-hidden="true"
      animate={{ rotate: 360 }}
      transition={{ duration, ease: 'linear', repeat: Infinity }}
    >
      <circle
        cx="10"
        cy="10"
        r="6.5"
        fill="none"
        stroke="currentColor"
        strokeOpacity="0.22"
        strokeWidth="2"
      />
      <circle
        cx="10"
        cy="10"
        r="6.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeDasharray="15 29"
      />
    </motion.svg>
  )
}

function RunningWaveform({ level }: { level: number }) {
  const columns = [
    { weight: 0.62, delay: 0 },
    { weight: 0.9, delay: 0.14 },
    { weight: 1, delay: 0.28 },
    { weight: 0.82, delay: 0.1 },
    { weight: 0.56, delay: 0.22 },
  ] as const

  const duration = 1.25 - level * 0.5

  return (
    <span className="flex h-3.5 items-center justify-center gap-[2.5px]" aria-hidden="true">
      {columns.map((col, index) => {
        const low = 0.22 + level * 0.2 * col.weight
        const high = Math.min(1, 0.34 + level * 0.66 * col.weight)
        const mid = (low + high) * 0.56
        return (
          <motion.span
            key={index}
            animate={{ scaleY: [low, high, mid, high * 0.88] }}
            transition={{
              duration,
              repeat: Infinity,
              ease: 'easeInOut',
              delay: col.delay,
            }}
            className="h-3.5 w-[2px] origin-center rounded-full bg-current"
          />
        )
      })}
    </span>
  )
}

export function ProxyPowerButton({
  phase,
  tone,
  traffic,
  mobile = false,
  disabled = false,
  onToggle,
}: {
  phase: 'idle' | 'starting' | 'running' | 'stopping'
  tone: 'stopped' | 'running' | 'system-proxy' | 'tun'
  traffic?: Pick<ProxyTraffic, 'uploadRate' | 'downloadRate'>
  mobile?: boolean
  disabled?: boolean
  onToggle: () => void
}) {
  const [hovered, setHovered] = useState(false)
  const [focusVisible, setFocusVisible] = useState(false)

  const switching = phase === 'starting' || phase === 'stopping'

  const totalRate = traffic ? traffic.uploadRate + traffic.downloadRate : 0
  const activityLevel =
    totalRate <= 0 ? 0 : Math.min(1, Math.max(0.15, Math.log10(1 + totalRate / 2048) / 3.6))

  const label =
    phase === 'starting'
      ? tr('正在启动代理…')
      : phase === 'stopping'
        ? tr('正在停止代理…')
        : phase === 'running'
          ? traffic
            ? tr("代理运行中 · ↑{0} ↓{1}（点击停止）", formatCompactRate(traffic.uploadRate), formatCompactRate(traffic.downloadRate))
            : tr('代理运行中 · 等待流量数据（点击停止）')
          : tr('启动代理')

  const isActiveSurface = phase === 'running' || phase === 'stopping'
  const showStopIcon = !mobile && phase === 'running' && (hovered || focusVisible)
  const targetWidth = phase === 'running' ? (mobile ? 132 : 104) : (mobile ? 104 : 36)

  return (
    <motion.button
      type="button"
      data-proxy-power={tone}
      aria-label={mobile && phase === 'running' ? tr('停止代理') : label}
      title={label}
      aria-busy={switching}
      disabled={disabled}
      initial={false}
      animate={{ width: targetWidth }}
      whileTap={switching || disabled ? undefined : { scale: 0.94 }}
      transition={{
        width: { type: 'spring', stiffness: 420, damping: 32 },
        scale: { type: 'spring', stiffness: 540, damping: 32 },
      }}
      onPointerEnter={event => {
        if (event.pointerType === 'mouse') setHovered(true)
      }}
      onPointerLeave={event => {
        if (event.pointerType === 'mouse') setHovered(false)
      }}
      onFocus={event => setFocusVisible(event.currentTarget.matches(':focus-visible'))}
      onBlur={() => setFocusVisible(false)}
      onClick={() => {
        if (!switching && !disabled) onToggle()
      }}
      className={cn(
        'relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-[7px] px-2 outline-none transition-[background-color,border-color,box-shadow,color] duration-300 ease-out select-none focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-offset-1 focus-visible:ring-offset-background',
        mobile ? 'h-9' : 'h-7',
        switching ? 'cursor-wait' : 'cursor-pointer',
        isActiveSurface
          ? cn(
              'border border-[var(--proxy-power-border)] bg-[var(--proxy-power-surface)] text-[color:var(--proxy-power-ink)] hover:border-[var(--proxy-power-color)]',
              activityLevel > 0.55
                ? 'shadow-[0_0_16px_color-mix(in_srgb,var(--proxy-power-color)_28%,transparent)]'
                : 'shadow-[0_0_10px_color-mix(in_srgb,var(--proxy-power-color)_14%,transparent)]',
            )
          : cn(
              'border border-[var(--proxy-power-border)] bg-gradient-to-b from-[var(--proxy-power-color)] to-[var(--proxy-power-depth)] text-white hover:from-[var(--proxy-power-highlight)]',
              phase === 'starting'
                ? 'shadow-[0_0_16px_color-mix(in_srgb,var(--proxy-power-color)_48%,transparent),inset_0_1px_0_rgba(255,255,255,0.28)]'
                : 'shadow-[0_1px_2px_color-mix(in_srgb,var(--proxy-power-color)_28%,transparent),inset_0_1px_0_rgba(255,255,255,0.18)]',
            ),
      )}
    >
      {phase === 'starting' && (
        <>
          <motion.span
            aria-hidden="true"
            initial={{ scale: 0.35, opacity: 0.7 }}
            animate={{ scale: 1.9, opacity: 0 }}
            transition={{ duration: 0.65, ease: 'easeOut' }}
            className="pointer-events-none absolute inset-0 rounded-[7px] bg-white/35"
          />
          <motion.span
            aria-hidden="true"
            initial={{ x: '-140%' }}
            animate={{ x: '160%' }}
            transition={{
              duration: 0.85,
              ease: [0.22, 1, 0.36, 1],
              repeat: Infinity,
              repeatDelay: 0.2,
            }}
            className="pointer-events-none absolute inset-y-0 w-1/2 -skew-x-20 bg-gradient-to-r from-transparent via-white/40 to-transparent"
          />
        </>
      )}

      <AnimatePresence mode="wait" initial={false}>
        {phase === 'starting' ? (
          <motion.span
            key="starting"
            initial={{ opacity: 0, scale: 0.72 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.75 }}
            transition={{ duration: 0.16, ease: 'easeOut' }}
            className="relative z-10 inline-flex items-center justify-center gap-1.5"
          >
            <OrbitRing duration={0.85} />
            {mobile && <span className="whitespace-nowrap text-xs font-semibold">{tr("正在启动")}</span>}
          </motion.span>
        ) : phase === 'stopping' ? (
          <motion.span
            key="stopping"
            initial={{ opacity: 0, scale: 0.8 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.65 }}
            transition={{ duration: 0.14 }}
            className="relative z-10 inline-flex items-center justify-center gap-1.5"
          >
            <OrbitRing duration={0.7} />
            {mobile && <span className="whitespace-nowrap text-xs font-semibold">{tr("正在停止")}</span>}
          </motion.span>
        ) : phase === 'running' ? (
          <motion.span
            key="running"
            initial={{ opacity: 0, scale: 0.88 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.85 }}
            transition={{ duration: 0.18, ease: 'easeOut' }}
            className="relative z-10 flex w-full items-center justify-center"
          >
            <AnimatePresence mode="wait" initial={false}>
              {showStopIcon ? (
                <motion.span
                  key="stop"
                  initial={{ opacity: 0, scale: 0.86 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.86 }}
                  transition={{ duration: 0.12 }}
                  className="inline-flex items-center gap-1.5 text-[12px] font-semibold whitespace-nowrap"
                >
                  <Square className="size-3 stroke-[2.1]" />
                  <span>{tr("停止")}</span>
                </motion.span>
              ) : (
                <motion.span
                  key="traffic"
                  initial={{ opacity: 0, scale: 0.9 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.9 }}
                  transition={{ duration: 0.12 }}
                  className="flex w-full items-center justify-between gap-1.5 px-0.5"
                >
                  <RunningWaveform level={activityLevel} />
                  <span className={cn(mobile ? 'font-mono' : 'mono', 'text-xs font-semibold tabular-nums whitespace-nowrap')}>
                    {traffic ? formatCompactRate(totalRate) : '—'}
                  </span>
                  {mobile && <Square aria-hidden="true" className="size-3 shrink-0 fill-current" />}
                </motion.span>
              )}
            </AnimatePresence>
          </motion.span>
        ) : (
          <motion.span
            key="idle"
            initial={{ opacity: 0, scale: 0.72, rotate: -18 }}
            animate={{ opacity: 1, scale: 1, rotate: 0 }}
            exit={{ opacity: 0, scale: 0.65, rotate: 24 }}
            transition={{ duration: 0.16, ease: 'easeOut' }}
            className="relative z-10 inline-flex items-center justify-center gap-1.5"
          >
            <Play className="size-3.5 translate-x-[0.5px] fill-current" />
            {mobile && <span className="whitespace-nowrap text-xs font-semibold">{tr("启动代理")}</span>}
          </motion.span>
        )}
      </AnimatePresence>
    </motion.button>
  )
}
