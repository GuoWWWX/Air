import { resolveRules } from '@/shared/proxy/rule-library'
import { RuleLibraryManager, profileYaml } from '@/shared/ui/RuleLibraryManager'
import { downloadSubscription } from '@/shared/proxy/subscription-extension'
import { GlobalRuleList, type AppIdentity } from '@/shared/ui/GlobalRuleList'
import { ruleDialog } from '@/shared/ui/RuleDialog'
import { tr } from '@/shared/i18n/messages'
import { displayPath } from '@/shared/lib/displayPath'
import {
  ArrowLeft,
  Copy,
  RefreshCw,
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Badge } from '@/shared/ui/badge'
import { Button } from '@/shared/ui/button'
import { Card } from '@/shared/ui/card'
import { Label } from '@/shared/ui/label'
import { showMessage } from '@/shared/ui/message'
import { Separator } from '@/shared/ui/separator'
import {
  air,
  type Library,
  type NodeRecord,
  type ProxyTarget,
  type RouteRule,
  type RouteTarget,
  type RoutingConfig,
  type RoutingDocument,
} from '@/platform/desktop/air'
import { AirSelect } from '../../shared/ui/AirSelect'
import { PageHeaderIcon } from '@/shared/ui/PageHeaderIcon'

interface Props {
  sources: Library['sources']
  groups: Library['groups']
  nodes: NodeRecord[]
  target: ProxyTarget
  ownerNames: Record<string, string>
  apps: AppIdentity[]
  bindApplication: boolean
  onBack: () => void
}

const matcherOptions = [
  { value: 'domain', get label() { return tr('完整域名') }, example: 'intranet.example.com' },
  { value: 'domainSuffix', get label() { return tr('域名及子域名') }, example: 'example.com' },
  { value: 'ip', get label() { return tr('IP 或网段') }, example: '10.0.0.0/8' },
  { value: 'processName', get label() { return tr('程序文件名') }, example: 'chrome.exe' },
  { value: 'processPath', get label() { return tr('程序路径') }, example: 'C:\\Program Files\\Example\\example.exe' },
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
  if (target.kind === 'group') return JSON.stringify([target.sourceId, target.name])
  if (target.kind === 'node') return `node:${target.id}`
  return target.kind
}

function routeChoices(groups: Library['groups'], nodes: NodeRecord[]) {
  const choices: { target: RouteTarget; label: string; disabled?: boolean }[] = [
    { target: { kind: 'direct' }, label: tr('直连') },
    { target: { kind: 'reject' }, label: tr('拒绝连接') },
    { target: { kind: 'selected' }, label: tr('当前代理出口') },
    { target: { kind: 'residential' }, label: tr('链式出口') },
    ...groups.map(group => ({
      target: { kind: 'group' as const, sourceId: group.sourceId, name: group.name },
      label: `${group.name} (${nodes.find(n => n.sourceId === group.sourceId)?.source ?? group.sourceId})`,
    })),
    ...nodes
      .filter(node => !node.subscriptionNotice)
      .map(node => ({
        target: { kind: 'node' as const, id: node.id },
        label: `${node.name} (${node.source})`,
      })),
  ]
  return choices
}

