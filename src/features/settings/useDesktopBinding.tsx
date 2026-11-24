import { useEffect, useState } from 'react'
import { air, type ProxyTarget, type RoutingDocument } from '@/platform/desktop/air'
import { objectKey, setBinding, type ObjectKind } from '@/shared/proxy/rule-library'
import { RuleBindingPicker, type RuleSourceOption } from '@/shared/ui/RuleLibraryManager'
import { tr } from '@/shared/i18n/messages'
import { showMessage } from '@/shared/ui/message'

export function useDesktopBinding(kind: ObjectKind, id?: string, active = true, target?: ProxyTarget) {
  const [loaded, setLoaded] = useState<{ document: RoutingDocument; sources: RuleSourceOption[]; owner: string }>()
  const [draft, setDraft] = useState<string>()
  const owner = objectKey(kind, id ?? '')
  useEffect(() => {
    let live = true
    setLoaded(undefined); setDraft(undefined)
    if (active) void Promise.all([air.routingSettings(), air.library()]).then(([document, library]) => {
      if (live) setLoaded({ document, sources: library.sources, owner })
    }).catch(error => { if (live) showMessage({ type: 'error', title: String(error) }) })
    return () => { live = false }
  }, [owner, active])
  const catalog = loaded?.document.routing.ruleLibrary
  const initial = catalog?.bindings[owner] ?? ''
  const dirty = draft !== undefined && draft !== initial
  async function save(savedId: string) {
    if (draft === undefined || draft === initial) return
    const key = objectKey(kind, savedId)
    const latest = await air.routingSettings()
    if ((latest.routing.ruleLibrary?.bindings[key] ?? '') !== initial) throw new Error(tr('规则已变更，请重新打开'))
    const lib = setBinding(latest.routing.ruleLibrary, key, draft)
    const document = await air.saveRouting({ ...latest.routing, ruleLibrary: lib }, latest.revision, target)
    setLoaded(old => old && { ...old, document }); setDraft(undefined)
  }
  async function reset(savedId: string) {
    const key = objectKey(kind, savedId)
    const latest = await air.routingSettings()
    if (latest.routing.ruleLibrary?.bindings[key]) {
      const lib = setBinding(latest.routing.ruleLibrary, key, '')
      const document = await air.saveRouting({ ...latest.routing, ruleLibrary: lib }, latest.revision, target)
      setLoaded(old => old && { ...old, document })
    }
    setDraft(undefined)
  }
  return {
    dirty,
    save,
    reset,
    field: <RuleBindingPicker sources={loaded?.sources ?? []} catalog={catalog} value={draft ?? initial}
      disabled={loaded?.owner !== owner} change={setDraft} />,
  }
}
