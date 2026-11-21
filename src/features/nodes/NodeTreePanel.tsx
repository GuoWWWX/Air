import { motion } from 'motion/react'
import { useEffect, useRef, useState, type ReactNode } from 'react'

const storageKey = 'air.nodeTreeWidth'
const defaultWidth = 204
const minimum = 178
const maximum = 380

function clamp(width: number, max: number) {
  return Math.round(Math.max(minimum, Math.min(max, width)))
}

export function NodeTreePanel({
  hasInspector,
  children,
}: {
  hasInspector: boolean
  children: ReactNode
}) {
  const panel = useRef<HTMLDivElement>(null)
  const drag = useRef<{ x: number; width: number; latest: number }>(null)
  const [contentWidth, setContentWidth] = useState(Infinity)
  const [preferred, setPreferred] = useState(() => {
    const saved = Number(localStorage.getItem(storageKey))
    return Number.isFinite(saved) && saved >= minimum ? clamp(saved, maximum) : defaultWidth
  })
  const maxWidth = clamp(contentWidth - (hasInspector ? 344 + 24 : 12) - 280, maximum)
  const width = clamp(preferred, maxWidth)

  useEffect(() => {
    const container = panel.current?.parentElement
    if (!container) return
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setContentWidth(entry.contentRect.width)
    })
    observer.observe(container)
    return () => observer.disconnect()
  }, [])

  function apply(next: number) {
    const resized = clamp(next, maxWidth)
    setPreferred(resized)
    localStorage.setItem(storageKey, String(resized))
  }

  return (
    <motion.div
      ref={panel}
      initial={{ opacity: 0, x: -8 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, width: 0, x: -8 }}
      transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
      className="relative min-h-0 shrink-0"
      style={{ width }}
    >
      {children}
      <div
        role="separator"
        aria-label="调整分组栏宽度"
        aria-orientation="vertical"
        aria-valuemin={minimum}
        aria-valuemax={maxWidth}
        aria-valuenow={width}
        tabIndex={0}
        onPointerDown={event => {
          if (event.button !== 0) return
          event.currentTarget.setPointerCapture(event.pointerId)
          drag.current = { x: event.clientX, width, latest: width }
          event.preventDefault()
          event.currentTarget.focus()
        }}
        onPointerMove={event => {
          if (drag.current) {
            drag.current.latest = clamp(drag.current.width + event.clientX - drag.current.x, maxWidth)
            setPreferred(drag.current.latest)
          }
        }}
        onLostPointerCapture={() => {
          if (drag.current) apply(drag.current.latest)
          drag.current = null
        }}
        onDoubleClick={() => apply(defaultWidth)}
        onKeyDown={event => {
          const step = event.shiftKey ? 40 : 12
          const widths: Record<string, number> = {
            ArrowLeft: width - step,
            ArrowRight: width + step,
            Home: minimum,
            End: maxWidth,
          }
          const next = widths[event.key]
          if (next === undefined) return
          event.preventDefault()
          apply(next)
        }}
        className="absolute inset-y-1 -right-2.5 z-10 grid w-3 cursor-col-resize touch-none place-items-center rounded-sm outline-none hover:bg-accent-soft/60 focus-visible:bg-accent-soft focus-visible:ring-1 focus-visible:ring-ring/60 active:bg-accent-soft"
        title="拖动调整宽度，双击恢复默认"
      >
        <span aria-hidden="true" className="h-6 w-px bg-border" />
      </div>
    </motion.div>
  )
}
