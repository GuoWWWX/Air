import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  Copy,
  GripVertical,
  Plus,
  RefreshCw,
  Trash2,
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Badge } from '@/shared/ui/badge'
import { Button } from '@/shared/ui/button'
import { Card } from '@/shared/ui/card'
import { Input } from '@/shared/ui/input'
import { Label } from '@/shared/ui/label'
import { showMessage } from '@/shared/ui/message'
import { Separator } from '@/shared/ui/separator'
import {
  air,
  type Library,
  type RouteRule,
  type RouteTarget,
  type RoutingConfig,
  type RoutingDocument,
} from '@/platform/desktop/air'
import { AirCheckbox } from '../../shared/ui/AirCheckbox'
import { AirSelect } from '../../shared/ui/AirSelect'

interface Props {
  sources: Library['sources']
  groups: Library['groups']
  bindApplication: boolean
  onBack: () => void
}

const matcherOptions = [
  { value: 'domain', label: '完整域名', example: 'intranet.example.com' },
  { value: 'domainSuffix', label: '域名及子域名', example: 'example.com' },
  { value: 'ip', label: 'IP 或网段', example: '10.0.0.0/8' },
  { value: 'processName', label: '程序文件名', example: 'chrome.exe' },
  { value: 'processPath', label: '程序路径', example: 'C:\\Program Files\\Example\\example.exe' },
] as const

function newRule(application = false): RouteRule {
  return {
    enabled: true,
    matcher: application ? 'processPath' : 'domainSuffix',
    value: '',
    target: { kind: application ? 'residential' : 'direct' },
  }
}

function targetKey(target: RouteTarget) {
  return target.kind === 'group' ? JSON.stringify([target.sourceId, target.name]) : target.kind
}

function TargetField({
  label,
  target,
  groups,
  fallback = false,
  onChange,
}: {
  label: string
  target: RouteTarget
  groups: Library['groups']
  fallback?: boolean
  onChange: (target: RouteTarget) => void
}) {
  const choices: { target: RouteTarget; label: string; disabled?: boolean }[] = [
    { target: { kind: 'direct' }, label: '直连' },
    { target: { kind: 'reject' }, label: '拒绝连接' },
    { target: { kind: 'residential' }, label: '链式出口' },
    ...groups.map(group => ({
      target: { kind: 'group' as const, sourceId: group.sourceId, name: group.name },
      label: group.name,
    })),
  ]
  if (fallback) {
    choices.splice(3, 0, { target: { kind: 'subscription' }, label: '沿用订阅默认出口' })
  }
  const value = targetKey(target)
  if (target.kind === 'group' && !choices.some(choice => targetKey(choice.target) === value)) {
    choices.push({ target, label: `${target.name}（来源不可用）`, disabled: true })
  }

  return (
    <div className="flex flex-col gap-1.5">
      <Label>{label}</Label>
      <AirSelect
        label={label}
        value={value}
        options={choices.map(choice => ({
          value: targetKey(choice.target),
          label: choice.label,
          disabled: choice.disabled,
        }))}
        onChange={next => {
          const choice = choices.find(item => targetKey(item.target) === next)
          if (choice) onChange(choice.target)
        }}
      />
    </div>
  )
}

