import { displayPath } from '@/shared/lib/displayPath'
import { AnimatePresence, motion } from 'motion/react'
import { useId, useState } from 'react'
import { ChevronDown, Languages, Upload } from 'lucide-react'
import { AirSelect } from '@/shared/ui/AirSelect'
import { Button } from '@/shared/ui/button'
import { Card } from '@/shared/ui/card'
import { Separator } from '@/shared/ui/separator'
import { showMessage } from '@/shared/ui/message'
import { cn } from '@/shared/lib/utils'
import { activateLanguage, useLanguage, tr, type LanguageState } from './messages'

type NoticeState = {
  tone: 'info' | 'error'
  kind: 'saveError' | 'importSuccess' | 'importError'
}

export function LanguagePicker({ save, importPack, variant = 'desktop', embedded = false }: {
  save: (code: string) => Promise<LanguageState>
  importPack?: () => Promise<boolean>
  variant?: 'desktop' | 'mobile'
  embedded?: boolean
}) {
  const language = useLanguage()
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<NoticeState | null>(null)
  const [expanded, setExpanded] = useState(false)
  const detailsId = useId()
  const isMobile = variant === 'mobile'
  const hasDetails = Boolean(language.directory || importPack)

  const options = [
    { value: 'system', label: tr('跟随系统') },
    ...language.options.map(option => ({ value: option.code, label: option.name })),
  ]
  const activeLanguageName = language.options.find(option => option.code === language.code)?.name
  const subtitle = language.preference === 'system' ? activeLanguageName : undefined

  async function change(code: string) {
    if (code === language.preference) return
    setBusy(true)
    try {
      activateLanguage(await save(code))
      setNotice(null)
    } catch {
      setNotice({ tone: 'error', kind: 'saveError' })
      showMessage({ type: 'error', title: tr('无法保存语言设置') })
    } finally {
      setBusy(false)
    }
  }

  async function handleImport() {
    if (!importPack) return
    setBusy(true)
    try {
      if (await importPack()) {
        setNotice({ tone: 'info', kind: 'importSuccess' })
        showMessage({ type: 'success', title: tr('重启后可在语言列表中选择新语言') })
      }
    } catch {
      setNotice({ tone: 'error', kind: 'importError' })
      showMessage({ type: 'error', title: tr('语言包无效') })
    } finally {
      setBusy(false)
    }
  }

  const noticeText = notice
    ? notice.kind === 'saveError'
      ? tr('无法保存语言设置')
      : notice.kind === 'importSuccess'
        ? tr('重启后可在语言列表中选择新语言')
        : tr('语言包无效')
    : ''

  const importButton = importPack && (
    <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void handleImport()}>
      <Upload className="size-3.5" aria-hidden="true" />
      {tr('导入语言包')}
    </Button>
  )

  const toggleExpanded = () => {
    if (hasDetails) setExpanded(value => !value)
  }

  const body = (
    <>
      <div
        role={hasDetails ? 'button' : undefined}
        tabIndex={hasDetails ? 0 : undefined}
        aria-expanded={hasDetails ? expanded : undefined}
        aria-controls={hasDetails ? detailsId : undefined}
        onClick={hasDetails ? toggleExpanded : undefined}
        onKeyDown={
          hasDetails
            ? e => {
                if (e.target !== e.currentTarget) return
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  toggleExpanded()
                }
              }
            : undefined
        }
        className={cn(
          'flex items-center text-left transition-colors',
          isMobile ? 'min-h-[52px] gap-[9px] px-[11px] py-2.5' : 'gap-3 px-4 py-3.5',
          hasDetails &&
            cn(
              'cursor-pointer select-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset',
              isMobile ? 'active:bg-[var(--panel-subtle)]' : 'hover:bg-accent/55',
            ),
        )}
      >
        <span
          className={
            isMobile
              ? 'row-icon'
              : 'grid size-8.5 shrink-0 place-items-center rounded-[8px] border border-border-subtle bg-muted/70 text-muted-foreground'
          }
        >
          <Languages size={16} aria-hidden="true" />
        </span>
        <span className={isMobile ? 'row-main' : 'flex min-w-0 flex-1 flex-col gap-0.5'}>
          {isMobile ? (
            <b className="truncate text-[14px] font-semibold text-foreground">{tr('语言')}</b>
          ) : (
            <strong className="text-sm font-semibold text-foreground">{tr('语言')}</strong>
          )}
          {subtitle && (
            <small className={cn('truncate text-muted-foreground', isMobile ? 'text-[11px]' : 'text-xs')}>
              {subtitle}
            </small>
          )}
        </span>
        <div
          className="flex shrink-0 items-center"
          onClick={e => e.stopPropagation()}
          onKeyDown={e => e.stopPropagation()}
        >
          <AirSelect
            label={tr('语言')}
            value={language.preference}
            options={options}
            disabled={busy}
            align="end"
            className={cn('shrink-0', isMobile ? 'h-9 w-[116px]' : 'w-40')}
            onChange={code => void change(code)}
          />
        </div>
        {hasDetails && (
          <ChevronDown
            size={isMobile ? 15 : 16}
            aria-hidden="true"
            className={cn(
              'shrink-0 text-muted-foreground/75 transition-transform duration-200',
              expanded && 'rotate-180',
            )}
          />
        )}
      </div>

      <AnimatePresence initial={false}>
        {hasDetails && expanded && (
          <motion.div
            id={detailsId}
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
            className="overflow-hidden"
          >
            {!isMobile && <Separator />}
            <div
              className={cn(
                'flex',
                isMobile
                  ? 'flex-col gap-2 border-t border-border-subtle bg-secondary/50 px-3 py-2.5'
                  : 'flex-wrap items-center justify-between gap-3 bg-muted/35 px-4 py-2.5',
              )}
            >
              {language.directory && (
                <div className={cn('min-w-0', !isMobile && 'flex-1')}>
                  <div className="text-[11px] font-medium text-muted-foreground">{tr('语言文件夹')}</div>
                  <div className="mt-0.5 break-all font-mono text-[11px] leading-relaxed text-foreground/80">
                    {displayPath(language.directory)}
                  </div>
                </div>
              )}
              {importButton && (isMobile ? <div>{importButton}</div> : importButton)}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {noticeText && (
        <>
          {!isMobile && <Separator />}
          <div
            role="status"
            className={cn(
              'text-xs',
              isMobile ? 'border-t border-border-subtle px-3 py-2' : 'px-4 py-2',
              notice?.tone === 'error' ? 'text-destructive' : 'text-muted-foreground',
            )}
          >
            {noticeText}
          </div>
        </>
      )}
    </>
  )

  if (embedded) {
    return isMobile ? <div className="border-t border-[var(--line)]">{body}</div> : body
  }

  return (
    <section className={isMobile ? undefined : 'flex flex-col gap-2'} aria-label={tr('语言')}>
      <h2 className={isMobile ? undefined : 'px-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground'}>
        {tr('语言')}
      </h2>
      {isMobile ? (
        <div className="panel settings-panel">{body}</div>
      ) : (
        <Card className="gap-0 overflow-hidden p-0">{body}</Card>
      )}
    </section>
  )
}
