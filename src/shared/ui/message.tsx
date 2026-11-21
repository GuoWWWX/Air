import { CircleAlert, CircleCheck, Info, TriangleAlert, X } from 'lucide-react'
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
  publish([item, ...messages.filter(previous => previous.id !== item.id)].slice(0, 4))
}

function dismiss(id: string, vector?: ExitVector) {
  if (vector) exitVectors.set(id, vector)
  else exitVectors.delete(id)
  publish(messages.filter(item => item.id !== id))
}

const ENTER_SPRING: Transition = { type: 'spring', stiffness: 430, damping: 23, mass: 0.72 }
const BOUNCE_SPRING: Transition = { type: 'spring', stiffness: 480, damping: 16, mass: 0.62 }
const RESET_SPRING = { type: 'spring' as const, stiffness: 520, damping: 22, mass: 0.65 }

function rubberBand(delta: number, limit = 24) {
  const sign = delta < 0 ? -1 : 1
  return sign * limit * (1 - Math.exp(-Math.abs(delta) / 90))
}

const slotVariants = {
  initial: { opacity: 0, y: -26, scale: 0.88 },
  animate: ({ stacked, index }: { stacked: boolean; index: number }) => ({
    opacity: stacked ? Math.max(0.58, 1 - index * 0.2) : 1,
    y: stacked ? index * 6 : 0,
    scale: stacked ? 1 - index * 0.05 : 1,
    transition: ENTER_SPRING,
  }),
  exit: ({ id }: { id: string }) => {
    const vector = exitVectors.get(id)
    if (vector) {
      exitVectors.delete(id)
      return {
        opacity: 0,
        x: vector.x,
        y: vector.y,
        rotate: vector.rotate,
        scale: 0.9,
        transition: { duration: 0.2, ease: [0.32, 0.72, 0, 1] as const },
      }
    }
    return {
      opacity: 0,
      y: -22,
      scale: 0.88,
      transition: { duration: 0.18, ease: [0.4, 0, 1, 1] as const },
    }
  },
}

