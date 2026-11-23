import { tr } from '@/shared/i18n/messages'
import { ChevronDown, ChevronUp, Search, X } from 'lucide-react'
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react'
import { cn } from '@/shared/lib/utils'
import { Button } from './button'

export interface TextMatch {
  from: number
  to: number
  line: number
}

export interface EditorSearchState {
  matches: readonly TextMatch[]
  activeIndex: number
  scrollTick: number
}

export function normalizeLineEndings(text: string): string {
  return text.includes('\r\n') ? text.replace(/\r\n/g, '\n') : text
}

export function findTextMatches(text: string, query: string): TextMatch[] {
  if (!query) return []
  const normalized = normalizeLineEndings(text)
  const lowerText = normalized.toLowerCase()
  const lowerQuery = query.toLowerCase()
  const step = Math.max(1, lowerQuery.length)
  const matches: TextMatch[] = []
  let line = 1
  let scanFrom = 0
  let pos = lowerText.indexOf(lowerQuery, 0)
  while (pos !== -1) {
    for (let i = scanFrom; i < pos; i++) {
      if (normalized.charCodeAt(i) === 10) line++
    }
    scanFrom = pos
    matches.push({ from: pos, to: pos + lowerQuery.length, line })
    pos = lowerText.indexOf(lowerQuery, pos + step)
  }
  return matches
}

export function renderMatchedText(
  text: string,
  startOffset: number,
  matches: readonly TextMatch[],
  activeIndex: number,
): ReactNode {
  if (!text || matches.length === 0) return text
  const endOffset = startOffset + text.length
  let cursor = 0
  let nodes: ReactNode[] | undefined

  for (let i = 0; i < matches.length; i++) {
    const match = matches[i]
    if (match.to <= startOffset) continue
    if (match.from >= endOffset) break
    const localFrom = Math.max(0, match.from - startOffset)
    const localTo = Math.min(text.length, match.to - startOffset)
    if (localTo <= localFrom) continue
    if (!nodes) nodes = []
    if (localFrom > cursor) nodes.push(text.slice(cursor, localFrom))
    const isActive = i === activeIndex
    nodes.push(
      <mark
        key={`${i}:${localFrom}`}
        className={isActive ? 'air-search-match-active' : 'air-search-match'}
        data-active-match={isActive ? 'true' : undefined}
      >
        {text.slice(localFrom, localTo)}
      </mark>,
    )
    cursor = localTo
  }

  if (!nodes) return text
  if (cursor < text.length) nodes.push(text.slice(cursor))
  return <>{nodes.map((node, index) => <Fragment key={index}>{node}</Fragment>)}</>
}