function TargetField({
  label,
  target,
  groups,
  nodes,
  fallback = false,
  allowSubscription = false,
  onChange,
}: {
  label: string
  target: RouteTarget
  groups: Library['groups']
  nodes: NodeRecord[]
  fallback?: boolean
  allowSubscription?: boolean
  onChange: (target: RouteTarget) => void
}) {
  const choices = routeChoices(groups, nodes)
  if (fallback && allowSubscription) {
    choices.splice(4, 0, { target: { kind: 'subscription' }, label: tr('沿用订阅默认出口') })
  }
  const value = targetKey(target)
  if (target.kind === 'subscription' && !allowSubscription) {
    choices.push({ target, label: tr('沿用订阅默认出口（未选订阅）'), disabled: true })
  } else if (target.kind === 'group' && !choices.some(choice => targetKey(choice.target) === value)) {
    choices.push({ target, label: tr("{0}（来源不可用）", target.name), disabled: true })
  } else if (target.kind === 'node' && !choices.some(choice => targetKey(choice.target) === value)) {
    choices.push({ target, label: tr('指定节点（不可用）'), disabled: true })
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

let cachedRoutingDoc: RoutingDocument | undefined

export function RoutingSettings({ sources, groups, nodes, target, apps, ownerNames, bindApplication, onBack }: Props) {
  const [draft, setDraft] = useState<RoutingConfig | undefined>(() =>
    cachedRoutingDoc
      ? (bindApplication
          ? { ...cachedRoutingDoc.routing, rules: [...cachedRoutingDoc.routing.rules, newRule(true)] }
          : cachedRoutingDoc.routing)
      : undefined,
  )
  const [path, setPath] = useState(() => (cachedRoutingDoc ? displayPath(cachedRoutingDoc.path) : ''))
  const [revision, setRevision] = useState(() => cachedRoutingDoc?.revision ?? '')
  const [busy, setBusy] = useState(false)
  const [preview, setPreview] = useState<string[]>()
  const draftRef = useRef(draft)
  const revisionRef = useRef(revision)
  const pathRef = useRef(path)
  const baselineDraftJsonRef = useRef<string | undefined>(draft ? JSON.stringify(draft) : undefined)
  const wasBoundRef = useRef(bindApplication)
  draftRef.current = draft
  revisionRef.current = revision
  pathRef.current = path

  const subscriptionSources = sources.filter(
    source => source.id !== 'custom' && source.details?.kind !== 'custom',
  )
  const automatic = target.kind !== 'routing'
  const exitId = target.kind === 'node' ? target.id : target.kind === 'chain' ? target.hops.at(-1) : undefined
  const exitSource = nodes.find(node => node.id === exitId)?.sourceId
  const groupSources = target.kind === 'group' ? new Set(nodes.filter(n => target.members.includes(n.id)).map(n => n.sourceId)) : undefined
  const source = groupSources ? (groupSources.size === 1 ? [...groupSources][0] : undefined)
    : target.kind === 'chain' && target.inheritExitRules === false ? undefined : exitSource
  const keys = target.kind === 'node' ? ['node:' + target.id, ...(target.groupId ? ['group:' + target.groupId] : [])]
    : target.kind === 'group' ? ['group:' + target.id] : target.kind === 'chain' && target.id ? ['chain:' + target.id] : []
  if (source) keys.push('subscription:' + source)
  const reference = resolveRules(draft?.ruleLibrary, keys, source ?? (target.kind === 'routing' ? draft?.subscriptionId ?? undefined : undefined))
  const sourceName = subscriptionSources.find(item => 'subscription:' + item.id === reference)?.name
    ?? draft?.ruleLibrary?.sets.find(item => 'user:' + item.id === reference)?.name
  useEffect(() => { setPreview(undefined) }, [automatic, exitId, reference])

  function accept(document: RoutingDocument) {
    cachedRoutingDoc = document
    baselineDraftJsonRef.current = JSON.stringify(document.routing)
    setDraft(document.routing)
    setPath(displayPath(document.path))
    setRevision(document.revision)
    setPreview(undefined)
  }

  async function reload(bind = false, manual = false) {
    setBusy(true)
    try {
      const document = await air.routingSettings()
      accept(document)
      if (bind) {
        const boundDraft = { ...document.routing, rules: [...document.routing.rules, newRule(true)] }
        setDraft(boundDraft)
      } else {
        await air.previewRouting(document.routing, target)
      }
      if (manual) showMessage({ type: 'success', title: tr('分流规则已重新读取') })
    } catch (error) {
      showMessage({ type: 'error', title: error instanceof Error ? error.message : String(error) })
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    const justBound = !wasBoundRef.current && bindApplication
    wasBoundRef.current = bindApplication
    if (!cachedRoutingDoc) {
      void air.routingPath().then(nextPath => setPath(displayPath(nextPath))).catch(error => showMessage({ type: 'error', title: error instanceof Error ? error.message : String(error) }))
      void reload(bindApplication)
      return
    }
    let active = true
    void air.routingSettings().then(
      document => {
        cachedRoutingDoc = document
        if (!active) return
        const nextPath = displayPath(document.path)
        const untouched = !draftRef.current || JSON.stringify(draftRef.current) === baselineDraftJsonRef.current
        if (untouched && (document.revision !== revisionRef.current || justBound)) {
          accept(document)
          if (bindApplication) {
            const boundDraft = { ...document.routing, rules: [...document.routing.rules, newRule(true)] }
            setDraft(boundDraft)
          }
          return
        }
        if (nextPath !== pathRef.current) setPath(nextPath)
      },
      () => undefined,
    )
    return () => { active = false }
  }, [bindApplication])

  function update(change: (current: RoutingConfig) => RoutingConfig) {
    setDraft(current => (current ? change(current) : current))
    setPreview(undefined)
  }

  const dirty = Boolean(
    draft && baselineDraftJsonRef.current && JSON.stringify(draft) !== baselineDraftJsonRef.current,
  )

  async function apply(save: boolean) {
    if (!draft) return
    setBusy(true)
    try {
      if (save) {
        accept(await air.saveRouting(draft, revision, target))
        showMessage({ type: 'success', title: tr('分流规则已保存') })
      } else {
        setPreview(await air.previewRouting(draft, target))
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
      showMessage({ type: 'success', title: tr('配置文件路径已复制') })
    } catch {
      showMessage({ type: 'warning', title: tr('可以选中上方的路径并复制') })
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
            {bindApplication ? tr('返回链路') : tr('返回设置')}
          </Button>
          <div className="flex items-center gap-2.5">
            <PageHeaderIcon kind="routing" size="subpage" />
            <h1 className="text-[24px] font-bold tracking-tight text-foreground">{tr("分流规则")}</h1>
          </div>
        </header>

        <Card className="gap-3 p-4">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-sm font-semibold text-foreground">{tr("全局配置文件")}</h2>
          </div>
          {path && (
            <code className="block break-all rounded-[7px] border border-border bg-muted/55 px-3 py-2 text-xs text-muted-foreground dark:bg-input-bg">
              {path}
            </code>
          )}
          <div className="flex items-center gap-2">
            <Button type="button" variant="secondary" size="sm" disabled={!path} onClick={() => void copyPath()}>
              <Copy data-icon="inline-start" />{tr("复制路径")}</Button>
            <Button type="button" variant="secondary" size="sm" disabled={busy} onClick={() => void reload(false, true)}>
              <RefreshCw data-icon="inline-start" />{tr("重新读取")}</Button>
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
                <div className="flex flex-col gap-1.5">
                  <Label>{tr("订阅规则来源")}</Label>
                  <span className="text-sm">{target.kind === 'group' || target.kind === 'chain' ? target.name : nodes.find(node => node.id === exitId)?.name ?? tr('当前代理出口')} → {sourceName ?? tr('无')}</span>
                </div>
                <RuleLibraryManager catalog={draft.ruleLibrary} owners={ownerNames} overlay={ruleDialog} exportYaml={downloadSubscription}
                  sources={subscriptionSources.map(s => ({ id:s.id,name:s.name,updated:s.details?.updatedAt,
                    read:async () => profileYaml(await air.subscriptionYaml(s.id, false)) }))}
                  save={async ruleLibrary => { accept(await air.saveRouting({ ...draft, ruleLibrary }, revision, target)); return true }} />
                <TargetField label={tr("默认出口")} target={draft.matchFallback ?? (automatic ? { kind: 'subscription' } : draft.fallback)}
                  groups={groups} nodes={nodes} fallback allowSubscription
                  onChange={value => update(current => ({ ...current, matchFallback: value,
                    fallback: !automatic && value.kind !== 'subscription' ? value : current.fallback }))} />
                <Separator />

                <GlobalRuleList<RouteRule> rules={draft.rules} matchers={matcherOptions} apps={apps}
                  targets={routeChoices(groups, nodes)} newRule={() => newRule(bindApplication)} overlay={ruleDialog}
                  save={async rules => {
                    const document = await air.saveRouting({ ...draft, rules }, revision, target)
                    accept(document)
                    showMessage({ type: 'success', title: tr('分流规则已保存') })
                    return true
                  }} />

                <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
                  {dirty && <Badge variant="warning" className="mr-auto">{tr('有未保存修改')}</Badge>}
                  <Button type="button" variant="secondary" onClick={() => void apply(false)}>{tr("预览规则")}</Button>
                  <Button type="submit" variant="default">{tr("保存")}</Button>
                </div>
              </fieldset>
            </form>
          </Card>
        )}

        {preview && (
          <Card className="gap-2.5 p-4">
            <h2 className="text-sm font-semibold text-foreground">{tr("Mihomo 规则顺序")}</h2>
            <p className="text-xs text-muted-foreground">{tr('全局规则 → 基础网络保障 → {0} → 默认出口', sourceName ?? tr('国内直连兜底'))}</p>
            <ol className="flex flex-col gap-1 pl-5 text-xs text-foreground">
              {preview.map((line, index) => (
                <li key={index} className="break-all">
                  <code className="text-xs text-primary">{line}</code>
                </li>
              ))}
            </ol>
          </Card>
        )}

        <p className="text-center text-[12px] text-muted-foreground">{tr("规则保存并启用后生效；新建连接将按以上顺序从上到下匹配出口。")}</p>
      </div>
    </section>
  )
}