export function RoutingSettings({ sources, groups, bindApplication, onBack }: Props) {
  const [draft, setDraft] = useState<RoutingConfig>()
  const [path, setPath] = useState('')
  const [revision, setRevision] = useState('')
  const [busy, setBusy] = useState(false)
  const [preview, setPreview] = useState<string[]>()
  const dragIndex = useRef<number | undefined>(undefined)

  const subscriptionSources = sources.filter(
    source => source.id !== 'custom' && source.details?.kind !== 'custom',
  )
  const activeGroups = groups.filter(group => group.sourceId === draft?.subscriptionId)
  const sourceMissing =
    Boolean(draft?.subscriptionId) &&
    !subscriptionSources.some(source => source.id === draft?.subscriptionId)
  const sourceOptions = [
    { value: 'none', label: '无', disabled: false },
    ...subscriptionSources.map(source => ({ value: source.id, label: source.name, disabled: false })),
  ]
  if (sourceMissing && draft?.subscriptionId) {
    sourceOptions.push({ value: draft.subscriptionId, label: '订阅已不存在', disabled: true })
  }

  function accept(document: RoutingDocument) {
    setDraft(document.routing)
    setPath(document.path)
    setRevision(document.revision)
    setPreview(undefined)
  }

  async function reload(bind = false, manual = false) {
    setBusy(true)
    try {
      const document = await air.routingSettings()
      accept(document)
      if (bind) {
        setDraft({ ...document.routing, rules: [...document.routing.rules, newRule(true)] })
      } else {
        await air.previewRouting(document.routing)
      }
      if (manual) showMessage({ type: 'success', title: '分流规则已重新读取' })
    } catch (error) {
      showMessage({ type: 'error', title: error instanceof Error ? error.message : String(error) })
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    void air.routingPath().then(setPath).catch(error => showMessage({ type: 'error', title: error instanceof Error ? error.message : String(error) }))
    void reload(bindApplication)
  }, [bindApplication])

  function update(change: (current: RoutingConfig) => RoutingConfig) {
    setDraft(current => (current ? change(current) : current))
    setPreview(undefined)
  }

  function changeRule(index: number, change: Partial<RouteRule>) {
    update(current => ({
      ...current,
      rules: current.rules.map((rule, at) => (at === index ? { ...rule, ...change } : rule)),
    }))
  }

  function reorder(from: number, to: number) {
    update(current => {
      if (
        from === to ||
        from < 0 ||
        to < 0 ||
        from >= current.rules.length ||
        to >= current.rules.length
      ) {
        return current
      }
      const rules = [...current.rules]
      const [rule] = rules.splice(from, 1)
      if (rule) rules.splice(to, 0, rule)
      return { ...current, rules }
    })
  }

  async function apply(save: boolean) {
    if (!draft) return
    setBusy(true)
    try {
      if (save) {
        accept(await air.saveRouting(draft, revision))
        showMessage({ type: 'success', title: '分流规则已保存' })
      } else {
        setPreview(await air.previewRouting(draft))
        showMessage({ type: 'success', title: '规则预览已生成' })
      }
    } catch (error) {
      showMessage({ type: 'error', title: error instanceof Error ? error.message : String(error) })
    } finally {
      setBusy(false)
    }
  }

  async function copyPath() {
    try {
      await navigator.clipboard.writeText(path)
      showMessage({ type: 'success', title: '配置文件路径已复制' })
    } catch {
      showMessage({ type: 'warning', title: '可以选中上方的路径并复制' })
    }
  }

  return (
    <section className="air-scroll h-full overflow-y-auto px-5 py-7">
      <div className="mx-auto flex w-full max-w-[640px] flex-col gap-4">
        <header className="flex flex-col items-start gap-2.5">
          <Button
            variant="ghost"
            size="sm"
            className={bindApplication ? undefined : 'text-[14px]'}
            onClick={onBack}
          >
            <ArrowLeft data-icon="inline-start" />
            {bindApplication ? '返回链路' : '返回设置'}
          </Button>
          <h1 className="text-[24px] font-bold tracking-tight text-foreground">分流规则</h1>
        </header>

        <Card className="gap-3 p-4">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-sm font-semibold text-foreground">全局配置文件</h2>
          </div>
          {path && (
            <code className="block break-all rounded-[7px] border border-border-subtle bg-input-bg px-3 py-2 text-xs text-muted-foreground">
              {path}
            </code>
          )}
          <div className="flex items-center gap-2">
            <Button type="button" variant="secondary" size="sm" disabled={!path} onClick={() => void copyPath()}>
              <Copy data-icon="inline-start" />
              复制路径
            </Button>
            <Button type="button" variant="secondary" size="sm" disabled={busy} onClick={() => void reload(false, true)}>
              <RefreshCw data-icon="inline-start" />
              重新读取
            </Button>
          </div>
        </Card>

        {draft && (
          <Card className="p-4">
            <form
              className="flex flex-col gap-4"
              onSubmit={event => {
                event.preventDefault()
                void apply(true)
              }}
            >
              <fieldset disabled={busy} className="m-0 flex min-w-0 flex-col gap-3.5 border-0 p-0">
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div className="flex flex-col gap-1.5">
                    <Label>订阅规则来源</Label>
                    <AirSelect
                      label="订阅规则来源"
                      value={draft.subscriptionId ?? 'none'}
                      options={sourceOptions}
                      onChange={next =>
                        update(current => ({
                          ...current,
                          subscriptionId: next === 'none' ? null : next,
                          inheritRules: next !== 'none',
                        }))
                      }
                    />
                  </div>
                  <TargetField
                    label="默认出口"
                    target={draft.fallback}
                    groups={activeGroups}
                    fallback
                    onChange={fallback => update(current => ({ ...current, fallback }))}
                  />
                </div>

                <AirCheckbox
                  label="在自定义规则之后匹配该订阅的规则"
                  checked={draft.inheritRules}
                  disabled={!draft.subscriptionId}
                  onChange={inheritRules => update(current => ({ ...current, inheritRules }))}
                >
                  <span className="text-xs text-foreground">在自定义规则之后匹配该订阅的规则</span>
                </AirCheckbox>

                <Separator />

                <div className="flex items-center justify-between gap-2">
                  <div className="flex flex-col gap-0.5">
                    <h2 className="text-sm font-semibold text-foreground">自定义规则</h2>
                    <span className="text-[12px] text-muted-foreground">
                      从上到下匹配，先匹配的规则优先
                    </span>
                  </div>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={() =>
                      update(current => ({ ...current, rules: [...current.rules, newRule()] }))
                    }
                  >
                    <Plus data-icon="inline-start" />
                    添加规则
                  </Button>
                </div>

                <div className="flex flex-col gap-2.5">
                  {draft.rules.map((rule, index) => (
                    <div
                      key={index}
                      onDragOver={event => event.preventDefault()}
                      onDrop={event => {
                        event.preventDefault()
                        if (dragIndex.current !== undefined) reorder(dragIndex.current, index)
                        dragIndex.current = undefined
                      }}
                      className="flex flex-col gap-2.5 rounded-[9px] border border-border bg-muted/30 p-3"
                    >
                      <div className="flex items-center gap-2">
                        <span
                          draggable
                          onDragStart={event => {
                            dragIndex.current = index
                            event.dataTransfer.setData('text/plain', String(index))
                          }}
                          onDragEnd={() => {
                            dragIndex.current = undefined
                          }}
                          className="cursor-grab text-muted-foreground hover:text-foreground"
                        >
                          <GripVertical className="size-4" aria-hidden="true" />
                        </span>
                        <AirCheckbox
                          label={`规则 ${index + 1}`}
                          checked={rule.enabled}
                          onChange={enabled => changeRule(index, { enabled })}
                        >
                          <Badge variant="default" className="mono">
                            #{index + 1}
                          </Badge>
                        </AirCheckbox>

                        <div className="ml-auto flex items-center gap-1">
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-sm"
                            aria-label="上移"
                            disabled={index === 0}
                            onClick={() => reorder(index, index - 1)}
                          >
                            <ArrowUp />
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-sm"
                            aria-label="下移"
                            disabled={index === draft.rules.length - 1}
                            onClick={() => reorder(index, index + 1)}
                          >
                            <ArrowDown />
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-sm"
                            aria-label="删除规则"
                            onClick={() =>
                              update(current => ({
                                ...current,
                                rules: current.rules.filter((_, at) => at !== index),
                              }))
                            }
                            className="text-destructive hover:bg-danger-soft hover:text-destructive"
                          >
                            <Trash2 />
                          </Button>
                        </div>
                      </div>

                      <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_1.45fr_1fr]">
                        <div className="flex flex-col gap-1.5">
                          <Label>匹配方式</Label>
                          <AirSelect
                            label="匹配方式"
                            value={rule.matcher}
                            options={matcherOptions}
                            onChange={matcher => changeRule(index, { matcher })}
                          />
                        </div>
                        <div className="flex flex-col gap-1.5">
                          <Label>匹配值</Label>
                          <Input
                            required={rule.enabled}
                            spellCheck={false}
                            value={rule.value}
                            placeholder={
                              matcherOptions.find(item => item.value === rule.matcher)?.example
                            }
                            onChange={e => changeRule(index, { value: e.target.value })}
                          />
                        </div>
                        <TargetField
                          label="出站方式"
                          target={rule.target}
                          groups={activeGroups}
                          onChange={target => changeRule(index, { target })}
                        />
                      </div>
                    </div>
                  ))}
                </div>

                <div className="flex items-center justify-end gap-2 pt-1">
                  <Button type="button" variant="secondary" onClick={() => void apply(false)}>
                    预览规则
                  </Button>
                  <Button type="submit" variant="default">
                    保存
                  </Button>
                </div>
              </fieldset>
            </form>
          </Card>
        )}

        {preview && (
          <Card className="gap-2.5 p-4">
            <h2 className="text-sm font-semibold text-foreground">Mihomo 规则顺序</h2>
            <ol className="flex flex-col gap-1 pl-5 text-xs text-foreground">
              {preview.map((line, index) => (
                <li key={index} className="break-all">
                  <code className="text-xs text-primary">{line}</code>
                </li>
              ))}
            </ol>
          </Card>
        )}

        <p className="text-center text-[12px] text-muted-foreground">
          规则可保存和预览。系统流量接管待接入。
        </p>
      </div>
    </section>
  )
}
