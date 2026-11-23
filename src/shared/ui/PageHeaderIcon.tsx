import {
  CloudDownload,
  FileCode2,
  Globe,
  Info,
  Network,
  Palette,
  Plug,
  Settings,
  Waypoints,
  type LucideIcon,
} from 'lucide-react'
import { motion, type TargetAndTransition, type Transition } from 'motion/react'
import { cn } from '@/shared/lib/utils'

export type PageIconKind =
  | 'home'
  | 'nodes'
  | 'subscriptions'
  | 'connections'
  | 'settings'
  | 'theme'
  | 'dns'
  | 'tun'
  | 'inbound'
  | 'routing'
  | 'kernel'
  | 'configFile'
  | 'monitoring'
  | 'about'
  | 'yaml'
  | 'import'
  | 'content'

interface IconPreset {
  icon: LucideIcon
  animate: TargetAndTransition
  transition: Transition
}

interface CustomIconProps {
  className?: string
  size?: number
  strokeWidth?: number
  animate?: boolean
  delay?: number
}

const EASE_OUT = [0.22, 1, 0.36, 1] as const

const ACTIVITY_PATH =
  'M2 12h2.49a2 2 0 0 0 1.92-1.46l2.35-8.36a.25.25 0 0 1 .48 0l5.52 19.64a.25.25 0 0 0 .48 0l2.35-8.36A2 2 0 0 1 19.52 12H22'

const DASHBOARD_BLOCKS = [
  { width: 7, height: 9, x: 3, y: 3, rx: 1, dx: -0.7, dy: -0.7 },
  { width: 7, height: 5, x: 14, y: 3, rx: 1, dx: 0.7, dy: -0.7 },
  { width: 7, height: 9, x: 14, y: 12, rx: 1, dx: 0.7, dy: 0.7 },
  { width: 7, height: 5, x: 3, y: 16, rx: 1, dx: -0.7, dy: 0.7 },
] as const

/**
 * 连接日志 / 心电心跳图标：从左到右绘制并伴随横向移动的高亮心电脉冲。
 */
export function HeartbeatIcon({
  className,
  size,
  strokeWidth = 2,
  animate = true,
  delay = 0,
}: CustomIconProps) {
  const dimensionProps = size !== undefined ? { width: size, height: size } : {}

  return (
    <svg
      {...dimensionProps}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      {animate ? (
        <>
          <path d={ACTIVITY_PATH} opacity={0.22} />
          <motion.path
            d={ACTIVITY_PATH}
            initial={{ pathLength: 0 }}
            animate={{ pathLength: 1 }}
            transition={{ duration: 0.56, delay, ease: EASE_OUT }}
          />
          <motion.path
            d={ACTIVITY_PATH}
            strokeWidth={strokeWidth + 0.5}
            initial={{ pathLength: 0.01, pathOffset: 0, opacity: 0 }}
            animate={{
              pathLength: [0.01, 0.28, 0.26, 0.01],
              pathOffset: [0, 0.14, 0.72, 1],
              opacity: [0, 1, 0.95, 0],
            }}
            transition={{ duration: 0.58, delay, ease: [0.25, 0.8, 0.35, 1] }}
          />
        </>
      ) : (
        <path d={ACTIVITY_PATH} />
      )}
    </svg>
  )
}

/**
 * 仪表盘四方块图标：初始实心填充主题色，随后顺时针错峰褪色为空心线框并微弹归位。
 */
export function DashboardBlocksIcon({
  className,
  size,
  strokeWidth = 2,
  animate = true,
  delay = 0,
}: CustomIconProps) {
  const dimensionProps = size !== undefined ? { width: size, height: size } : {}

  return (
    <svg
      {...dimensionProps}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      {DASHBOARD_BLOCKS.map((block, index) => {
        if (!animate) {
          return (
            <rect
              key={`${block.x}:${block.y}`}
              width={block.width}
              height={block.height}
              x={block.x}
              y={block.y}
              rx={block.rx}
              fill="none"
            />
          )
        }

        const blockDelay = delay + index * 0.055
        return (
          <motion.rect
            key={`${block.x}:${block.y}`}
            width={block.width}
            height={block.height}
            x={block.x}
            y={block.y}
            rx={block.rx}
            fill="currentColor"
            stroke="currentColor"
            style={{ transformBox: 'fill-box', transformOrigin: 'center' }}
            initial={{ fillOpacity: 0.92, scale: 0.88, x: block.dx, y: block.dy }}
            animate={{
              fillOpacity: [0.92, 0.92, 0],
              scale: [0.88, 1.12, 0.97, 1],
              x: [block.dx, -block.dx * 0.45, 0],
              y: [block.dy, -block.dy * 0.45, 0],
            }}
            transition={{
              fillOpacity: { duration: 0.58, delay: blockDelay, times: [0, 0.34, 1], ease: EASE_OUT },
              scale: { duration: 0.52, delay: blockDelay, ease: EASE_OUT },
              x: { duration: 0.5, delay: blockDelay, ease: EASE_OUT },
              y: { duration: 0.5, delay: blockDelay, ease: EASE_OUT },
            }}
          />
        )
      })}
    </svg>
  )
}

