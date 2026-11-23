import { tr } from '@/shared/i18n/messages'
import { ChevronDown, CircleAlert, CircleCheck, Info, TriangleAlert, X } from 'lucide-react'
import {
  AnimatePresence,
  animate,
  motion,
  useMotionValue,
  useTransform,
  type Transition,
} from 'motion/react'
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import { createPortal } from 'react-dom'

const icons = { success: CircleCheck, warning: TriangleAlert, error: CircleAlert, info: Info }

interface Message {
  id: string
  type: keyof typeof icons
  title: string
  description?: string
}

interface ExitVector {
  x: number
  y: number
  rotate: number
}

let messages: Message[] = []
const listeners = new Set<() => void>()
const exitVectors = new Map<string, ExitVector>()

function publish(next: Message[]) {
  messages = next
  listeners.forEach(listener => listener())
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

const snapshot = () => messages

export function showMessage(input: Omit<Message, 'id'> & { id?: string }) {
  const item = { ...input, id: input.id ?? crypto.randomUUID() }
  exitVectors.delete(item.id)
  publish([item, ...messages.filter(previous => previous.id !== item.id)].slice(0, 5))
}

function dismiss(id: string, vector?: ExitVector) {
  if (vector) {
    exitVectors.set(id, vector)
    window.setTimeout(() => {
      if (exitVectors.get(id) === vector) exitVectors.delete(id)
    }, 600)
  } else {
    exitVectors.delete(id)
  }
  publish(messages.filter(item => item.id !== id))
}

const ENTER_SPRING: Transition = { type: 'spring', stiffness: 450, damping: 25, mass: 0.72 }
const BOUNCE_SPRING: Transition = { type: 'spring', stiffness: 480, damping: 16, mass: 0.62 }
const RESET_SPRING = { type: 'spring' as const, stiffness: 520, damping: 22, mass: 0.65 }

function rubberBand(delta: number, limit = 24) {
  const sign = delta < 0 ? -1 : 1
  return sign * limit * (1 - Math.exp(-Math.abs(delta) / 90))
}

const slotVariants = {
  initial: { opacity: 0, y: -40, scale: 0.95 },
  animate: ({ stacked, index }: { stacked: boolean; index: number }) => {
    const depth = Math.min(index, 2)
    return {
      opacity: stacked ? (index > 2 ? 0 : Math.max(0.56, 1 - depth * 0.22)) : 1,
      y: stacked ? depth * 7 : 0,
      scale: stacked ? 1 - depth * 0.045 : 1,
      transition: ENTER_SPRING,
    }
  },
  exit: ({ id }: { id: string }) => {
    const vector = exitVectors.get(id)
    if (vector) {
      return {
        opacity: 0,
        x: vector.x,
        y: vector.y,
        rotate: vector.rotate,
        scale: 0.94,
        transition: { duration: 0.2, ease: [0.32, 0.72, 0, 1] as const },
      }
    }
    return {
      opacity: 0,
      transition: { duration: 0.22, ease: 'easeOut' as const },
    }
  },
}

function MessageRow({
  item,
  index,
  expanded,
  widened,
  hasStack,
  paused,
  mobile,
  onDraggingChange,
  onToggleExpand,
  onFrontHeight,
}: {
  item: Message
  index: number
  expanded: boolean
  widened: boolean
  hasStack: boolean
  paused: boolean
  mobile: boolean
  onDraggingChange: (dragging: boolean) => void
  onToggleExpand: (hasDetails: boolean) => void
  onFrontHeight?: (height: number) => void
}) {
  const Icon = icons[item.type]
  const stacked = index > 0 && !expanded
  const remaining = useRef(0)
  const cardRef = useRef<HTMLDivElement>(null)
  const titleRef = useRef<HTMLSpanElement>(null)
  const suppressClickRef = useRef(false)
  const [dragging, setDragging] = useState(false)
  const [overflowing, setOverflowing] = useState(false)

  const dragX = useMotionValue(0)
  const dragY = useMotionValue(0)
  const dragRotate = useTransform(dragX, [-220, 0, 220], [-6, 0, 6])
  const dragOpacity = useTransform([dragX, dragY], ([x, y]: number[]) => {
    const distance = Math.hypot(x, Math.min(0, y) * 1.45)
    return Math.max(0.28, 1 - distance / 230)
  })

  const dragState = useRef<{
    pointerId: number
    pointerType: string
    startX: number
    startY: number
    lastX: number
    lastY: number
    lastTime: number
    vx: number
    vy: number
    active: boolean
  } | null>(null)

  useEffect(() => {
    remaining.current = item.type === 'error' ? 6000 : item.type === 'warning' ? 4000 : 2800
  }, [item])

  useLayoutEffect(() => {
    if (widened || stacked) return
    const el = titleRef.current
    if (!el) return
    const check = () => {
      setOverflowing(el.scrollWidth > el.clientWidth + 1)
    }
    check()
    const observer = new ResizeObserver(check)
    observer.observe(el)
    return () => observer.disconnect()
  }, [widened, stacked, item.title])

  const hasDetails = Boolean(item.description?.trim()) || item.title.includes('\n') || overflowing
  const canInteractClick = hasDetails || hasStack || widened

  useEffect(() => {
    if (paused || dragging) return
    const started = performance.now()
    const timer = window.setTimeout(() => dismiss(item.id), Math.max(200, remaining.current))
    return () => {
      window.clearTimeout(timer)
      remaining.current -= performance.now() - started
    }
  }, [item, paused, dragging])

  useEffect(() => () => {
    if (dragState.current) onDraggingChange(false)
  }, [onDraggingChange])

  useEffect(() => {
    if (index !== 0 || !onFrontHeight) return
    const node = cardRef.current
    if (!node) return
    const report = () => onFrontHeight(node.offsetHeight)
    report()
    const observer = new ResizeObserver(report)
    observer.observe(node)
    return () => observer.disconnect()
  }, [index, onFrontHeight, item.title, item.description])

  function handlePointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (stacked) return
    if (event.pointerType === 'mouse' && event.button !== 0) return
    const target = event.target as HTMLElement | null
    if (target?.closest('.air-message-close')) return
    if (widened) {
      const text = event.currentTarget.querySelector('.air-message-text')
      if (text && text.contains(target) && text.scrollHeight > text.clientHeight + 2) {
        if (event.pointerType !== 'mouse') return
        const rect = text.getBoundingClientRect()
        if (event.clientX >= rect.right - 14) return
      }
    }

    try {
      event.currentTarget.setPointerCapture(event.pointerId)
    } catch {}
    const now = performance.now()
    dragState.current = {
      pointerId: event.pointerId,
      pointerType: event.pointerType,
      startX: event.clientX,
      startY: event.clientY,
      lastX: event.clientX,
      lastY: event.clientY,
      lastTime: now,
      vx: 0,
      vy: 0,
      active: false,
    }
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const state = dragState.current
    if (!state || state.pointerId !== event.pointerId) return

    const rawDx = event.clientX - state.startX
    const rawDy = event.clientY - state.startY
    const now = performance.now()
    const dxStep = event.clientX - state.lastX
    const dyStep = event.clientY - state.lastY
    const dt = now - state.lastTime
    if (dt >= 4 || Math.hypot(dxStep, dyStep) >= 1) {
      const safeDt = Math.max(1, dt)
      const instVx = dxStep / safeDt
      const instVy = dyStep / safeDt
      state.vx = state.active ? state.vx * 0.35 + instVx * 0.65 : instVx
      state.vy = state.active ? state.vy * 0.35 + instVy * 0.65 : instVy
      state.lastX = event.clientX
      state.lastY = event.clientY
      state.lastTime = now
    }

    const threshold = state.pointerType === 'touch' ? 8 : 5
    if (!state.active) {
      if (Math.hypot(rawDx, rawDy) < threshold) return
      state.active = true
      setDragging(true)
      onDraggingChange(true)
    }

    // 触摸与鼠标均支持向左、向右、向上自由跟手滑动关闭，向下保留轻柔阻尼回弹
    dragX.set(rawDx)
    dragY.set(rawDy <= 0 ? rawDy : rubberBand(rawDy, 16))
  }

  function finishDrag(event: ReactPointerEvent<HTMLDivElement>, cancelled = false) {
    const state = dragState.current
    if (!state || state.pointerId !== event.pointerId) return
    dragState.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      try {
        event.currentTarget.releasePointerCapture(event.pointerId)
      } catch {}
    }

    if (state.active) {
      setDragging(false)
      onDraggingChange(false)
      suppressClickRef.current = true
      window.setTimeout(() => { suppressClickRef.current = false }, 80)
    }

    const rawDx = event.clientX - state.startX
    const rawDy = event.clientY - state.startY
    const { vx, vy, pointerType } = state
    const isTouch = mobile || pointerType === 'touch'

    if (!cancelled && state.active) {
      const horizontalDist = isTouch ? 56 : 68
      const verticalDist = isTouch ? 30 : 34
      const swipeRight = rawDx > horizontalDist || (rawDx > 20 && vx > 0.3)
      const swipeLeft = rawDx < -horizontalDist || (rawDx < -20 && vx < -0.3)
      const swipeUp = rawDy < -verticalDist || (rawDy < -12 && vy < -0.26)

      if ((swipeRight || swipeLeft) && (!swipeUp || Math.abs(rawDx) >= Math.abs(rawDy))) {
        const dir = swipeRight ? 1 : -1
        dismiss(item.id, { x: dir * 280, y: Math.min(0, rawDy) * 0.4, rotate: dir * 8 })
        return
      }
      if (swipeUp) {
        dismiss(item.id, { x: rawDx * 0.35, y: -110, rotate: 0 })
        return
      }
    }

    animate(dragX, 0, RESET_SPRING)
    animate(dragY, 0, RESET_SPRING)
  }

  return (
    <motion.div
      layout="position"
      className="air-message-slot"
      data-stacked={stacked || undefined}
      style={{ '--message-index': index, zIndex: 20 - index } as CSSProperties}
      custom={{ id: item.id, stacked, index }}
      variants={slotVariants}
      initial="initial"
      animate="animate"
      exit="exit"
    >
      <motion.div
        ref={cardRef}
        className="air-message"
        data-type={item.type}
        data-dragging={dragging || undefined}
        data-widened={widened || undefined}
        data-expandable={canInteractClick || undefined}
        aria-expanded={hasDetails ? widened : undefined}
        aria-hidden={stacked || undefined}
        style={{ x: dragX, y: dragY, rotate: dragRotate, opacity: dragOpacity }}
        whileHover={
          !stacked && !mobile && !dragging && !widened
            ? { y: -1, transition: BOUNCE_SPRING }
            : undefined
        }
        whileTap={
          !stacked && !dragging && !widened && canInteractClick
            ? { scale: 0.985, transition: BOUNCE_SPRING }
            : undefined
        }
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={event => finishDrag(event, false)}
        onPointerCancel={event => finishDrag(event, true)}
        onClick={event => {
          if (stacked) return
          if (suppressClickRef.current) {
            suppressClickRef.current = false
            return
          }
          const target = event.target as HTMLElement | null
          if (target?.closest('.air-message-close')) return
          if (window.getSelection()?.toString()) return
          if (!canInteractClick) return
          onToggleExpand(hasDetails)
        }}
        onKeyDown={event => {
          if (event.key === 'Escape') {
            event.stopPropagation()
            dismiss(item.id)
          }
        }}
      >
        <span className="air-message-badge" aria-hidden="true">
          <Icon className="air-message-icon" />
        </span>
        <div className="air-message-text air-scroll" role={item.type === 'error' ? 'alert' : 'status'} aria-atomic="true">
          <span ref={titleRef} className="air-message-title">{item.title}</span>
          {item.description && <span className="air-message-description">{item.description}</span>}
        </div>
        {hasDetails && (
          <span className="air-message-expand" aria-hidden="true">
            <ChevronDown size={mobile ? 13 : 14} />
          </span>
        )}
        <button
          type="button"
          className="air-message-close"
          aria-label={tr("关闭通知")}
          onClick={() => dismiss(item.id)}
        >
          <X size={13} aria-hidden="true" />
        </button>
      </motion.div>
    </motion.div>
  )
}

