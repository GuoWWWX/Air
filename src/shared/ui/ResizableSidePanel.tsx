import { preferences } from '@/shared/lib/preferences'
import { tr } from '@/shared/i18n/messages'
import { motion } from 'motion/react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { cn } from '@/shared/lib/utils'

function clamp(width: number, minWidth: number, max: number) {
  return Math.round(Math.max(minWidth, Math.min(max, width)))
}

export interface ResizableSidePanelProps {
  storageKey: string
  defaultWidth: number
  minWidth: number
  maxWidth: number
  reservedRightWidth?: number
  ariaLabel: string
  animated?: boolean
  responsiveDesktopOnly?: boolean
  className?: string
  children: ReactNode
}

export function ResizableSidePanel({
  storageKey,
  defaultWidth,
  minWidth,
  maxWidth,
  reservedRightWidth = 280,
  ariaLabel,
  animated = true,
  responsiveDesktopOnly = false,
  className,
  children,
}: ResizableSidePanelProps) {
  const panel = useRef<HTMLDivElement>(null)
  const drag = useRef<{ x: number; width: number; latest: number } | null>(null)
  const [dragging, setDragging] = useState(false)
  const [contentWidth, setContentWidth] = useState(Infinity)
  const [desktop, setDesktop] = useState(() =>
    !responsiveDesktopOnly || window.matchMedia('(min-width: 1024px)').matches,
  )
  const [preferred, setPreferred] = useState(() => {
    const saved = Number(preferences.getItem(storageKey))
    return Number.isFinite(saved) && saved >= minWidth ? clamp(saved, minWidth, maxWidth) : defaultWidth
  })

  const boundedMax = clamp(contentWidth - reservedRightWidth, minWidth, maxWidth)
  const width = clamp(preferred, minWidth, boundedMax)
  const resizable = !responsiveDesktopOnly || desktop

  useEffect(() => {
    if (!responsiveDesktopOnly) {
      setDesktop(true)
      return
    }
    const query = window.matchMedia('(min-width: 1024px)')
    const sync = () => {
      setDesktop(query.matches)
      if (!query.matches && drag.current) {
        drag.current = null
        setDragging(false)
        document.body.style.cursor = ''
      }
    }
    sync()
    query.addEventListener('change', sync)
    return () => query.removeEventListener('change', sync)
  }, [responsiveDesktopOnly])

  useEffect(() => {
    const container = panel.current?.parentElement
    if (!container) return
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setContentWidth(entry.contentRect.width)
    })
    observer.observe(container)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    return () => {
      document.body.style.cursor = ''
    }
  }, [])

  function apply(next: number) {
    const resized = clamp(next, minWidth, boundedMax)
    setPreferred(resized)
    preferences.setItem(storageKey, String(resized))
  }

  const separator = resizable ? (
    <div
      role="separator"
      aria-label={ariaLabel}
      aria-orientation="vertical"
      aria-valuemin={minWidth}
      aria-valuemax={boundedMax}
      aria-valuenow={width}
      tabIndex={0}
      onPointerDown={event => {
        if (event.button !== 0) return
        event.currentTarget.setPointerCapture(event.pointerId)
        drag.current = { x: event.clientX, width, latest: width }
        setDragging(true)
        document.body.style.cursor = 'ew-resize'
        event.preventDefault()
        event.currentTarget.focus()
      }}
      onPointerMove={event => {
        if (drag.current) {
          drag.current.latest = clamp(drag.current.width + event.clientX - drag.current.x, minWidth, boundedMax)
          setPreferred(drag.current.latest)
        }
      }}
      onLostPointerCapture={() => {
        if (drag.current) apply(drag.current.latest)
        drag.current = null
        setDragging(false)
        document.body.style.cursor = ''
      }}
      onDoubleClick={() => apply(defaultWidth)}
      onKeyDown={event => {
        const step = event.shiftKey ? 40 : 12
        const widths: Record<string, number> = {
          ArrowLeft: width - step,
          ArrowRight: width + step,
          Home: minWidth,
          End: boundedMax,
        }
        const next = widths[event.key]
        if (next === undefined) return
        event.preventDefault()
        apply(next)
      }}
      className="group/resizer absolute inset-y-1 -right-3 z-10 grid w-3 cursor-ew-resize touch-none place-items-center outline-none"
      title={tr("拖动调整宽度，双击恢复默认")}
    >
      <span
        aria-hidden="true"
        className={cn(
          'rounded-full transition-[height,width,background-color] duration-150',
          dragging
            ? 'h-9 w-[2px] bg-primary'
            : 'h-6 w-px bg-border group-hover/resizer:h-9 group-hover/resizer:w-[2px] group-hover/resizer:bg-primary/80 group-focus-visible/resizer:h-9 group-focus-visible/resizer:w-[2px] group-focus-visible/resizer:bg-primary',
        )}
      />
    </div>
  ) : null

  const rootClassName = cn('relative min-h-0 shrink-0', !resizable && 'w-full', className)
  const rootStyle = resizable ? { width } : undefined

  if (animated) {
    return (
      <motion.div
        ref={panel}
        initial={{ opacity: 0, x: -8 }}
        animate={{ opacity: 1, x: 0 }}
        exit={{ opacity: 0, width: 0, x: -8 }}
        transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
        className={rootClassName}
        style={rootStyle}
      >
        {children}
        {separator}
      </motion.div>
    )
  }

  return (
    <div ref={panel} className={rootClassName} style={rootStyle}>
      {children}
      {separator}
    </div>
  )
}