function MessageRow({
  item,
  index,
  expanded,
  paused,
  mobile,
  onDraggingChange,
}: {
  item: Message
  index: number
  expanded: boolean
  paused: boolean
  mobile: boolean
  onDraggingChange: (dragging: boolean) => void
}) {
  const Icon = icons[item.type]
  const stacked = index > 0 && !expanded
  const remaining = useRef(0)
  const [dragging, setDragging] = useState(false)

  const dragX = useMotionValue(0)
  const dragY = useMotionValue(0)
  const dragRotate = useTransform(dragX, [-220, 0, 220], [-6, 0, 6])
  const dragOpacity = useTransform([dragX, dragY], ([x, y]: number[]) => {
    const distance = Math.hypot(x, y * 1.45)
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
    remaining.current = item.type === 'error' ? 6500 : 4000
  }, [item])

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

  function handlePointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (stacked) return
    if (event.pointerType === 'mouse' && event.button !== 0) return
    const target = event.target as HTMLElement | null
    if (target?.closest('.air-message-close')) return
    const text = event.currentTarget.querySelector('.air-message-text')
    if (text && text.contains(target) && text.scrollHeight > text.clientHeight + 2) return

    event.currentTarget.setPointerCapture(event.pointerId)
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
    const dt = Math.max(1, now - state.lastTime)
    state.vx = (event.clientX - state.lastX) / dt
    state.vy = (event.clientY - state.lastY) / dt
    state.lastX = event.clientX
    state.lastY = event.clientY
    state.lastTime = now

    if (!state.active) {
      if (Math.hypot(rawDx, rawDy) < 4) return
      state.active = true
      setDragging(true)
      onDraggingChange(true)
    }

    const freeAllDirections = mobile || state.pointerType === 'touch'
    if (freeAllDirections) {
      dragX.set(rawDx)
      dragY.set(rawDy)
    } else {
      // 桌面端：右滑和上滑自由跟手，左滑和下滑提供 Q 弹橡皮筋阻尼
      dragX.set(rawDx >= 0 ? rawDx : rubberBand(rawDx, 20))
      dragY.set(rawDy <= 0 ? rawDy : rubberBand(rawDy, 18))
    }
  }

  function finishDrag(event: ReactPointerEvent<HTMLDivElement>, cancelled = false) {
    const state = dragState.current
    if (!state || state.pointerId !== event.pointerId) return
    dragState.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }

    if (state.active) {
      setDragging(false)
      onDraggingChange(false)
    }

    const rawDx = event.clientX - state.startX
    const rawDy = event.clientY - state.startY
    const { vx, vy, pointerType } = state
    const freeAllDirections = mobile || pointerType === 'touch'

    if (!cancelled && state.active) {
      if (freeAllDirections) {
        const swipeRight = rawDx > 62 || (rawDx > 22 && vx > 0.32)
        const swipeLeft = rawDx < -62 || (rawDx < -22 && vx < -0.32)
        const swipeUp = rawDy < -34 || (rawDy < -14 && vy < -0.28)
        const swipeDown = rawDy > 50 || (rawDy > 20 && vy > 0.3)

        if (swipeRight || swipeLeft || swipeUp || swipeDown) {
          const preferHorizontal = Math.abs(rawDx) >= Math.abs(rawDy)
          if (preferHorizontal && (swipeRight || swipeLeft)) {
            const dir = swipeRight ? 1 : -1
            dismiss(item.id, { x: dir * 280, y: rawDy * 0.45, rotate: dir * 8 })
            return
          }
          if (swipeUp) {
            dismiss(item.id, { x: rawDx * 0.4, y: -110, rotate: 0 })
            return
          }
          if (swipeDown) {
            dismiss(item.id, { x: rawDx * 0.4, y: 120, rotate: 0 })
            return
          }
          const dir = swipeRight ? 1 : -1
          dismiss(item.id, { x: dir * 280, y: rawDy * 0.45, rotate: dir * 8 })
          return
        }
      } else {
        const swipeRight = rawDx > 74 || (rawDx > 26 && vx > 0.35)
        const swipeUp = rawDy < -36 || (rawDy < -14 && vy < -0.28)

        if (swipeRight && (!swipeUp || rawDx >= Math.abs(rawDy))) {
          dismiss(item.id, { x: 280, y: Math.min(0, rawDy) * 0.4, rotate: 7 })
          return
        }
        if (swipeUp) {
          dismiss(item.id, { x: Math.max(0, rawDx) * 0.4, y: -100, rotate: 0 })
          return
        }
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
      style={{ '--message-index': index, zIndex: 10 - index } as CSSProperties}
      custom={{ id: item.id, stacked, index }}
      variants={slotVariants}
      initial="initial"
      animate="animate"
      exit="exit"
    >
      <motion.div
        className="air-message"
        data-type={item.type}
        data-dragging={dragging || undefined}
        aria-hidden={stacked || undefined}
        style={{ x: dragX, y: dragY, rotate: dragRotate, opacity: dragOpacity }}
        whileHover={
          !stacked && !mobile && !dragging
            ? { scale: 1.045, y: -1.5, transition: BOUNCE_SPRING }
            : undefined
        }
        whileTap={
          !stacked && !dragging
            ? { scale: 0.955, transition: BOUNCE_SPRING }
            : undefined
        }
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={event => finishDrag(event, false)}
        onPointerCancel={event => finishDrag(event, true)}
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
        <div className="air-message-text" role={item.type === 'error' ? 'alert' : 'status'} aria-atomic="true">
          <span className="air-message-title">{item.title}</span>
          {item.description && <span className="air-message-description">{item.description}</span>}
        </div>
        <button
          type="button"
          className="air-message-close"
          aria-label="关闭通知"
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
  const [dragging, setDragging] = useState(false)
  const [hidden, setHidden] = useState(document.hidden)
  const viewport = useRef<HTMLElement>(null)
  const returnFocus = useRef<HTMLElement | null>(null)
  const expanded = hovered || focused

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
    if (items.length) return
    setHovered(false)
    setFocused(false)
    setDragging(false)
    if (document.activeElement === document.body) returnFocus.current?.focus()
    returnFocus.current = null
  }, [items.length])

  return createPortal(
    <section
      ref={viewport}
      className="air-message-stack"
      aria-label="消息提示"
      data-expanded={expanded || undefined}
      data-mobile={mobile || undefined}
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
            paused={expanded || hidden || dragging}
            mobile={mobile}
            onDraggingChange={setDragging}
          />
        ))}
      </AnimatePresence>
    </section>,
    document.body,
  )
}
