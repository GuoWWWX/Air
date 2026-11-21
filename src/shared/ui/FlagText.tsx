import type { ReactNode } from 'react'

const FLAG_SEQUENCE_RE =
  /([\u{1F1E6}-\u{1F1FF}]{2}|\u{1F3F4}[\u{E0061}-\u{E007A}]+\u{E007F})/gu

/**
 * 为展示文本中的国家/地区旗帜 Emoji 补充合适的后置视觉间距，
 * 避免无空格或窄空格场景下国旗紧贴后续文字；不修改原始文本内容与可复制字符。
 */
export function FlagText({ text }: { text: string }): ReactNode {
  if (!text) return text
  const matches = Array.from(text.matchAll(FLAG_SEQUENCE_RE))
  if (!matches.length) return text

  const nodes: ReactNode[] = []
  let cursor = 0

  for (const match of matches) {
    const start = match.index ?? 0
    const flag = match[0]
    if (start > cursor) {
      nodes.push(text.slice(cursor, start))
    }

    const end = start + flag.length
    const rest = text.slice(end)
    const spacingClass = !rest.length
      ? undefined
      : /^\s/.test(rest)
        ? 'mr-[0.12em]'
        : 'mr-[0.38em]'

    nodes.push(
      spacingClass ? (
        <span key={`${start}:${flag}`} className={spacingClass}>
          {flag}
        </span>
      ) : (
        flag
      ),
    )
    cursor = end
  }

  if (cursor < text.length) {
    nodes.push(text.slice(cursor))
  }

  return nodes
}
