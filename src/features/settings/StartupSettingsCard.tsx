import { tr } from '@/shared/i18n/messages'
import { LogIn, Power } from 'lucide-react'
import { useEffect, useState } from 'react'
import { air, type StartupSettings } from '@/platform/desktop/air'
import { Card } from '@/shared/ui/card'
import { showMessage } from '@/shared/ui/message'
import { Separator } from '@/shared/ui/separator'
import { Switch } from '@/shared/ui/switch'

const options = [
  { key: 'login', get title() { return tr('开机自启动') }, get description() { return tr('登录 Windows 后自动打开 Air') }, icon: LogIn },
  { key: 'proxy', get title() { return tr('打开 Air 时总是启动代理') }, get description() { return tr('关闭此项后，下次打开 Air 时代理保持关闭') }, icon: Power },
] as const

let cachedStartup: StartupSettings | undefined

export function StartupSettingsCard() {
  const [settings, setSettings] = useState<StartupSettings | undefined>(() => cachedStartup)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let active = true
    void air.startupSettings().then(
      next => {
        cachedStartup = next
        if (active) setSettings(next)
      },
      error => { if (active) showMessage({ type: 'error', title: String(error) }) },
    )
    return () => { active = false }
  }, [])

  async function change(key: keyof StartupSettings, enabled: boolean) {
    setSaving(true)
    try {
      const next = await air.setStartupSetting(key, enabled)
      cachedStartup = next
      setSettings(next)
    } catch (error) {
      showMessage({ type: 'error', title: String(error) })
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="flex flex-col gap-2" aria-label={tr("启动")}>
      <h2 className="px-1 text-xs font-semibold tracking-wider uppercase text-muted-foreground">{tr("启动")}</h2>
      <Card className="gap-0 overflow-hidden p-0">
        {options.map(({ key, title, description, icon: Icon }, index) => (
          <div key={key}>
            {index > 0 && <Separator />}
            <label className="flex cursor-pointer items-center gap-3 px-4 py-3.5">
              <span className="grid size-8.5 shrink-0 place-items-center rounded-[8px] border border-border-subtle bg-muted/70 text-muted-foreground">
                <Icon className="size-4" aria-hidden="true" />
              </span>
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <strong className="text-sm font-semibold">{title}</strong>
                <small className="text-xs text-muted-foreground">{description}</small>
              </span>
              <Switch aria-label={title} disabled={!settings || saving} checked={settings?.[key] ?? false}
                onCheckedChange={enabled => void change(key, enabled)} />
            </label>
          </div>
        ))}
      </Card>
    </section>
  )
}
