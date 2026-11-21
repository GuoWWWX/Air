import { Dialog } from '@base-ui/react/dialog'
import { ChevronLeft, ChevronRight, type LucideIcon } from 'lucide-react'
import { AnimatePresence, LayoutGroup, animate, motion, useIsPresent, useMotionValue, useTransform } from 'motion/react'
import { useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { BUTTON_SPRING, ICON_SPRING, navigation, type Page } from '@/shared/ui/app-navigation'
import { Button } from '@/shared/ui/button'
import { Empty as EmptyState, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/shared/ui/empty'
import { cn } from '@/shared/lib/utils'

export function Header({ title, back, action }: { title: string; back?: () => void; action?: ReactNode }) {
  return <header className="mobile-header">
    {back && <Button size="icon" variant="outline" aria-label="返回" onClick={back}><ChevronLeft /></Button>}
    <h1>{title}</h1>
    {action}
  </header>
}

export function BottomNavigation({ page, onChange }: { page: Page; onChange: (page: Page) => void }) {
  return <nav className="bottom-nav" aria-label="主导航">
    <LayoutGroup id="android-navigation">
      {navigation.map(({ id, label, icon: Icon, hoverAnimate, hoverTransition }) => {
        const active = page === id
        return <motion.button key={id} type="button" aria-current={active ? 'page' : undefined}
          onClick={() => onChange(id)} whileTap={{ scale: 0.93 }} transition={BUTTON_SPRING}>
          {active && <motion.span aria-hidden="true" layoutId="sidebar-nav-pill" className="bottom-nav-pill"
            transition={{ type: 'spring', stiffness: 500, damping: 38, mass: 0.85 }} />}
          <motion.span initial={false} className="tab-icon"
            animate={active ? hoverAnimate : { rotate: 0, y: 0, scale: 1 }}
            transition={active ? hoverTransition : ICON_SPRING}>
            <Icon size={20} strokeWidth={1.9} aria-hidden />
          </motion.span>
          <span className="relative">{label}</span>
        </motion.button>
      })}
    </LayoutGroup>
  </nav>
}

function SheetBody({ title, close, children }: { title: string; close: () => void; children: ReactNode }) {
  const isPresent = useIsPresent()
  const dragY = useMotionValue(0)
  const backdropOpacity = useTransform(dragY, [0, 280], [1, 0.15])
  const [dragging, setDragging] = useState(false)
  const dragState = useRef<{
    pointerId: number
    startY: number
    lastY: number
    lastTime: number
    vy: number
  } | null>(null)

  function onPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (!isPresent) return
    if (event.pointerType === 'mouse' && event.button !== 0) return
    event.currentTarget.setPointerCapture(event.pointerId)
    dragState.current = {
      pointerId: event.pointerId,
      startY: event.clientY,
      lastY: event.clientY,
      lastTime: performance.now(),
      vy: 0,
    }
    setDragging(true)
  }

  function onPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const state = dragState.current
    if (!state || state.pointerId !== event.pointerId) return
    const dy = event.clientY - state.startY
    const now = performance.now()
    const dt = Math.max(1, now - state.lastTime)
    state.vy = (event.clientY - state.lastY) / dt
    state.lastY = event.clientY
    state.lastTime = now
    // 向下拖动 1:1 跟手，向上拖动提供柔和橡皮筋阻尼
    dragY.set(dy >= 0 ? dy : -18 * (1 - Math.exp(dy / 75)))
  }

  function finishDrag(event: ReactPointerEvent<HTMLDivElement>, cancelled = false) {
    const state = dragState.current
    if (!state || state.pointerId !== event.pointerId) return
    dragState.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    setDragging(false)
    const dy = event.clientY - state.startY
    if (!cancelled && (dy > 88 || (dy > 26 && state.vy > 0.42))) {
      close()
      return
    }
    animate(dragY, 0, { type: 'spring', stiffness: 460, damping: 32, mass: 0.75 })
  }

  return (
    <Dialog.Root open onOpenChange={next => { if (!next && isPresent) close() }}>
      <Dialog.Portal>
        <Dialog.Backdrop
          render={
            <motion.div
              className={cn('sheet-backdrop-host', !isPresent && 'pointer-events-none')}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1, transition: { duration: 0.22, ease: 'easeOut' } }}
              exit={{ opacity: 0, transition: { duration: 0.2, ease: 'easeIn' } }}
            />
          }
        >
          <motion.div className="sheet-backdrop" style={{ opacity: backdropOpacity }} />
        </Dialog.Backdrop>
        <Dialog.Viewport className={cn('sheet-viewport', !isPresent && 'pointer-events-none')}>
          <Dialog.Popup
            render={
              <motion.div
                className="sheet-shell"
                initial={{ y: '100%' }}
                animate={{ y: 0, transition: { type: 'spring', stiffness: 380, damping: 34, mass: 0.85 } }}
                exit={{ y: '100%', transition: { duration: 0.22, ease: [0.32, 0.72, 0, 1] } }}
              />
            }
          >
            <motion.div className="sheet" style={{ y: dragY }}>
              <div
                className="sheet-handle"
                data-dragging={dragging || undefined}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={event => finishDrag(event, false)}
                onPointerCancel={event => finishDrag(event, true)}
              >
                <div className="sheet-grip" />
                <div className="sheet-heading">
                  <Dialog.Title>{title}</Dialog.Title>
                </div>
              </div>
              {children}
            </motion.div>
          </Dialog.Popup>
        </Dialog.Viewport>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

export function Sheet({ open, title, close, children }: { open: boolean; title: string; close: () => void; children: ReactNode }) {
  const cache = useRef({ title, children })
  if (open) cache.current = { title, children }

  return (
    <AnimatePresence>
      {open && (
        <SheetBody key="sheet" title={cache.current.title} close={close}>
          {cache.current.children}
        </SheetBody>
      )}
    </AnimatePresence>
  )
}

export function Tag({ children, tone = 'blue' }: { children: ReactNode; tone?: 'blue' | 'green' | 'amber' | 'red' | 'gray' }) {
  return <span className="tag" data-tone={tone}>{children}</span>
}

export function Empty({ icon: Icon, title, description, className, children }: {
  icon: LucideIcon; title: string; description?: string; className?: string; children?: ReactNode
}) {
  return <EmptyState className={cn('border border-dashed border-border bg-secondary/60', className)}>
    <EmptyHeader>
      <EmptyMedia variant="icon"><Icon aria-hidden /></EmptyMedia>
      <EmptyTitle>{title}</EmptyTitle>
      {description && <EmptyDescription>{description}</EmptyDescription>}
    </EmptyHeader>
    {children && <EmptyContent>{children}</EmptyContent>}
  </EmptyState>
}

export function Row({ icon: Icon, title, description, value, onClick }: {
  icon: LucideIcon; title: string; description?: string; value?: string; onClick: () => void
}) {
  return <button type="button" className="setting-row" aria-label={[title, value, description].filter(Boolean).join(' · ')} onClick={onClick}>
    <span className="row-icon"><Icon size={17} /></span>
    <span className="row-main"><b>{title}</b>{description && <small>{description}</small>}</span>
    {value && <small>{value}</small>}
    <ChevronRight size={16} className="shrink-0 text-muted-foreground" />
  </button>
}
