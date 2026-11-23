import { tr } from '@/shared/i18n/messages'
import { Check, Network, ShieldAlert, Trash2, X, Zap } from 'lucide-react'
import { useEffect, useState, type FormEvent } from 'react'
import { cn } from '@/shared/lib/utils'
import { Button } from '@/shared/ui/button'
import { Input } from '@/shared/ui/input'
import { Label } from '@/shared/ui/label'
import { Segmented } from '@/shared/ui/segmented'
import { Separator } from '@/shared/ui/separator'
import { showMessage } from '@/shared/ui/message'
import { air, type CustomNodeInput, type CustomProtocol } from '@/platform/desktop/air'

interface Props {
  nodeId?: string
  groupName?: string
  kernelPath: string
  onClose: () => void
  onSaved: (id: string) => Promise<void> | void
  onDeleted: (id: string) => Promise<void> | void
  onSettings: () => void
  onError: (error: unknown) => void
}

const protocols: readonly { value: CustomProtocol; label: string }[] = [
  { value: 'http', label: 'HTTP' },
  { value: 'https', label: 'HTTPS' },
  { value: 'socks5', label: 'SOCKS5' },
]

export function CustomNodeInspector({
  nodeId,
  groupName,
  kernelPath,
  onClose,
  onSaved,
  onDeleted,
  onSettings,
  onError,
}: Props) {
  const [name, setName] = useState('')
  const [protocol, setProtocol] = useState<CustomProtocol>('http')
  const [server, setServer] = useState('')
  const [port, setPort] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(Boolean(nodeId))
  const [testing, setTesting] = useState(false)
  const [saving, setSaving] = useState(false)
  const [pendingGroupNodeId, setPendingGroupNodeId] = useState<string>()
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string }>()

  useEffect(() => {
    let cancelled = false
    if (!nodeId) {
      setName('')
      setProtocol('http')
      setServer('')
      setPort('')
      setUsername('')
      setPassword('')
      setTestResult(undefined)
      setLoading(false)
      return
    }
    setLoading(true)
    setTestResult(undefined)
    void air
      .customNode(nodeId)
      .then(data => {
        if (cancelled) return
        setName(data.name)
        setProtocol(data.protocol)
        setServer(data.server)
        setPort(String(data.port))
        setUsername(data.username)
        setPassword(data.password)
      })
      .catch(error => {
        if (!cancelled) onError(error)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [nodeId, onError])

  function buildPayload(): CustomNodeInput | null {
    const parsedPort = Number(port)
    if (
      !name.trim() ||
      !server.trim() ||
      !Number.isInteger(parsedPort) ||
      parsedPort < 1 ||
      parsedPort > 65535
    ) {
      onError(tr('请填写节点名称、服务器地址和有效端口（1–65535）'))
      return null
    }
    return {
      id: nodeId,
      name: name.trim(),
      protocol,
      server: server.trim(),
      port: parsedPort,
      username,
      password,
    }
  }

  async function runTest() {
    if (!kernelPath) {
      onError(tr('测速需要 Mihomo 诊断内核。请在下方设置内核路径，保存后再测速。'))
      onSettings()
      return
    }
    const payload = buildPayload()
    if (!payload) return
    setTesting(true)
    setTestResult(undefined)
    try {
      const ms = await air.testCustomNode(kernelPath, payload)
      setTestResult({ ok: true, text: tr("连接测试通过 · {0} ms", ms) })
      showMessage({ type: 'success', title: tr("连接测试通过 · {0} ms", ms) })
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      setTestResult({ ok: false, text: reason })
      showMessage({ type: 'error', title: tr('连接测试失败'), description: reason })
    } finally {
      setTesting(false)
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    setSaving(true)
    let savedId = pendingGroupNodeId
    try {
      if (!savedId) {
        const payload = buildPayload()
        if (!payload) return
        savedId = await air.saveCustomNode(payload)
      }
      await onSaved(savedId)
      showMessage({ type: 'success', title: nodeId ? tr('节点已保存') : tr('自定义节点已添加') })
    } catch (error) {
      if (savedId) {
        setPendingGroupNodeId(savedId)
        onError(tr("节点已保存，加入分组失败（{0}）", error instanceof Error ? error.message : String(error)))
      } else {
        onError(error)
      }
    } finally {
      setSaving(false)
    }
  }

  async function remove() {
    if (!nodeId) return
    setSaving(true)
    try {
      await air.deleteCustomNode(nodeId)
      await onDeleted(nodeId)
      showMessage({ type: 'success', title: tr('自定义节点已删除') })
    } catch (error) {
      onError(error)
    } finally {
      setSaving(false)
    }
  }

  const busy = loading || testing || saving
  const inputsDisabled = loading || saving || Boolean(pendingGroupNodeId)

  return (
    <form
      onSubmit={event => void submit(event)}
      className="flex h-full min-h-0 flex-col rounded-[11px] border border-border bg-card shadow-(--shadow-drawer)"
    >
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-4 py-3">
        <div className="flex items-center gap-2">
          <span className="grid size-6.5 place-items-center rounded-[6px] bg-accent-soft text-primary">
            <Network className="size-3.5" />
          </span>
          <h2 className="text-sm font-semibold text-foreground">
            {nodeId ? tr('编辑自定义节点') : groupName ? tr('在分组中新建节点') : tr('添加自定义节点')}
          </h2>
        </div>
        <Button type="button" variant="ghost" size="icon-sm" aria-label={tr("关闭自定义节点")} onClick={onClose}>
          <X />
        </Button>
      </div>

      <div className="air-scroll flex min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto px-4 py-3.5">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="custom-node-name">{tr("名称")}</Label>
          <Input
            id="custom-node-name"
            required
            disabled={inputsDisabled}
            maxLength={150}
            placeholder={tr("例如 美国住宅 / 自建中转")}
            value={name}
            onChange={e => {
              setName(e.target.value)
              setTestResult(undefined)
            }}
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <Label>{tr("代理协议")}</Label>
          <Segmented
            layoutId="custom-node-protocol"
            ariaLabel={tr("代理协议")}
            value={protocol}
            options={protocols}
            fullWidth
            disabled={inputsDisabled}
            onChange={next => {
              setProtocol(next)
              setTestResult(undefined)
            }}
          />
        </div>

        <div className="grid grid-cols-[minmax(0,1fr)_88px] gap-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="custom-node-server">{tr("服务器地址")}</Label>
            <Input
              id="custom-node-server"
              required
              disabled={inputsDisabled}
              spellCheck={false}
              placeholder="example.com"
              className="mono"
              value={server}
              onChange={e => {
                setServer(e.target.value)
                setTestResult(undefined)
              }}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="custom-node-port">{tr("端口")}</Label>
            <Input
              id="custom-node-port"
              required
              disabled={inputsDisabled}
              inputMode="numeric"
              placeholder="1080"
              className="mono"
              value={port}
              onChange={e => {
                setPort(e.target.value.replace(/\D+/g, ''))
                setTestResult(undefined)
              }}
            />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="custom-node-username">{tr("用户名（可选）")}</Label>
            <Input
              id="custom-node-username"
              disabled={inputsDisabled}
              autoComplete="off"
              placeholder={tr("选填")}
              value={username}
              onChange={e => {
                setUsername(e.target.value)
                setTestResult(undefined)
              }}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="custom-node-password">{tr("密码（可选）")}</Label>
            <Input
              id="custom-node-password"
              type="password"
              disabled={inputsDisabled}
              autoComplete="off"
              placeholder={tr("选填")}
              value={password}
              onChange={e => {
                setPassword(e.target.value)
                setTestResult(undefined)
              }}
            />
          </div>
        </div>

        <Separator />

        <div className="flex items-center justify-between gap-2 rounded-[8px] border border-border bg-muted/55 px-3 py-2 dark:bg-background/60">
          <span className="min-w-0 break-words text-[12px] text-muted-foreground">
            {groupName ? tr("保存后加入「{0}」", groupName) : tr('保存至节点库 · 可用于任意一跳')}
          </span>
          <Button type="button" variant="secondary" size="sm" className="shrink-0" disabled={busy || Boolean(pendingGroupNodeId)} onClick={() => void runTest()}>
            <Zap data-icon="inline-start" />
            {testing ? tr('测试中…') : tr('测试连接')}
          </Button>
        </div>

        {testResult && (
          <div
            role="status"
            className={cn(
              'flex items-center gap-2 rounded-[8px] border px-3 py-2 text-xs',
              testResult.ok
                ? 'border-success/30 bg-success-soft text-success'
                : 'border-destructive/30 bg-danger-soft text-destructive',
            )}
          >
            {testResult.ok ? (
              <Check className="size-4 shrink-0" />
            ) : (
              <ShieldAlert className="size-4 shrink-0" />
            )}
            <span className="min-w-0 flex-1 break-words">{testResult.text}</span>
          </div>
        )}
      </div>

      <div className="flex shrink-0 items-center justify-between gap-2 border-t border-border px-4 py-3">
        <div>
          {nodeId && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => void remove()}
              className="text-destructive hover:bg-danger-soft hover:text-destructive"
            >
              <Trash2 data-icon="inline-start" />{tr("删除")}</Button>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button type="button" variant="secondary" size="sm" disabled={saving} onClick={onClose}>{tr("取消")}</Button>
          <Button type="submit" variant="default" size="sm" disabled={busy}>
            {saving ? tr('保存中…') : pendingGroupNodeId ? tr('重试加入分组') : tr('保存节点')}
          </Button>
        </div>
      </div>
    </form>
  )
}
