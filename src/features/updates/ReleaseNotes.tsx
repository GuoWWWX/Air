import Markdown from 'react-markdown'
import { memo } from 'react'
import remarkGfm from 'remark-gfm'
import { openUpdateLink } from './useUpdates'

export default memo(function ReleaseNotes({
  notes,
  onError,
}: {
  notes: string
  onError: (error: unknown) => void
}) {
  return (
    <div className="flex flex-col gap-2.5 break-words text-sm leading-relaxed text-foreground [&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-3 [&_code]:rounded-sm [&_code]:bg-muted [&_code]:px-1 [&_h1]:text-[15px] [&_h2]:text-[15px] [&_h3]:text-sm [&_h1]:font-semibold [&_h2]:font-semibold [&_h3]:font-semibold [&_ol]:list-decimal [&_ol]:pl-5 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-muted [&_pre]:p-2 [&_table]:w-full [&_td]:border [&_td]:border-border [&_td]:p-1.5 [&_th]:border [&_th]:border-border [&_th]:p-1.5 [&_ul]:list-disc [&_ul]:pl-5">
      <Markdown
        skipHtml
        disallowedElements={['img']}
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => href?.startsWith('https://') ? (
            <a href={href} className="text-primary underline underline-offset-2" onClick={event => {
              event.preventDefault()
              void openUpdateLink(href).catch(onError)
            }}>{children}</a>
          ) : <span>{children}</span>,
        }}
      >
        {notes}
      </Markdown>
    </div>
  )
})
