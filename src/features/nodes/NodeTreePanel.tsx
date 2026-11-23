import { tr } from '@/shared/i18n/messages'
import type { ReactNode } from 'react'
import { ResizableSidePanel } from '@/shared/ui/ResizableSidePanel'

export function NodeTreePanel({
  hasInspector,
  children,
}: {
  hasInspector: boolean
  children: ReactNode
}) {
  return (
    <ResizableSidePanel
      storageKey="air.nodeTreeWidth"
      defaultWidth={204}
      minWidth={178}
      maxWidth={380}
      reservedRightWidth={(hasInspector ? 344 + 24 : 12) + 280}
      ariaLabel={tr("调整分组栏宽度")}
    >
      {children}
    </ResizableSidePanel>
  )
}
