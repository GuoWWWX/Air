import { tr } from '@/shared/i18n/messages'
import { Check, Layers, Plus } from 'lucide-react'
import { useEffect, useEffectEvent, useState, type FormEvent } from 'react'
import { cn } from '@/shared/lib/utils'
import { Badge } from '@/shared/ui/badge'
import { Button } from '@/shared/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/shared/ui/dialog'
import { Input } from '@/shared/ui/input'
import { Label } from '@/shared/ui/label'
import { showMessage } from '@/shared/ui/message'
import type { CustomGroup, CustomGroupInput } from '@/platform/desktop/air'

export type GroupDialogState =
  | { kind: 'none' }
  | { kind: 'create'; initialMembers: string[]; parent?: CustomGroup }
  | { kind: 'rename'; group: CustomGroup }
  | { kind: 'assign'; nodeIds: string[] }
  | { kind: 'delete'; group: CustomGroup }

interface Props {
  state: GroupDialogState
  groups: CustomGroup[]
  validNodeIds: Set<string>
  onClose: () => void
  onSaveGroup: (input: CustomGroupInput) => Promise<CustomGroup>
  onAssignExisting: (groupIds: string[], nodeIds: string[]) => Promise<void>
  onDeleteGroup: (id: string) => Promise<void>
}

