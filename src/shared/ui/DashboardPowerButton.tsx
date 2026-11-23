import { tr } from '@/shared/i18n/messages'
import { Play, Square } from 'lucide-react'
import { AnimatePresence, motion, useMotionValue, useReducedMotion, useTransform, type MotionValue } from 'motion/react'
import { useState } from 'react'
import { cn, formatCompactRate } from '@/shared/lib/utils'
import type { ProxyPowerState, ProxyTraffic } from '@/shared/proxy/state'
import { proxyPowerTone } from '@/shared/proxy/modes'

function buildWaveBlobPath(lobes: number, radius: number, amplitude: number, samples = 120) {
  const cx = 50
  const cy = 50
  const points: string[] = []
  for (let i = 0; i < samples; i++) {
    const theta = (i / samples) * Math.PI * 2
    const r = radius + amplitude * Math.cos(lobes * theta)
    const x = cx + r * Math.cos(theta)
    const y = cy + r * Math.sin(theta)
    points.push(`${i === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`)
  }
  return `${points.join(' ')} Z`
}

const CORE_BLOB_PATH = buildWaveBlobPath(10, 44.5, 3.2)
const MID_WAVE_PATH = buildWaveBlobPath(10, 45, 3.6)
const BACKDROP_WAVE_PATH = buildWaveBlobPath(9, 44, 4.4)

function PowerOrbitRing({ duration }: { duration: number }) {
  return (
    <motion.svg
      viewBox="0 0 28 28"
      className="size-7"
      aria-hidden="true"
      animate={{ rotate: 360 }}
      transition={{ duration, ease: 'linear', repeat: Infinity }}
    >
      <circle
        cx="14"
        cy="14"
        r="9.5"
        fill="none"
        stroke="currentColor"
        strokeOpacity="0.26"
        strokeWidth="2.5"
      />
      <circle
        cx="14"
        cy="14"
        r="9.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeDasharray="22 40"
      />
    </motion.svg>
  )
}

function PowerWaveform({ level }: { level: number }) {
  const columns = [
    { weight: 0.56, delay: 0 },
    { weight: 0.88, delay: 0.14 },
    { weight: 1, delay: 0.26 },
    { weight: 0.82, delay: 0.1 },
    { weight: 0.58, delay: 0.2 },
  ] as const

  const duration = 1.2 - level * 0.45

  return (
    <span className="flex h-6 items-center justify-center gap-[3.5px]" aria-hidden="true">
      {columns.map((col, index) => {
        const low = 0.26 + level * 0.18 * col.weight
        const high = Math.min(1, 0.4 + level * 0.6 * col.weight)
        const mid = (low + high) * 0.58
        return (
          <motion.span
            key={index}
            animate={{ scaleY: [low, high, mid, high * 0.86] }}
            transition={{
              duration,
              repeat: Infinity,
              ease: 'easeInOut',
              delay: col.delay,
            }}
            className="h-6 w-[3px] origin-center rounded-full bg-current"
          />
        )
      })}
    </span>
  )
}