export function MessageViewport({ mobile = false }: { mobile?: boolean }) {
  const items = useSyncExternalStore(subscribe, snapshot)
  const [hovered, setHovered] = useState(false)
  const [focused, setFocused] = useState(false)
  const [widenedId, setWidenedId] = useState<string | null>(null)
  const [stackOpen, setStackOpen] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [hidden, setHidden] = useState(document.hidden)
  const [frontHeight, setFrontHeight] = useState(0)
  const viewport = useRef<HTMLElement>(null)
  const returnFocus = useRef<HTMLElement | null>(null)
  const hasWidened = Boolean(widenedId && items.some(item => item.id === widenedId))
  const expanded = hasWidened || stackOpen || hovered || focused
  const frontId = items[0]?.id ?? null

  useEffect(() => {
    setWidenedId(null)
  }, [frontId])

  useEffect(() => {
    if (items.length <= 1) setStackOpen(false)
  }, [items.length])

  useEffect(() => {
    const onVisibility = () => setHidden(document.hidden)
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'F6' || !viewport.current?.childElementCount) return
      event.preventDefault()
      if (viewport.current.contains(document.activeElement)) {
        returnFocus.current?.focus()
        if (viewport.current.contains(document.activeElement) && document.activeElement instanceof HTMLElement) {
          document.activeElement.blur()
        }
      } else {
        returnFocus.current = document.activeElement as HTMLElement
        viewport.current.querySelector('button')?.focus()
      }
    }
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('keydown', onKey)
    }
  }, [])

  useEffect(() => {
    if (!hasWidened && !stackOpen) return
    const onPointerDown = (event: PointerEvent) => {
      if (!viewport.current?.contains(event.target as Node | null)) {
        setWidenedId(null)
        setStackOpen(false)
      }
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setWidenedId(null)
        setStackOpen(false)
      }
    }
    document.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [hasWidened, stackOpen])

  useEffect(() => {
    if (items.length) return
    setHovered(false)
    setFocused(false)
    setWidenedId(null)
    setStackOpen(false)
    setDragging(false)
    setFrontHeight(0)
    if (document.activeElement === document.body) returnFocus.current?.focus()
    returnFocus.current = null
  }, [items.length])

  return createPortal(
    <section
      ref={viewport}
      className="air-message-stack"
      aria-label={tr("消息提示")}
      data-expanded={expanded || undefined}
      data-widened={hasWidened || undefined}
      data-mobile={mobile || undefined}
      style={frontHeight ? ({ '--message-front-height': `${frontHeight}px` } as CSSProperties) : undefined}
      onPointerEnter={event => { if (!mobile && event.pointerType !== 'touch') setHovered(true) }}
      onPointerLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false) }}
    >
      <AnimatePresence mode="popLayout">
        {items.map((item, index) => (
          <MessageRow
            key={item.id}
            item={item}
            index={index}
            expanded={expanded}
            widened={widenedId === item.id}
            hasStack={items.length > 1}
            paused={expanded || hidden || dragging}
            mobile={mobile}
            onDraggingChange={setDragging}
            onToggleExpand={hasDetails => {
              if (hasDetails) {
                setWidenedId(prev => {
                  const next = prev === item.id ? null : item.id
                  if (next === null) setStackOpen(false)
                  return next
                })
              } else if (items.length > 1) {
                setStackOpen(prev => !prev)
              } else {
                setWidenedId(null)
              }
            }}
            onFrontHeight={index === 0 ? setFrontHeight : undefined}
          />
        ))}
      </AnimatePresence>
    </section>,
    document.body,
  )
}