const networkPreset: IconPreset = {
  icon: Network,
  animate: { scale: [0.85, 1.14, 1], rotate: [-12, 10, 0] },
  transition: { duration: 0.46, ease: EASE_OUT },
}

const downloadPreset: IconPreset = {
  icon: CloudDownload,
  animate: { y: [-3, 3.5, -0.5, 0], scale: [0.9, 1.08, 1] },
  transition: { duration: 0.46, ease: EASE_OUT },
}

const gearPreset: IconPreset = {
  icon: Settings,
  animate: { rotate: [-120, 10, 0], scale: [0.88, 1.08, 1] },
  transition: { duration: 0.62, ease: EASE_OUT },
}

const docPreset: IconPreset = {
  icon: FileCode2,
  animate: { y: [3, -2, 0], scale: [0.88, 1.1, 1] },
  transition: { duration: 0.44, ease: EASE_OUT },
}

const ICON_PRESETS: Record<Exclude<PageIconKind, 'home' | 'connections' | 'monitoring'>, IconPreset> = {
  nodes: networkPreset,
  tun: networkPreset,
  content: networkPreset,
  subscriptions: downloadPreset,
  import: downloadPreset,
  settings: gearPreset,
  kernel: gearPreset,
  theme: {
    icon: Palette,
    animate: { rotate: [-14, 10, -4, 0], scale: [0.88, 1.1, 1] },
    transition: { duration: 0.48, ease: EASE_OUT },
  },
  dns: {
    icon: Globe,
    animate: { rotate: [-22, 6, 0], scale: [0.86, 1.12, 1] },
    transition: { duration: 0.48, ease: EASE_OUT },
  },
  inbound: {
    icon: Plug,
    animate: { x: [-3, 2, 0], y: [2, -1.5, 0], scale: [0.88, 1.1, 1] },
    transition: { duration: 0.44, ease: EASE_OUT },
  },
  routing: {
    icon: Waypoints,
    animate: { scale: [0.85, 1.14, 1], rotate: [-10, 6, 0] },
    transition: { duration: 0.46, ease: EASE_OUT },
  },
  configFile: docPreset,
  yaml: docPreset,
  about: {
    icon: Info,
    animate: { scale: [0.82, 1.16, 0.96, 1] },
    transition: { duration: 0.44, ease: EASE_OUT },
  },
}

const SIZE_CLASSES = {
  desktop: { box: 'size-9 rounded-[10px]', icon: 'size-[18px] stroke-[2]' },
  subpage: { box: 'size-8.5 rounded-[9px]', icon: 'size-[17px] stroke-[2]' },
  mobile: { box: 'size-8 rounded-[9px]', icon: 'size-[17px] stroke-[2]' },
} as const

/**
 * 渲染带主题柔光徽章容器与页面专属切页入场微动效的顶部标题图标。
 */
export function PageHeaderIcon({
  kind,
  size = 'desktop',
  animateKey,
  className,
}: {
  kind: PageIconKind
  size?: 'desktop' | 'subpage' | 'mobile'
  animateKey?: string | number
  className?: string
}) {
  const styles = SIZE_CLASSES[size]
  // 结合 kind 与切页触发键作为 key，确保通过 <Activity> 复用或同类切换时也能重播动画。
  const triggerKey = `${kind}:${animateKey ?? 0}`
  const iconDelay = size === 'mobile' ? 0.03 : 0.06

  let glyph
  if (kind === 'home') {
    glyph = <DashboardBlocksIcon className={styles.icon} strokeWidth={2} delay={iconDelay} />
  } else if (kind === 'connections' || kind === 'monitoring') {
    glyph = <HeartbeatIcon className={styles.icon} strokeWidth={2} delay={iconDelay} />
  } else {
    const preset = ICON_PRESETS[kind]
    const Icon = preset.icon
    glyph = (
      <motion.span
        className="grid place-items-center"
        animate={preset.animate}
        transition={{ ...preset.transition, delay: iconDelay }}
      >
        <Icon className={styles.icon} />
      </motion.span>
    )
  }

  return (
    <motion.span
      key={triggerKey}
      aria-hidden="true"
      initial={{ scale: 0.9, opacity: 0.72 }}
      animate={{ scale: 1, opacity: 1 }}
      transition={{ type: 'spring', stiffness: 460, damping: 28 }}
      className={cn(
        'relative grid shrink-0 place-items-center border border-accent-border/60 bg-accent-soft/85 text-primary shadow-[inset_0_1px_0_rgba(255,255,255,0.7)] dark:border-accent-border/75 dark:bg-accent-soft/90 dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]',
        styles.box,
        className,
      )}
    >
      {glyph}
    </motion.span>
  )
}
