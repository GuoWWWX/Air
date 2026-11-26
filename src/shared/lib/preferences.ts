type Values = Record<string, string>
const journal = 'air.pendingPreferences.v1'
let values: Values | undefined
let persist: ((state: Values) => Promise<unknown>) | undefined
let writing = false

// Changes survive a window closing between a UI event and its native acknowledgement.
async function flush() {
  if (writing || !persist || !values) return
  writing = true
  try {
    for (;;) {
      const snapshot: Values = values
      await persist(snapshot)
      if (values === snapshot) {
        localStorage.removeItem(journal)
        return
      }
    }
  } catch (error) {
    console.warn('Could not save interface preferences', error)
  } finally {
    writing = false
  }
}

export async function loadPreferences(read: () => Promise<Values | null>, write: (state: Values) => Promise<unknown>) {
  const saved = await read()
  const pending = localStorage.getItem(journal)
  const legacyKeys = ['chains', 'activeChainId', 'chainDraft', 'preferredNodeId', 'theme', 'sidebarCollapsed',
    'checkedNodeIds', 'kernelPath', 'backgroundMonitoring', 'nodeCardDensity', 'nodeTreeCollapsed',
    'subscription-order.v1', 'subscriptionListWidth', 'nodeTreeWidth'].map(key => 'air.' + key)
    .filter(key => localStorage.getItem(key) !== null)
  values = pending ? JSON.parse(pending) as Values : saved ?? Object.fromEntries(legacyKeys.map(key => [key, localStorage.getItem(key)!]))
  persist = write
  if (pending || !saved) {
    await write(values!)
    localStorage.removeItem(journal)
  }
  for (const key of legacyKeys) localStorage.removeItem(key)
}

function change(key: string, value: string | null) {
  if (!values) {
    if (value === null) localStorage.removeItem(key)
    else localStorage.setItem(key, value)
    return
  }
  if ((values[key] ?? null) === value) return
  const next = { ...values }
  if (value === null) delete next[key]
  else next[key] = value
  localStorage.setItem(journal, JSON.stringify(next))
  values = next
  void flush()
}

export const preferences = {
  getItem: (key: string) => values ? values[key] ?? null : localStorage.getItem(key),
  setItem: (key: string, value: string) => change(key, value),
  removeItem: (key: string) => change(key, null),
}

export const highSpeedProbe = {
  get: () => preferences.getItem('air.highSpeedProbe') === '1',
  set: (enabled: boolean) => preferences.setItem('air.highSpeedProbe', enabled ? '1' : '0'),
}
