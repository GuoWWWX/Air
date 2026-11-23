import { tr } from '@/shared/i18n/messages'
import type { QuickJSWASMModule } from 'quickjs-emscripten-core'
import { parseDocument, stringify } from 'yaml'

export interface SubscriptionExtension { script: string; rules: string[] }
export const emptyExtension: SubscriptionExtension = { script: '', rules: [] }

let engine: Promise<QuickJSWASMModule> | undefined

function extensionEngine() {
  return engine ??= Promise.all([
    import('quickjs-emscripten-core'),
    import('@jitl/quickjs-wasmfile-release-sync'),
  ]).then(([core, variant]) => core.newQuickJSWASMModuleFromVariant(variant.default))
}

export async function extendSubscription(yaml: string, extension?: SubscriptionExtension) {
  if (!extension || (!extension.script.trim() && !extension.rules.length)) return yaml
  const doc = parseDocument(yaml)
  if (doc.errors.length) throw new Error(tr('订阅 YAML 无效'))
  let config = doc.toJS({ maxAliasCount: 50 })
  if (extension.script.trim()) {
    const runtime = (await extensionEngine()).newRuntime()
    runtime.setMemoryLimit(64 * 1024 * 1024)
    runtime.setMaxStackSize(512 * 1024)
    const deadline = Date.now() + 1000
    runtime.setInterruptHandler(() => Date.now() >= deadline)
    const vm = runtime.newContext()
    try {
      const input = vm.newString(JSON.stringify(config))
      vm.setProp(vm.global, '__airInput', input)
      input.dispose()
      const result = vm.evalCode(extension.script + '\n;JSON.stringify(main(JSON.parse(__airInput)))')
      if (result.error) {
        result.error.dispose()
        throw new Error(tr('扩展脚本执行失败，请检查 main(config) 的返回值、执行时间或内存用量'))
      }
      try { config = JSON.parse(vm.getString(result.value)) }
      finally { result.value.dispose() }
    } finally { vm.dispose(); runtime.dispose() }
  }
  if (!config || !Array.isArray(config.proxies) || !config.proxies.length) throw new Error(tr('扩展结果缺少订阅节点'))
  if (extension.rules.some(rule => !rule.includes(','))) throw new Error(tr('附加规则格式无效'))
  if (extension.rules.length) config.rules = [...extension.rules, ...(Array.isArray(config.rules) ? config.rules : [])]
  return stringify(config)
}

export function downloadSubscription(name: string, yaml: string) {
  const url = URL.createObjectURL(new Blob([yaml], { type: 'application/yaml' }))
  const link = document.createElement('a')
  link.href = url
  link.download = name.replace(/[<>:"/\\|?*]/g, '_').replace(/\.ya?ml$/i, '') + '.yaml'
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
