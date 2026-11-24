import { useId } from 'react'
import { cn } from '@/shared/lib/utils'
import './spinning-globe.css'

const MERIDIAN_ARC = 'M12 2 A9.6 10 0 0 1 12 22'
const MERIDIAN_LAYERS = ['air-globe-meridian-1', 'air-globe-meridian-2', 'air-globe-meridian-3'] as const

/**
 * 渲染出口 IP 检测按钮地球图标；检测中保持空心线框并沿中心轴水平自转。
 */
export function SpinningGlobeIcon({
  spinning = false,
  className,
}: {
  spinning?: boolean
  className?: string
}) {
  const uid = useId().replace(/:/g, '')
  const clipId = `air-globe-clip-${uid}`

  if (!spinning) {
    return (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        data-globe-spinning="false"
        className={cn('shrink-0', className)}
      >
        <circle cx="12" cy="12" r="10" />
        <path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20" />
        <path d="M2 12h20" />
      </svg>
    )
  }

  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      data-globe-spinning="true"
      className={cn('shrink-0', className)}
    >
      <defs>
        <clipPath id={clipId}>
          <circle cx="12" cy="12" r="9.6" />
        </clipPath>
      </defs>

      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" />
      <g clipPath={`url(#${clipId})`}>
        <path d="M2 12h20" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        {MERIDIAN_LAYERS.map(layerClass => (
          <path
            key={layerClass}
            d={MERIDIAN_ARC}
            fill="none"
            stroke="currentColor"
            strokeWidth="1.3"
            vectorEffect="non-scaling-stroke"
            className={`air-globe-meridian ${layerClass}`}
          />
        ))}
      </g>
    </svg>
  )
}