export function useEditorSearch(
  text: string,
  options?: { enableShortcut?: boolean; canOpen?: boolean; resetKey?: string | number },
) {
  const [open, setOpen] = useState(false)
  const [query, setQueryState] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const [scrollTick, setScrollTick] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  const matches = useMemo(
    () => (open && query ? findTextMatches(text, query) : []),
    [open, text, query],
  )
  const effectiveIndex = matches.length === 0 ? -1 : ((activeIndex % matches.length) + matches.length) % matches.length

  const focusInput = useCallback(() => {
    window.requestAnimationFrame(() => {
      inputRef.current?.focus()
      inputRef.current?.select()
    })
  }, [])

  const setQuery = useCallback((next: string) => {
    setQueryState(next)
    setActiveIndex(0)
    setScrollTick(t => t + 1)
  }, [])

  const goNext = useCallback(() => {
    if (matches.length === 0) return
    setActiveIndex(effectiveIndex < 0 ? 0 : (effectiveIndex + 1) % matches.length)
    setScrollTick(t => t + 1)
  }, [effectiveIndex, matches.length])

  const goPrev = useCallback(() => {
    if (matches.length === 0) return
    setActiveIndex(effectiveIndex < 0 ? 0 : (effectiveIndex - 1 + matches.length) % matches.length)
    setScrollTick(t => t + 1)
  }, [effectiveIndex, matches.length])

  const openSearch = useCallback(() => {
    setOpen(true)
    if (query) setScrollTick(t => t + 1)
    focusInput()
  }, [focusInput, query])

  const closeSearch = useCallback(() => {
    setOpen(false)
  }, [])

  const toggleSearch = useCallback(() => {
    if (open) closeSearch()
    else openSearch()
  }, [closeSearch, open, openSearch])

  const latestRef = useRef({
    open,
    query,
    canOpen: options?.canOpen !== false,
    openSearch,
    closeSearch,
    goNext,
    goPrev,
  })
  latestRef.current = {
    open,
    query,
    canOpen: options?.canOpen !== false,
    openSearch,
    closeSearch,
    goNext,
    goPrev,
  }

  const prevResetKey = useRef(options?.resetKey)
  useEffect(() => {
    if (prevResetKey.current === options?.resetKey) return
    prevResetKey.current = options?.resetKey
    if (!latestRef.current.open) return
    setActiveIndex(0)
    if (latestRef.current.query) setScrollTick(t => t + 1)
  }, [options?.resetKey])

  const enableShortcut = options?.enableShortcut !== false
  useEffect(() => {
    if (!enableShortcut) return
    const onKeyDown = (event: KeyboardEvent) => {
      const state = latestRef.current
      if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'f') {
        if (!state.canOpen) return
        event.preventDefault()
        event.stopPropagation()
        state.openSearch()
        return
      }
      if (!state.open) return
      if (event.key === 'F3' || ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'g')) {
        event.preventDefault()
        event.stopPropagation()
        if (event.shiftKey) state.goPrev()
        else state.goNext()
        return
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        state.closeSearch()
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [enableShortcut])

  const searchState: EditorSearchState | undefined =
    open && query ? { matches, activeIndex: effectiveIndex, scrollTick } : undefined

  return {
    open,
    query,
    matches,
    activeIndex: effectiveIndex,
    scrollTick,
    openSearch,
    closeSearch,
    toggleSearch,
    goNext,
    goPrev,
    searchState,
    barProps: {
      open,
      query,
      onQueryChange: setQuery,
      matchCount: matches.length,
      activeIndex: effectiveIndex,
      onPrev: goPrev,
      onNext: goNext,
      onClose: closeSearch,
      inputRef,
    },
  }
}

export function EditorSearchBar({
  open,
  query,
  onQueryChange,
  matchCount,
  activeIndex,
  onPrev,
  onNext,
  onClose,
  inputRef,
  compact = false,
  className,
}: {
  open: boolean
  query: string
  onQueryChange: (value: string) => void
  matchCount: number
  activeIndex: number
  onPrev: () => void
  onNext: () => void
  onClose: () => void
  inputRef: RefObject<HTMLInputElement | null>
  compact?: boolean
  className?: string
}) {
  if (!open) return null
  return (
    <div className={cn('air-editor-search', compact && 'air-editor-search-compact', className)}>
      <Search className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
      <input
        ref={inputRef}
        type="text"
        value={query}
        placeholder={tr('查找配置内容')}
        aria-label={tr('查找配置内容')}
        spellCheck={false}
        autoComplete="off"
        onChange={event => onQueryChange(event.target.value)}
        onKeyDown={event => {
          if (event.nativeEvent.isComposing || event.keyCode === 229) return
          if (event.key === 'Enter') {
            event.preventDefault()
            if (event.shiftKey) onPrev()
            else onNext()
          } else if (event.key === 'Escape') {
            event.preventDefault()
            event.stopPropagation()
            onClose()
          } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
            event.preventDefault()
            event.currentTarget.select()
          }
        }}
      />
      {query && (
        <span
          className={cn('air-editor-search-count mono', matchCount === 0 && 'text-destructive')}
          role="status"
          aria-live="polite"
        >
          {matchCount > 0 ? `${activeIndex + 1} / ${matchCount}` : '0 / 0'}
        </span>
      )}
      <div className="flex shrink-0 items-center gap-0.5">
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          aria-label={tr('上一个')}
          title={tr('上一个')}
          disabled={matchCount === 0}
          onClick={onPrev}
        >
          <ChevronUp />
        </Button>
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          aria-label={tr('下一个')}
          title={tr('下一个')}
          disabled={matchCount === 0}
          onClick={onNext}
        >
          <ChevronDown />
        </Button>
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          aria-label={tr('关闭搜索')}
          title={tr('关闭搜索')}
          onClick={onClose}
        >
          <X />
        </Button>
      </div>
    </div>
  )
}