export function DashboardPowerButton({
  status,
  pending,
  telemetry,
  morphProgress,
  onToggle,
  disabled = false,
}: {
  status: ProxyPowerState
  pending: 'start' | 'stop' | undefined
  telemetry?: Pick<ProxyTraffic, 'uploadRate' | 'downloadRate'> & { stale?: boolean }
  morphProgress?: MotionValue<number>
  onToggle: () => void
  disabled?: boolean
}) {
  const [hovered, setHovered] = useState(false)
  const [focusVisible, setFocusVisible] = useState(false)
  const fallbackProgress = useMotionValue(0)
  const progress = morphProgress ?? fallbackProgress
  const reducedMotion = useReducedMotion()

  const haloOpacity = useTransform(progress, [0, 0.52], [1, 0])
  const haloScale = useTransform(progress, [0, 0.52], [1, reducedMotion ? 1 : 0.74])
  const coreOpacity = useTransform(progress, [0, 0.22, 0.5, 0.82, 1], [1, 0.88, 0.5, 0.14, 0])
  const coreY = useTransform(progress, [0, 1], [0, reducedMotion ? 0 : -14])
  const coreScale = useTransform(progress, [0, 0.5, 1], [1, reducedMotion ? 1 : 0.9, reducedMotion ? 1 : 0.78])
  const blobScaleX = useTransform(progress, [0, 0.55, 1], [1, reducedMotion ? 1 : 1.08, reducedMotion ? 1 : 1.18])
  const blobScaleY = useTransform(progress, [0, 0.55, 1], [1, reducedMotion ? 1 : 0.82, reducedMotion ? 1 : 0.62])

  const switching = pending === 'start' || pending === 'stop'
  const phase =
    pending === 'start'
      ? 'starting'
      : pending === 'stop'
        ? 'stopping'
        : status.running
          ? 'running'
          : 'idle'

  const active = phase === 'running' || phase === 'starting'
  const showStop = phase === 'running' && (hovered || focusVisible)

  const totalRate = telemetry && !telemetry.stale ? telemetry.uploadRate + telemetry.downloadRate : 0
  const activityLevel =
    totalRate <= 0 ? 0 : Math.min(1, Math.max(0.18, Math.log10(1 + totalRate / 2048) / 3.5))

  const ariaLabel =
    phase === 'starting'
      ? tr('正在启动代理…')
      : phase === 'stopping'
        ? tr('正在停止代理…')
        : phase === 'running'
          ? telemetry && !telemetry.stale
            ? tr("代理运行中 · ↑{0} ↓{1}（点击停止）", formatCompactRate(telemetry.uploadRate), formatCompactRate(telemetry.downloadRate))
            : tr('代理运行中（点击停止）')
          : tr('启动代理')

  return (
    <div data-proxy-power={proxyPowerTone(status)} className="relative flex w-[104px] shrink-0 items-center justify-center select-none">
      <div className="relative grid size-[76px] place-items-center">
        <motion.div
          className="pointer-events-none absolute inset-0"
          style={morphProgress ? { opacity: haloOpacity, scale: haloScale } : undefined}
        >
        {/* 第 3 层：最外层卡片融合大波浪氛围底板（被卡片 overflow-hidden 柔和裁剪） */}
        <motion.svg
          viewBox="0 0 100 100"
          aria-hidden="true"
          className={cn(
            'pointer-events-none absolute top-1/2 left-[56%] size-[196px] -translate-x-1/2 -translate-y-1/2 transition-colors duration-500',
            active
              ? 'text-[color:var(--proxy-power-color)]/[0.13] dark:text-[color:var(--proxy-power-highlight)]/[0.22]'
              : 'text-[color:var(--proxy-power-color)]/[0.075] dark:text-[color:var(--proxy-power-highlight)]/[0.14]',
          )}
          animate={
            phase === 'starting'
              ? { rotate: 360, scale: [1, 1.06, 1] }
              : phase === 'running'
                ? { rotate: 360, scale: hovered ? 1.05 : [1, 1.03, 1] }
                : { rotate: hovered ? 12 : 0, scale: hovered ? 1.05 : 1 }
          }
          transition={
            phase === 'starting'
              ? {
                  rotate: { duration: 14, ease: 'linear', repeat: Infinity },
                  scale: { duration: 1.6, ease: 'easeInOut', repeat: Infinity },
                }
              : phase === 'running'
                ? {
                    rotate: { duration: 36, ease: 'linear', repeat: Infinity },
                    scale: hovered
                      ? { type: 'spring', stiffness: 320, damping: 24 }
                      : { duration: 4.8, ease: 'easeInOut', repeat: Infinity },
                  }
                : { type: 'spring', stiffness: 220, damping: 24 }
          }
        >
          <path d={BACKDROP_WAVE_PATH} fill="currentColor" />
        </motion.svg>

        {/* 第 2 层：中层同心柔波光环 */}
        <motion.svg
          viewBox="0 0 100 100"
          aria-hidden="true"
          className={cn(
            'pointer-events-none absolute top-1/2 left-1/2 size-[114px] -translate-x-1/2 -translate-y-1/2 transition-colors duration-400',
            active
              ? 'text-[color:var(--proxy-power-color)]/[0.18] dark:text-[color:var(--proxy-power-highlight)]/[0.28]'
              : 'text-[color:var(--proxy-power-color)]/[0.12] dark:text-[color:var(--proxy-power-highlight)]/[0.19]',
          )}
          animate={
            phase === 'starting'
              ? { rotate: -360, scale: [1, 1.12, 1] }
              : phase === 'running'
                ? { rotate: -360, scale: hovered ? 1.09 : [1, 1.06, 1] }
                : { rotate: hovered ? -14 : 0, scale: hovered ? 1.09 : 1 }
          }
          transition={
            phase === 'starting'
              ? {
                  rotate: { duration: 10, ease: 'linear', repeat: Infinity },
                  scale: { duration: 1.1, ease: 'easeInOut', repeat: Infinity },
                }
              : phase === 'running'
                ? {
                    rotate: { duration: 24, ease: 'linear', repeat: Infinity },
                    scale: hovered
                      ? { type: 'spring', stiffness: 340, damping: 24 }
                      : { duration: 3.4 - activityLevel * 0.8, ease: 'easeInOut', repeat: Infinity },
                  }
                : { type: 'spring', stiffness: 280, damping: 22 }
          }
        >
          <path d={MID_WAVE_PATH} fill="currentColor" />
        </motion.svg>

        {/* 第 1 层：近身波浪光晕环 */}
        <motion.svg
          viewBox="0 0 100 100"
          aria-hidden="true"
          className={cn(
            'pointer-events-none absolute top-1/2 left-1/2 size-[90px] -translate-x-1/2 -translate-y-1/2 transition-colors duration-300',
            active
              ? 'text-[color:var(--proxy-power-color)]/[0.26] dark:text-[color:var(--proxy-power-highlight)]/[0.36]'
              : 'text-[color:var(--proxy-power-color)]/[0.18] dark:text-[color:var(--proxy-power-highlight)]/[0.26]',
          )}
          animate={
            phase === 'starting'
              ? { rotate: 360, scale: [1, 1.09, 1] }
              : phase === 'running'
                ? { rotate: 360, scale: hovered ? 1.08 : [1, 1.045, 1] }
                : { rotate: hovered ? 10 : 0, scale: hovered ? 1.08 : 1 }
          }
          transition={
            phase === 'starting'
              ? {
                  rotate: { duration: 6, ease: 'linear', repeat: Infinity },
                  scale: { duration: 0.9, ease: 'easeInOut', repeat: Infinity },
                }
              : phase === 'running'
                ? {
                    rotate: { duration: 18, ease: 'linear', repeat: Infinity },
                    scale: hovered
                      ? { type: 'spring', stiffness: 380, damping: 24 }
                      : { duration: 2.6 - activityLevel * 0.6, ease: 'easeInOut', repeat: Infinity },
                  }
                : { type: 'spring', stiffness: 340, damping: 22 }
          }
        >
          <path d={MID_WAVE_PATH} fill="currentColor" />
        </motion.svg>

        {/* 启动中 / 运行触发：双道同心扩散波纹涟漪 */}
        <AnimatePresence>
          {phase === 'starting' && (
            <>
              {[0, 0.48].map(delay => (
                <motion.svg
                  key={`ripple-${delay}`}
                  viewBox="0 0 100 100"
                  aria-hidden="true"
                  initial={{ scale: 0.82, opacity: 0.6 }}
                  animate={{ scale: 1.72, opacity: 0 }}
                  exit={{ opacity: 0 }}
                  transition={{
                    duration: 1.25,
                    ease: [0.16, 1, 0.3, 1],
                    repeat: Infinity,
                    delay,
                  }}
                  className="pointer-events-none absolute top-1/2 left-1/2 size-[80px] -translate-x-1/2 -translate-y-1/2 text-[color:var(--proxy-power-highlight)]"
                >
                  <path
                    d={CORE_BLOB_PATH}
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.4"
                  />
                </motion.svg>
              ))}
            </>
          )}
        </AnimatePresence>

        </motion.div>

        {/* 核心可点击波浪按钮本体 */}
        <motion.div style={morphProgress ? { opacity: coreOpacity, y: coreY, scale: coreScale } : undefined}>
        <motion.button
          type="button"
          aria-label={ariaLabel}
          title={ariaLabel}
          aria-busy={switching}
          disabled={switching || disabled}
          whileHover={switching ? undefined : { scale: 1.06 }}
          whileTap={switching || disabled ? undefined : { scale: 0.92 }}
          transition={{ type: 'spring', stiffness: 460, damping: 24 }}
          onPointerEnter={event => {
            if (event.pointerType === 'mouse') setHovered(true)
          }}
          onPointerLeave={event => {
            if (event.pointerType === 'mouse') setHovered(false)
          }}
          onFocus={event => setFocusVisible(event.currentTarget.matches(':focus-visible'))}
          onBlur={() => setFocusVisible(false)}
          onClick={onToggle}
          className={cn(
            'relative z-10 grid size-[74px] place-items-center rounded-full text-white outline-none focus-visible:ring-2 focus-visible:ring-ring/70 focus-visible:ring-offset-2 focus-visible:ring-offset-background',
            switching ? 'cursor-wait' : 'cursor-pointer',
          )}
        >
          <motion.div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0"
            style={morphProgress ? { scaleX: blobScaleX, scaleY: blobScaleY } : undefined}
          >
          {/* 10 瓣有机柔波本体 SVG + 内部流光裁剪 */}
          <motion.svg
            viewBox="0 0 100 100"
            aria-hidden="true"
            className={cn(
              'pointer-events-none absolute inset-0 size-full transition-[filter] duration-300',
              active
                ? 'drop-shadow-[0_6px_18px_color-mix(in_srgb,var(--proxy-power-color)_48%,transparent)] dark:drop-shadow-[0_0_22px_color-mix(in_srgb,var(--proxy-power-highlight)_52%,transparent)]'
                : hovered
                  ? 'drop-shadow-[0_8px_20px_color-mix(in_srgb,var(--proxy-power-color)_44%,transparent)]'
                  : 'drop-shadow-[0_5px_14px_color-mix(in_srgb,var(--proxy-power-color)_30%,transparent)]',
            )}
            animate={
              phase === 'starting'
                ? { rotate: 360 }
                : phase === 'running'
                  ? { rotate: 360 }
                  : { rotate: hovered ? 12 : 0 }
            }
            transition={
              phase === 'starting'
                ? { duration: 4.5, ease: 'linear', repeat: Infinity }
                : phase === 'running'
                  ? { duration: 22, ease: 'linear', repeat: Infinity }
                  : { type: 'spring', stiffness: 320, damping: 22 }
            }
          >
            <defs>
              <linearGradient id="dashboard-power-grad" x1="18%" y1="8%" x2="82%" y2="95%">
                <stop offset="0%" stopColor="var(--proxy-power-highlight)" className="transition-[stop-color] duration-400 ease-out" />
                <stop offset="100%" stopColor="var(--proxy-power-depth)" className="transition-[stop-color] duration-400 ease-out" />
              </linearGradient>
              <linearGradient id="dashboard-power-sheen" x1="0%" y1="0%" x2="100%" y2="0%">
                <stop offset="0%" stopColor="#ffffff" stopOpacity="0" />
                <stop offset="50%" stopColor="#ffffff" stopOpacity="0.38" />
                <stop offset="100%" stopColor="#ffffff" stopOpacity="0" />
              </linearGradient>
              <clipPath id="dashboard-power-blob-clip">
                <path d={CORE_BLOB_PATH} />
              </clipPath>
            </defs>

            <path
              d={CORE_BLOB_PATH}
              fill="url(#dashboard-power-grad)"
              stroke="rgba(255,255,255,0.28)"
              strokeWidth="1.2"
            />

            {/* 启动中流光循环扫掠 / 待机悬停一次轻盈光泽掠过 */}
            <g clipPath="url(#dashboard-power-blob-clip)">
              {phase === 'starting' && (
                <motion.rect
                  x="-55"
                  y="-15"
                  width="52"
                  height="130"
                  transform="skewX(-18)"
                  fill="url(#dashboard-power-sheen)"
                  initial={{ x: -55 }}
                  animate={{ x: 145 }}
                  transition={{
                    duration: 0.95,
                    ease: [0.22, 1, 0.36, 1],
                    repeat: Infinity,
                    repeatDelay: 0.25,
                  }}
                />
              )}
              {phase === 'idle' && hovered && (
                <motion.rect
                  key="hover-sheen"
                  x="-55"
                  y="-15"
                  width="46"
                  height="130"
                  transform="skewX(-18)"
                  fill="url(#dashboard-power-sheen)"
                  initial={{ x: -55, opacity: 0.9 }}
                  animate={{ x: 145, opacity: 0 }}
                  transition={{ duration: 0.62, ease: [0.22, 1, 0.36, 1] }}
                />
              )}
            </g>
          </motion.svg>
          </motion.div>

          {/* 居中状态图标层（不随外框旋转） */}
          <AnimatePresence mode="wait" initial={false}>
            {phase === 'starting' ? (
              <motion.span
                key="starting"
                initial={{ opacity: 0, scale: 0.7 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.72 }}
                transition={{ duration: 0.16, ease: 'easeOut' }}
                className="relative z-10 grid place-items-center"
              >
                <PowerOrbitRing duration={0.85} />
              </motion.span>
            ) : phase === 'stopping' ? (
              <motion.span
                key="stopping"
                initial={{ opacity: 0, scale: 0.75 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.65 }}
                transition={{ duration: 0.14 }}
                className="relative z-10 grid place-items-center"
              >
                <PowerOrbitRing duration={0.7} />
              </motion.span>
            ) : phase === 'running' ? (
              <motion.span
                key={showStop ? 'stop' : 'running-wave'}
                initial={{ opacity: 0, scale: 0.78 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.78 }}
                transition={{ duration: 0.14, ease: 'easeOut' }}
                className="relative z-10 grid place-items-center"
              >
                {showStop ? (
                  <Square className="size-6 rounded-[2px] fill-current stroke-[1.8]" />
                ) : (
                  <PowerWaveform level={activityLevel} />
                )}
              </motion.span>
            ) : (
              <motion.span
                key="idle"
                initial={{ opacity: 0, scale: 0.72, rotate: -18 }}
                animate={{
                  opacity: 1,
                  scale: hovered ? 1.1 : 1,
                  x: hovered ? 2.5 : 1.5,
                  rotate: 0,
                }}
                exit={{ opacity: 0, scale: 0.68, rotate: 22 }}
                transition={{ type: 'spring', stiffness: 460, damping: 24 }}
                className="relative z-10 grid place-items-center"
              >
                <Play className="size-7 fill-current" />
              </motion.span>
            )}
          </AnimatePresence>
        </motion.button>
        </motion.div>
      </div>
    </div>
  )
}