export function CustomGroupDialog({
  state,
  groups,
  validNodeIds,
  onClose,
  onSaveGroup,
  onAssignExisting,
  onDeleteGroup,
}: Props) {
  const [name, setName] = useState('')
  const [selectedGroupIds, setSelectedGroupIds] = useState<string[]>([])
  const [newGroupName, setNewGroupName] = useState('')
  const [pending, setPending] = useState(false)

  const resetDraft = useEffectEvent(() => {
    setPending(false)
    if (state.kind === 'create') {
      setName('')
    } else if (state.kind === 'rename') {
      setName(state.group.name)
    } else if (state.kind === 'assign') {
      setSelectedGroupIds([])
      setNewGroupName('')
    }
  })

  useEffect(() => { resetDraft() }, [state])

  if (state.kind === 'none') return null

  async function handleSubmit(event: FormEvent) {
    event.preventDefault()
    setPending(true)
    try {
      if (state.kind === 'create') {
        if (!name.trim()) {
          showMessage({ type: 'warning', title: tr('请输入分组名称') })
          return
        }
        await onSaveGroup({
          name: name.trim(),
          members: state.initialMembers,
          parentId: state.parent?.id,
        })
        showMessage({ type: 'success', title: tr("已创建分组「{0}」", name.trim()) })
        onClose()
      } else if (state.kind === 'rename') {
        if (!name.trim()) {
          showMessage({ type: 'warning', title: tr('请输入新的分组名称') })
          return
        }
        await onSaveGroup({
          id: state.group.id,
          name: name.trim(),
        })
        showMessage({ type: 'success', title: tr('分组名称已更新') })
        onClose()
      } else if (state.kind === 'assign') {
        const extra = newGroupName.trim()
        if (!selectedGroupIds.length && !extra) {
          showMessage({ type: 'warning', title: tr('请选择至少一个分组，或输入新分组名称') })
          return
        }
        if (selectedGroupIds.length) {
          await onAssignExisting(selectedGroupIds, state.nodeIds)
        }
        if (extra) {
          await onSaveGroup({ name: extra, members: state.nodeIds })
        }
        showMessage({ type: 'success', title: tr('已加入自定义分组') })
        onClose()
      } else if (state.kind === 'delete') {
        await onDeleteGroup(state.group.id)
        showMessage({ type: 'success', title: tr("已删除分组「{0}」", state.group.name) })
        onClose()
      }
    } catch (err) {
      showMessage({ type: 'error', title: err instanceof Error ? err.message : String(err) })
    } finally {
      setPending(false)
    }
  }

  function toggleGroup(id: string) {
    setSelectedGroupIds(previous =>
      previous.includes(id) ? previous.filter(item => item !== id) : [...previous, id],
    )
  }

  return (
    <Dialog
      open
      onOpenChange={open => {
        if (!open && !pending) onClose()
      }}
    >
      <DialogContent className="max-w-[400px]" showCloseButton={!pending}>
        <form onSubmit={e => void handleSubmit(e)}>
          <DialogHeader className="flex-col items-start gap-1 pr-7">
            <DialogTitle>
              {state.kind === 'create'
                ? state.parent ? tr('新建子分组') : tr('新建自定义分组')
                : state.kind === 'rename'
                  ? tr('重命名分组')
                  : state.kind === 'assign'
                    ? tr('加入自定义分组')
                    : tr('删除自定义分组')}
            </DialogTitle>
            <DialogDescription>
              {state.kind === 'create'
                ? state.parent
                  ? tr("在「{0}」下创建子分组", state.parent.name)
                  : state.initialMembers.length > 0
                  ? tr("已选 {0} 个节点将直接加入该分组", state.initialMembers.length)
                  : tr('可归集任意订阅或自定义节点')
                : state.kind === 'rename'
                  ? tr("修改「{0}」的显示名称", state.group.name)
                  : state.kind === 'assign'
                    ? tr("为已选 {0} 个节点选择归属分组", state.nodeIds.length)
                    : groups.some(group => group.parentId === state.group.id)
                      ? tr("删除「{0}」后，子分组会移到上一级，组内节点仍然保留", state.group.name)
                      : tr("删除「{0}」后，组内节点仍然保留", state.group.name)}
            </DialogDescription>
          </DialogHeader>

          {(state.kind === 'create' || state.kind === 'rename') && (
            <div className="flex flex-col gap-2 py-2">
              <Label htmlFor="custom-group-name">{tr("分组名称")}</Label>
              <Input
                id="custom-group-name"
                autoFocus
                placeholder={tr("例如：港日低延迟、工作专线")}
                value={name}
                disabled={pending}
                onChange={event => setName(event.target.value)}
              />
            </div>
          )}

          {state.kind === 'assign' && (
            <div className="flex flex-col gap-3 py-2">
              {groups.length > 0 && (
                <div className="air-scroll flex max-h-44 flex-col gap-1.5 overflow-y-auto pr-0.5">
                  {groups.map(group => {
                    const alreadyMember = state.nodeIds.length > 0 && state.nodeIds.every(id => group.members.includes(id))
                    const active = alreadyMember || selectedGroupIds.includes(group.id)
                    return (
                      <button
                        key={group.id}
                        type="button"
                        disabled={pending || alreadyMember}
                        onClick={() => toggleGroup(group.id)}
                        className={cn(
                          'flex h-9 items-center justify-between gap-2 rounded-[8px] border px-2.5 text-left text-xs transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/60 disabled:cursor-default',
                          alreadyMember
                            ? 'border-border bg-muted/45 text-muted-foreground opacity-80'
                            : active
                              ? 'border-primary bg-accent-soft/75 font-medium text-primary'
                              : 'border-border bg-muted/55 text-foreground hover:border-accent-border dark:bg-background/60',
                        )}
                      >
                        <span className="flex min-w-0 items-center gap-2">
                          <Layers className="size-3.5 shrink-0" />
                          <span className="truncate">{group.name}</span>
                        </span>
                        <span className="flex shrink-0 items-center gap-2">
                          {alreadyMember ? (
                            <Badge variant="default" className="h-5 px-1.5 text-[11px]">{tr('已在分组中')}</Badge>
                          ) : (
                            <>
                              <span className="mono text-xs text-muted-foreground">
                                {group.members.filter(id => validNodeIds.has(id)).length}
                              </span>
                              <span
                                className={cn(
                                  'grid size-4 place-items-center rounded-[4px] border',
                                  active
                                    ? 'border-primary bg-primary text-primary-foreground'
                                    : 'border-(--checkbox-border) bg-input-bg',
                                )}
                              >
                                {active && <Check className="size-3" />}
                              </span>
                            </>
                          )}
                        </span>
                      </button>
                    )
                  })}
                </div>
              )}

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="custom-group-quick-new">
                  {groups.length ? tr('或直接新建分组并加入（可选）') : tr('新建分组名称')}
                </Label>
                <div className="relative">
                  <Plus className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    id="custom-group-quick-new"
                    autoFocus={!groups.length}
                    placeholder={tr("输入新分组名称…")}
                    value={newGroupName}
                    disabled={pending}
                    onChange={event => setNewGroupName(event.target.value)}
                    className="pl-8"
                  />
                </div>
              </div>
            </div>
          )}

          <DialogFooter className="justify-end">
            <Button type="button" variant="secondary" disabled={pending} onClick={onClose}>{tr("取消")}</Button>
            <Button
              type="submit"
              variant={state.kind === 'delete' ? 'destructive' : 'default'}
              disabled={pending}
            >
              {pending
                ? tr('处理中…')
                : state.kind === 'delete'
                  ? tr('确认删除')
                  : state.kind === 'rename'
                    ? tr('保存名称')
                    : tr('确认')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
