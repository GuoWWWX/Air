import { useState } from 'react'
import { Zap } from 'lucide-react'
import { tr } from '@/shared/i18n/messages'
import { highSpeedProbe } from '@/shared/lib/preferences'
import { Switch } from './switch'

export function HighSpeedProbeSetting({ mobile = false }: { mobile?: boolean }) {
  const [enabled, setEnabled] = useState(highSpeedProbe.get)
  return (
    <label className={mobile ? 'setting-row' : 'flex w-full items-center gap-3 px-4 py-3.5'}>
      <span className={mobile ? 'row-icon' : 'grid size-8.5 shrink-0 place-items-center rounded-[8px] border border-border-subtle bg-muted/70 text-muted-foreground'}>
        <Zap size={16} />
      </span>
      <span className={mobile ? 'row-main' : 'flex min-w-0 flex-1 flex-col gap-0.5'}>
        <strong className="text-sm font-semibold">{tr('高速测速')}</strong>
        <small className="text-xs text-muted-foreground">{tr('手动测速默认同时测 {0} 个节点。开启后按 CPU 提高并发，最多 {1} 个。', mobile ? 24 : 32, mobile ? 48 : 64)}</small>
      </span>
      <Switch aria-label={tr('高速测速')} checked={enabled} onCheckedChange={value => {
        highSpeedProbe.set(value)
        setEnabled(value)
      }} />
    </label>
  )
}
