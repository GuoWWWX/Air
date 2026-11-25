import Markdown from 'react-markdown'
import { memo } from 'react'
import remarkGfm from 'remark-gfm'

export default memo(function ReleaseNotes({
  notes,
  onOpenLink,
  compact = false,
}: {
  notes: string
  onOpenLink: (url: string) => void
  compact?: boolean
}) {
  return (
    <div
      className={
        compact
          ? 'flex flex-col gap-1.5 break-words text-xs leading-[1.55] text-foreground [&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-2.5 [&_code]:rounded-sm [&_code]:bg-muted [&_code]:px-1 [&_h1]:text-[13px] [&_h2]:text-[13px] [&_h3]:text-xs [&_h1]:font-semibold [&_h2]:font-semibold [&_h3]:font-semibold [&_li]:my-0.5 [&_ol]:list-decimal [&_ol]:pl-4 [&_pre]:air-scroll [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-muted [&_pre]:p-2 [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_table]:w-full [&_td]:border [&_td]:border-border [&_td]:p-1.5 [&_th]:border [&_th]:border-border [&_th]:p-1.5 [&_ul]:list-disc [&_ul]:pl-4'
          : 'flex flex-col gap-1.5 break-words text-[12.5px] leading-[1.6] text-foreground [&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-2.5 [&_code]:rounded-sm [&_code]:bg-muted [&_code]:px-1 [&_h1]:text-[13.5px] [&_h2]:text-[13.5px] [&_h3]:text-[12.5px] [&_h1]:font-semibold [&_h2]:font-semibold [&_h3]:font-semibold [&_li]:my-0.5 [&_ol]:list-decimal [&_ol]:pl-4 [&_pre]:air-scroll [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-muted [&_pre]:p-2 [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_table]:w-full [&_td]:border [&_td]:border-border [&_td]:p-1.5 [&_th]:border [&_th]:border-border [&_th]:p-1.5 [&_ul]:list-disc [&_ul]:pl-4'
      }
    >
      <Markdown
        skipHtml
        disallowedElements={['img']}
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => href?.startsWith('https://') ? (
            <a
              href={href}
              className="text-primary underline underline-offset-2"
              onClick={event => {
                event.preventDefault()
                onOpenLink(href)
              }}
            >
              {children}
            </a>
          ) : <span>{children}</span>,
        }}
      >
        {notes}
      </Markdown>
    </div>
  )
})
