import { useEffect, useRef } from 'react'
import { cn } from '@/shared/lib/utils'

export type TraceLinesVariant = 'nodes' | 'dashboard' | 'subscriptions' | 'connections' | 'settings'

type CurveDef = {
  tone: 'blue' | 'green'
  dashed?: boolean
  start: readonly [number, number]
  first: readonly [number, number, number, number, number, number]
  last: readonly [number, number, number, number, number, number]
}

type DotDef = {
  x: number
  y: number
  tone: 'primary' | 'success'
  ring?: boolean
}

const VARIANTS: Record<TraceLinesVariant, { paths: readonly CurveDef[]; dots: readonly DotDef[] }> = {
  nodes: {
    paths: [
      { tone: 'blue', start: [5, 35], first: [91, 8, 152, 33, 207, 10], last: [218, 7, 226, 6, 231, 6] },
      { tone: 'blue', start: [29, 33], first: [71, 25, 77, -3, 121, 11], last: [183, 29, 175, 20, 231, 10] },
      { tone: 'green', start: [18, 41], first: [56, 38, 96, 15, 142, 31], last: [176, 43, 203, 24, 231, 24] },
    ],
    dots: [
      { x: 5, y: 35, tone: 'success' },
      { x: 84, y: 14, tone: 'primary' },
      { x: 166, y: 36, tone: 'success' },
      { x: 231, y: 10, tone: 'primary' },
    ],
  },
  dashboard: {
    paths: [
      { tone: 'blue', start: [6, 33], first: [48, 8, 98, 36, 148, 14], last: [182, 2, 206, 22, 231, 11] },
      { tone: 'green', start: [14, 38], first: [62, 28, 104, 8, 156, 28], last: [188, 38, 210, 18, 231, 22] },
      { tone: 'blue', dashed: true, start: [24, 22], first: [74, 34, 118, 12, 168, 20], last: [196, 25, 214, 14, 231, 16] },
    ],
    dots: [
      { x: 6, y: 33, tone: 'success' },
      { x: 62, y: 19, tone: 'primary', ring: true },
      { x: 126, y: 19, tone: 'success' },
      { x: 178, y: 11, tone: 'primary', ring: true },
      { x: 231, y: 11, tone: 'success' },
    ],
  },
  subscriptions: {
    paths: [
      { tone: 'blue', start: [6, 11], first: [54, 11, 88, 24, 134, 22], last: [174, 20, 202, 14, 231, 14] },
      { tone: 'green', start: [16, 26], first: [64, 26, 98, 16, 142, 22], last: [178, 26, 204, 18, 231, 18] },
      { tone: 'blue', start: [8, 39], first: [58, 39, 96, 24, 138, 22], last: [176, 20, 204, 23, 231, 23] },
    ],
    dots: [
      { x: 6, y: 11, tone: 'primary' },
      { x: 16, y: 26, tone: 'success' },
      { x: 8, y: 39, tone: 'primary' },
      { x: 136, y: 22, tone: 'primary', ring: true },
      { x: 231, y: 18, tone: 'success' },
    ],
  },
  connections: {
    paths: [
      { tone: 'blue', start: [6, 34], first: [36, 10, 62, 10, 86, 26], last: [118, 42, 168, 6, 231, 14] },
      { tone: 'green', start: [18, 38], first: [64, 36, 102, 12, 148, 24], last: [182, 33, 206, 24, 231, 26] },
      { tone: 'blue', dashed: true, start: [8, 22], first: [56, 28, 112, 34, 162, 16], last: [192, 8, 212, 12, 231, 14] },
    ],
    dots: [
      { x: 6, y: 34, tone: 'success' },
      { x: 58, y: 14, tone: 'primary', ring: true },
      { x: 124, y: 24, tone: 'success' },
      { x: 184, y: 14, tone: 'primary', ring: true },
      { x: 231, y: 14, tone: 'primary' },
    ],
  },
  settings: {
    paths: [
      { tone: 'blue', start: [6, 15], first: [64, 15, 108, 27, 164, 17], last: [194, 12, 212, 14, 231, 14] },
      { tone: 'green', start: [14, 26], first: [72, 20, 124, 34, 176, 24], last: [202, 19, 216, 23, 231, 23] },
      { tone: 'blue', start: [6, 36], first: [66, 36, 116, 20, 172, 32], last: [198, 37, 214, 33, 231, 33] },
    ],
    dots: [
      { x: 56, y: 17, tone: 'primary', ring: true },
      { x: 128, y: 27, tone: 'success', ring: true },
      { x: 194, y: 14, tone: 'primary' },
    ],
  },
}

export function TraceLines({
  variant = 'nodes',
  className,
}: {
  variant?: TraceLinesVariant
  className?: string
}) {
  const canvas = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const element = canvas.current
    const context = element?.getContext('2d')
    if (!element || !context) return

    function draw() {
      if (!context || !element) return
      const style = getComputedStyle(element)
      const blue = style.getPropertyValue('--trace-blue').trim() || '#9cb5ec'
      const green = style.getPropertyValue('--trace-green').trim() || '#96c7b8'
      const primary = style.getPropertyValue('--primary').trim() || '#2956d4'
      const success = style.getPropertyValue('--success').trim() || '#0d7a52'

      context.setTransform(2, 0, 0, 2, 0, 0)
      context.clearRect(0, 0, 235, 44)
      context.lineCap = 'round'

      const config = VARIANTS[variant]

      for (const { tone, dashed, start, first, last } of config.paths) {
        context.beginPath()
        context.strokeStyle = tone === 'blue' ? blue : green
        context.lineWidth = 1
        context.setLineDash(dashed ? [3, 3.5] : [])
        context.moveTo(start[0], start[1])
        context.bezierCurveTo(first[0], first[1], first[2], first[3], first[4], first[5])
        context.bezierCurveTo(last[0], last[1], last[2], last[3], last[4], last[5])
        context.stroke()
      }
      context.setLineDash([])

      for (const { x, y, tone, ring } of config.dots) {
        const color = tone === 'primary' ? primary : success
        context.beginPath()
        context.fillStyle = color
        context.globalAlpha = 0.24
        context.arc(x, y, ring ? 5 : 4.2, 0, Math.PI * 2)
        context.fill()

        if (ring) {
          context.beginPath()
          context.strokeStyle = color
          context.lineWidth = 0.8
          context.globalAlpha = 0.4
          context.arc(x, y, 5, 0, Math.PI * 2)
          context.stroke()
        }

        context.beginPath()
        context.fillStyle = color
        context.globalAlpha = 0.88
        context.arc(x, y, 2, 0, Math.PI * 2)
        context.fill()
      }
      context.globalAlpha = 1
    }

    draw()
    const observer = new MutationObserver(draw)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class'] })
    return () => observer.disconnect()
  }, [variant])

  return (
    <canvas
      ref={canvas}
      className={cn('hidden h-11 w-[235px] shrink-0 sm:block', className)}
      width="470"
      height="88"
      aria-hidden="true"
    />
  )
}
