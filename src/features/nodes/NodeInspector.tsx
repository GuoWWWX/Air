import { useDesktopBinding } from '@/features/settings/useDesktopBinding'
import { tr } from '@/shared/i18n/messages'
import { FileCode2, Network, RotateCcw, X } from 'lucide-react'
import { useEffect, useState, type FormEvent } from 'react'
import { formatProtocol } from '@/shared/lib/utils'
import { Badge } from '@/shared/ui/badge'
import { Button } from '@/shared/ui/button'
import { FlagText } from '@/shared/ui/FlagText'
import { Input } from '@/shared/ui/input'
import { Label } from '@/shared/ui/label'
import { Separator } from '@/shared/ui/separator'
import { showMessage } from '@/shared/ui/message'
import { air, type NodeRecord } from '@/platform/desktop/air'

interface Props {
  node: NodeRecord
  onClose: () => void
  onSaved: () => void
  onYaml: (sourceId: string) => void
  onError: (error: unknown) => void
  embedded?: boolean
}

export function NodeInspector({ node, onClose, onSaved, onYaml, onError, embedded }: Props) {
  const binding = useDesktopBinding('node', node.id)
  const [name, setName] = useState(node.name)
  const [server, setServer] = useState(node.server)
  const [port, setPort] = useState(String(node.port))
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    setName(node.name)
    setServer(node.server)
    setPort(String(node.port))
  }, [node.id, node.name, node.server, node.port])

  async function save(reset = false) {
    setBusy(true)
    try {
      if (reset) await air.resetNode(node.id)
      else await air.editNode({ id: node.id, name, server, port: Number(port) })
      if (!reset) await binding.save(node.id)
      showMessage({ type: 'success', title: reset ? tr('已恢复订阅值') : tr('节点覆写已保存') })
      onSaved()
    } catch (error) {
      onError(error)
    } finally {
      setBusy(false)
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault()
    if (
      !name.trim() ||
      !server.trim() ||
      !Number.isInteger(Number(port)) ||
      Number(port) < 1 ||
      Number(port) > 65535
    ) {
      onError(tr('请输入节点名称、服务器地址和有效端口'))
      return
    }
    void save()
  }

  return (
    <form
      onSubmit={submit}
      className={
        embedded
          ? 'flex h-full min-h-0 flex-col bg-transparent'
          : 'flex h-full min-h-0 flex-col rounded-[11px] border border-border bg-card shadow-(--shadow-drawer)'
      }
    >
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-4 py-3">
        <h2 className="text-sm font-semibold text-foreground">{tr("编辑节点")}</h2>
        <Button type="button" variant="ghost" size="icon-sm" aria-label={tr("关闭编辑节点")} onClick={onClose}>
          <X />
        </Button>
      </div>

      <div className="air-scroll flex min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto px-4 py-3.5">
        <div className="flex items-center gap-2.5 rounded-[9px] border border-border bg-muted/55 p-3 dark:bg-background/60">
          <span className="grid size-8 shrink-0 place-items-center rounded-[7px] bg-accent-soft text-primary">
            <Network className="size-4" />
          </span>
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <strong className="truncate text-xs font-semibold text-foreground">
              <FlagText text={node.name} />
            </strong>
            <span className="truncate text-[12px] text-muted-foreground">
              <FlagText text={`${node.source} · ${formatProtocol(node.protocol)}`} />
            </span>
          </div>
          <Badge variant="accent">{tr("本地覆写")}</Badge>
        </div>

        <div className="flex flex-col gap-1.5">
          {binding.field}
          <Label htmlFor="node-edit-name">{tr("显示名称")}</Label>
          <Input
            id="node-edit-name"
            required
            maxLength={150}
            value={name}
            onChange={e => setName(e.target.value)}
          />
        </div>

        <div className="grid grid-cols-[minmax(0,1fr)_88px] gap-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="node-edit-server">{tr("服务器地址")}</Label>
            <Input
              id="node-edit-server"
              required
              spellCheck={false}
              className="mono"
              value={server}
              onChange={e => setServer(e.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="node-edit-port">{tr("端口")}</Label>
            <Input
              id="node-edit-port"
              required
              inputMode="numeric"
              className="mono"
              value={port}
              onChange={e => setPort(e.target.value)}
            />
          </div>
        </div>

        <Separator />

        <div className="flex items-center justify-between gap-2 rounded-[8px] border border-border bg-muted/55 px-3 py-2 dark:bg-background/60">
          <span className="text-xs text-muted-foreground">{tr("协议参数")}</span>
          <Button type="button" variant="secondary" size="sm" onClick={() => onYaml(node.sourceId)}>
            <FileCode2 data-icon="inline-start" />{tr("编辑 YAML")}</Button>
        </div>

        <p className="text-[12px] text-muted-foreground">{tr("订阅刷新后，将保留此处保存的有效修改。")}</p>
      </div>

      <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-border px-4 py-3">
        <Button type="button" variant="secondary" size="sm" disabled={busy} onClick={() => void save(true)}>
          <RotateCcw data-icon="inline-start" />{tr("恢复订阅值")}</Button>
        <Button type="submit" variant="default" size="sm" disabled={busy}>{tr("保存覆写")}</Button>
      </div>
    </form>
  )
}
