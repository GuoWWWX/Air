import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { Activity, Camera, Check, ClipboardPaste, Code2, FileCode2, FileUp, Image as ImageIcon, Link, Plus, QrCode, Save, Trash2, Waypoints } from 'lucide-react'
import { EditorState } from '@codemirror/state'
import { EditorView, highlightActiveLine, keymap, lineNumbers } from '@codemirror/view'
import { defaultKeymap } from '@codemirror/commands'
import { defaultHighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { yaml } from '@codemirror/lang-yaml'
import jsQR from 'jsqr'
import { AirSelect } from '@/shared/ui/AirSelect'
import { Button } from '@/shared/ui/button'
import { Segmented } from '@/shared/ui/segmented'
import { showMessage } from '@/shared/ui/message'
import { CopySubscriptionLink } from '@/shared/ui/CopySubscriptionLink'
import { copySubscriptionText, native, onAndroid } from './bridge'
import { id, membersOf, protocol, yamlProfile, type Chain, type Group, type Library, type Node, type Policy, type Proxy, type Subscription } from './model'
import { Tag } from './ui'
import { policyLabels, type Model } from './views'

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error)

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="field"><span>{label}</span>{children}</label>
}

type PickedFile = { name: string; text?: string; image?: string } | null

export interface SubscriptionImportRequest {
  source?: Subscription
  kind: 'url' | 'file'
  url?: string
  name: string
  file?: { name: string; text: string }
}

export function ImportView({ source, sources, onStartImport }: {
  source?: Subscription
  sources: Subscription[]
  onStartImport: (request: SubscriptionImportRequest) => void
}) {
  const [kind, setKind] = useState<'url' | 'file' | 'qr'>(source?.url || !source ? 'url' : 'file')
  const [address, setAddress] = useState(source?.url ?? '')
  const [name, setName] = useState(source?.name ?? '')
  const [file, setFile] = useState<PickedFile>()
  const [scanning, setScanning] = useState(false)
  const local = useRef<HTMLInputElement>(null)

  async function fromQr(image: string) {
    const picture = new window.Image()
    picture.src = image
    await picture.decode()
    const ratio = Math.min(1, 1440 / Math.max(picture.width, picture.height))
    const canvas = document.createElement('canvas')
    canvas.width = Math.ceil(picture.width * ratio)
    canvas.height = Math.ceil(picture.height * ratio)
    const ctx = canvas.getContext('2d')!
    ctx.drawImage(picture, 0, 0, canvas.width, canvas.height)
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height)
    const value = jsQR(data.data, data.width, data.height)?.data
    if (!value) throw new Error('图片中没有识别到二维码')
    acceptQr(value)
  }

  function acceptQr(value: string) {
    setScanning(false)
    if (!value.trim().startsWith('https://')) {
      showMessage({ type: 'error', title: '二维码中没有有效的 HTTPS 订阅链接' })
      return
    }
    setAddress(value.trim())
    setKind('url')
    showMessage({ type: 'success', title: '已识别订阅链接' })
  }

  async function openFile(image: boolean) {
    if (!onAndroid) { local.current?.click(); return }
    try {
      const result = await native<PickedFile>('file', { type: image ? 'qr' : 'yaml' })
      if (result?.image) await fromQr(result.image)
      else if (result) setFile(result)
    } catch (e) {
      showMessage({ type: 'error', title: errorText(e) })
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault()
    try {
      const url = kind === 'url' ? new URL(address.trim()).href : undefined
      if (url && !url.startsWith('https://')) throw new Error('请输入 HTTPS 订阅链接')
      const picked = kind === 'file' ? file : undefined
      if (kind === 'file' && !picked?.text && !source) throw new Error('请先选择本地 YAML 文件')
      const existing = url ? sources.find(item => item.url === url && item.id !== source?.id) : undefined
      if (source && existing && url !== source.url) throw new Error('这个链接已用于另一条订阅')

      onStartImport({
        source,
        kind: kind === 'file' ? 'file' : 'url',
        url,
        name,
        file: picked?.text !== undefined ? { name: picked.name, text: picked.text } : undefined,
      })
    } catch (e) {
      showMessage({ type: 'error', title: errorText(e) })
    }
  }

  return <form className="page-form" onSubmit={submit}>
    <div className="page-scroll">
      <Segmented layoutId="android-import-mode" ariaLabel="导入方式" size="md" fullWidth
        value={kind} onChange={tab => { setKind(tab); setScanning(false) }}
        options={[{ value: 'url', icon: <Link />, label: 'URL 链接' }, { value: 'file', icon: <FileUp />, label: '本地文件' }, { value: 'qr', icon: <QrCode />, label: '二维码' }]} />
      {kind === 'url' && <Field label="订阅链接"><div className="input-action">
        <input type="url" inputMode="url" placeholder="粘贴 HTTPS 订阅链接" value={address} required onChange={e => setAddress(e.target.value)} />
        <CopySubscriptionLink url={address} write={copySubscriptionText} onError={msg => showMessage({ type: 'error', title: msg })} />
        <Button type="button" variant="ghost" size="icon" aria-label="粘贴订阅链接" onClick={() => {
          const text = onAndroid ? native<string>('paste') : navigator.clipboard.readText()
          void text.then(value => setAddress(value.trim())).catch(() => showMessage({ type: 'warning', title: '可长按输入框粘贴链接' }))
        }}><ClipboardPaste /></Button>
      </div></Field>}
      {kind === 'file' && <div className="file-picker"><FileCode2 size={27} /><b>{file?.name || '选择 Clash YAML'}</b><Button type="button" variant="outline" onClick={() => void openFile(false)}>选择文件</Button></div>}
      {kind === 'qr' && <div className="file-picker">
        {scanning ? <CameraScanner onValue={acceptQr} onError={message => { setScanning(false); showMessage({ type: 'error', title: message }) }} /> : <QrCode size={32} />}
        <div className="flex flex-wrap justify-center gap-2">
          <Button type="button" variant="outline" onClick={() => setScanning(!scanning)}><Camera />{scanning ? '关闭相机' : '扫码'}</Button>
          <Button type="button" variant="outline" onClick={() => void openFile(true)}><ImageIcon />选择图片</Button>
        </div>
      </div>}
      <input ref={local} type="file" className="sr-only" tabIndex={-1} accept={kind === 'qr' ? 'image/*' : '.yaml,.yml'} onChange={e => {
        const selected = e.target.files?.[0]
        if (!selected) return
        if (kind === 'qr') {
          const url = URL.createObjectURL(selected)
          void fromQr(url).catch(err => showMessage({ type: 'error', title: errorText(err) })).finally(() => URL.revokeObjectURL(url))
        } else void selected.text().then(text => setFile({ name: selected.name, text })).catch(err => showMessage({ type: 'error', title: errorText(err) }))
      }} />
      <Field label="名称（选填）"><input value={name} placeholder="使用订阅提供的名称或本地文件名" onChange={e => setName(e.target.value)} /></Field>
    </div>
    <footer className="page-action"><Button type="submit" variant="default" disabled={kind === 'qr' || (kind === 'file' && !file && !source)} className="w-full justify-center">
      {source ? <Check data-icon="inline-start" /> : <FileUp data-icon="inline-start" />}
      {source ? '保存订阅' : '导入订阅'}
    </Button></footer>
  </form>
}

function CameraScanner({ onValue, onError }: { onValue: (value: string) => void; onError: (reason: string) => void }) {
  const video = useRef<HTMLVideoElement>(null)
  const callbacks = useRef({ onValue, onError })
  callbacks.current = { onValue, onError }
  useEffect(() => {
    let disposed = false
    let stream: MediaStream | undefined
    let timer = 0
    const canvas = document.createElement('canvas')
    void (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false })
        if (disposed || !video.current) { stream.getTracks().forEach(track => track.stop()); return }
        video.current.srcObject = stream
        await video.current.play()
        timer = window.setInterval(() => {
          const frame = video.current
          if (!frame?.videoWidth) return
          canvas.width = Math.min(640, frame.videoWidth)
          canvas.height = Math.round(canvas.width * frame.videoHeight / frame.videoWidth)
          const ctx = canvas.getContext('2d', { willReadFrequently: true })!
          ctx.drawImage(frame, 0, 0, canvas.width, canvas.height)
          const image = ctx.getImageData(0, 0, canvas.width, canvas.height)
          const code = jsQR(image.data, image.width, image.height)
          if (code?.data) callbacks.current.onValue(code.data)
        }, 220)
      } catch {
        if (!disposed) callbacks.current.onError('无法打开相机，可从相册选择二维码图片')
      }
    })()
    return () => { disposed = true; window.clearInterval(timer); stream?.getTracks().forEach(track => track.stop()) }
  }, [])
  return <video className="qr-video" ref={video} playsInline muted />
}

export function NodeEditor({ node, busy, save, test, remove, reset }: {
  node?: Node; busy: boolean; save: (node: Node) => void; test: (node: Node) => void; remove?: () => void; reset?: () => void
}) {
  const [name, setName] = useState(node?.config.name ?? '')
  const [server, setServer] = useState(node?.config.server ?? '')
  const [port, setPort] = useState(String(node?.config.port ?? 443))
  const [type, setType] = useState(protocol(node ?? { id: '', sourceId: '', config: { name: '', server: '', port: 443, type: 'http', tls: true } }))
  const [username, setUsername] = useState(String(node?.config.username ?? ''))
  const [password, setPassword] = useState(String(node?.config.password ?? ''))
  const [stableId] = useState(() => node?.id ?? id())
  const proxyType = node?.config.type ?? (type === 'SOCKS5' ? 'socks5' : 'http')
  const isHttp = !node || proxyType === 'http' || proxyType === 'socks5'
  const valid = name.trim() && server.trim() && Number.isInteger(Number(port)) && Number(port) > 0 && Number(port) <= 65535
  function value(): Node {
    const config: Proxy = { ...node?.config, name: name.trim(), server: server.trim(), port: Number(port), type: proxyType }
    if (isHttp) {
      config.type = type === 'SOCKS5' ? 'socks5' : 'http'
      config.tls = type === 'HTTPS'
      if (username) config.username = username
      else delete config.username
      if (password) config.password = password
      else delete config.password
    }
    return { id: stableId, sourceId: node?.sourceId ?? 'custom', config }
  }
  return <form className="sheet-form" onSubmit={e => { e.preventDefault(); if (valid) save(value()) }}>
    <Field label="名称"><input value={name} onChange={e => setName(e.target.value)} placeholder="例如 家宽出口" required /></Field>
    <div className="field">
      <span>代理协议</span>
      {isHttp ? (
        <AirSelect
          label="代理协议"
          value={type}
          onChange={setType}
          options={[
            { value: 'HTTPS', label: 'HTTPS' },
            { value: 'HTTP', label: 'HTTP' },
            { value: 'SOCKS5', label: 'SOCKS5' },
          ]}
        />
      ) : (
        <div className="field-value">{type}</div>
      )}
    </div>
    <div className="grid grid-cols-[1fr_90px] gap-2">
      <Field label="服务器地址"><input value={server} onChange={e => setServer(e.target.value)} placeholder="proxy.example.net" required /></Field>
      <Field label="端口"><input type="number" min="1" max="65535" value={port} onChange={e => setPort(e.target.value)} required /></Field>
    </div>
    {isHttp && <>
      <Field label="用户名（选填）"><input value={username} onChange={e => setUsername(e.target.value)} autoComplete="off" /></Field>
      <Field label="密码（选填）"><input type="password" value={password} onChange={e => setPassword(e.target.value)} autoComplete="new-password" /></Field>
    </>}
    <div className="sheet-actions">
      <Button type="button" size="sm" variant="outline" disabled={!valid || busy} onClick={() => test(value())}><Activity />测试连接</Button>
      {reset && <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={reset}>恢复订阅值</Button>}
      {remove && <Button type="button" size="icon-sm" variant="destructive" aria-label="删除节点" disabled={busy} onClick={remove}><Trash2 /></Button>}
      <Button type="submit" className="ml-auto" variant="default" disabled={!valid || busy}><Save />保存节点</Button>
    </div>
  </form>
}

export function GroupEditor({ group, library, model, busy, save, choose, remove }: {
  group?: Group; library: Library; model: Model; busy: boolean; save: (group: Group) => void; choose?: () => void; remove?: () => void
}) {
  const [name, setName] = useState(group?.name ?? '')
  const [type, setType] = useState<Policy>(group?.type ?? 'select')
  const [mode, setMode] = useState(group?.automatic ? 'automatic' : 'manual')
  const [source, setSource] = useState(group?.automatic?.sourceId ?? '')
  const [delay, setDelay] = useState(group?.automatic?.maxDelay ?? 200)
  const [limit, setLimit] = useState(group?.automatic?.limit ?? 8)
  const [members, setMembers] = useState(group?.members ?? [])
  const [search, setSearch] = useState('')
  const available = mode === 'automatic' ? membersOf({ id: '', name, type, members, automatic: { sourceId: source, maxDelay: delay, limit } }, model, library) : []
  if (group?.sourceId) return <div className="sheet-form">
    <div className="flex gap-2"><Tag>{policyLabels[group.type]}</Tag><Tag tone="gray">{group.members.length} 个成员</Tag></div>
    {membersOf(group, model, library).map(n => <div className="pick-row" key={n.id}><span>{n.config.name}</span><Tag tone="gray">{protocol(n)}</Tag></div>)}
    <div className="sheet-actions"><Button className="ml-auto" disabled={busy || !group.members.length} variant="default" onClick={choose}>设为当前出站</Button></div>
  </div>
  return <form className="sheet-form" onSubmit={e => {
    e.preventDefault()
    if (!name.trim()) return
    save({ id: group?.id ?? id(), name: name.trim(), type, members, automatic: mode === 'automatic' ? { sourceId: source, maxDelay: delay, limit } : undefined })
  }}>
    <Field label="分组名称"><input required value={name} onChange={e => setName(e.target.value)} placeholder="例如 日常候选" /></Field>
    <div className="grid grid-cols-2 gap-2">
      <div className="field">
        <span>入组方式</span>
        <AirSelect
          label="入组方式"
          value={mode}
          onChange={setMode}
          options={[
            { value: 'manual', label: '手动入组' },
            { value: 'automatic', label: '自动入组' },
          ]}
        />
      </div>
      <div className="field">
        <span>选路策略</span>
        <AirSelect
          label="选路策略"
          value={type}
          onChange={value => setType(value as Policy)}
          options={Object.entries(policyLabels).map(([key, label]) => ({ value: key, label }))}
        />
      </div>
    </div>
    {mode === 'automatic' ? <>
      <div className="field">
        <span>候选来源</span>
        <AirSelect
          label="候选来源"
          value={source || '__all__'}
          onChange={value => setSource(value === '__all__' ? '' : value)}
          options={[
            { value: '__all__', label: '全部来源' },
            ...library.sources.map(s => ({ value: s.id, label: s.name })),
          ]}
        />
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Field label="最高延迟（ms）"><input type="number" required min="1" max="9999" value={delay} onChange={e => setDelay(Number(e.target.value))} /></Field>
        <Field label="最多节点"><input type="number" required min="1" max="128" value={limit} onChange={e => setLimit(Number(e.target.value))} /></Field>
      </div>
      <div className="panel matcher"><b>预览匹配 · {available.length} 个</b><small>{available.length ? available.map(n => n.config.name).join('、') : '节点测速后会自动匹配'}</small></div>
    </> : <>
      <Field label="成员筛选"><input placeholder="搜索节点" value={search} onChange={e => setSearch(e.target.value)} /></Field>
      <div className="pick-list">{model.nodes.filter(n => n.config.name.toLowerCase().includes(search.toLowerCase())).map(n =>
        <label className="pick-row" key={n.id}><input type="checkbox" checked={members.includes(n.id)} onChange={e => setMembers(e.target.checked ? [...members, n.id] : members.filter(id => id !== n.id))} /><span>{n.config.name}</span></label>
      )}</div>
    </>}
    <div className="sheet-actions">
      {remove && <Button type="button" variant="destructive" size="icon-sm" aria-label="删除分组" disabled={busy} onClick={remove}><Trash2 /></Button>}
      {choose && <Button type="button" variant="outline" size="sm" disabled={busy || !group || !membersOf(group, model, library).length} onClick={choose}>设为出站</Button>}
      <Button type="submit" className="ml-auto" variant="default" disabled={busy || !name.trim()}><Check />保存分组</Button>
    </div>
  </form>
}

export function ChainEditor({ library, model, busy, save, use, remove, test }: {
  library: Library; model: Model; busy: boolean; save: (chain: Chain) => void; use: (chain: Chain) => void
  remove: (chain: Chain) => void; test: (chain: Chain) => void
}) {
  const [editing, setEditing] = useState<Chain>(() => library.chains.find(c => c.id === library.choice?.id) ?? library.chains[0] ?? { id: id(), name: '', hops: ['', ''] })
  const existing = library.chains.some(c => c.id === editing.id)
  const valid = editing.name.trim() && editing.hops.length >= 2 &&
    new Set(editing.hops).size === editing.hops.length && editing.hops.every(id => model.nodes.some(n => n.id === id))
  const active = library.choice?.id === editing.id
  const current = { ...editing, name: editing.name.trim() }
  const changed = JSON.stringify(library.chains.find(c => c.id === editing.id)) !== JSON.stringify(current)
  return <form className="sheet-form" onSubmit={e => { e.preventDefault(); if (valid) save(current) }}>
    <div className="flex items-center gap-2">
      <div className="min-w-0 flex-1">
        <AirSelect
          label="选择已有链路"
          value={existing ? editing.id : '__new__'}
          placeholder="新建链路"
          onChange={value => {
            if (value === '__new__') {
              setEditing({ id: id(), name: '', hops: ['', ''] })
              return
            }
            const found = library.chains.find(c => c.id === value)
            if (found) setEditing(found)
          }}
          options={[
            ...(!existing ? [{ value: '__new__', label: '新建链路' }] : []),
            ...library.chains.map(c => ({ value: c.id, label: c.name })),
          ]}
        />
      </div>
      <Button type="button" variant="outline" onClick={() => setEditing({ id: id(), name: '', hops: ['', ''] })}><Plus />新建</Button>
      {existing && <Button type="button" variant="destructive" size="icon" aria-label="删除链路" disabled={busy} onClick={() => remove(editing)}><Trash2 /></Button>}
    </div>
    <Field label="链路名称"><input value={editing.name} onChange={e => setEditing({ ...editing, name: e.target.value })} required placeholder="例如 节点转家宽" /></Field>
    {editing.hops.map((hop, index) => <div className="hop" key={index}>
      <Tag>{index === 0 ? '前置' : index === editing.hops.length - 1 ? '出口' : '中转'}</Tag>
      <AirSelect
        label={'第 ' + (index + 1) + ' 跳'}
        value={hop || '__empty__'}
        onChange={value => setEditing({
          ...editing,
          hops: editing.hops.map((old, i) => i === index ? (value === '__empty__' ? '' : value) : old),
        })}
        options={[
          { value: '__empty__', label: '选择节点' },
          ...model.nodes.map(n => ({
            value: n.id,
            label: `${n.config.name} · ${protocol(n)}`,
            disabled: editing.hops.includes(n.id) && n.id !== hop,
          })),
        ]}
      />
      {editing.hops.length > 2 && <Button type="button" size="icon-sm" variant="ghost" aria-label="移除此跳" onClick={() => setEditing({ ...editing, hops: editing.hops.filter((_, i) => i !== index) })}><Trash2 /></Button>}
    </div>)}
    <div className="flex justify-between gap-2">
      <Button type="button" variant="outline" disabled={editing.hops.length >= 8} onClick={() => setEditing({ ...editing, hops: [...editing.hops, ''] })}><Plus />添加一跳</Button>
      <Button type="button" variant="outline" disabled={!valid || busy} onClick={() => test(current)}><Activity />整链测速</Button>
    </div>
    <div className="sheet-actions">
      {active && <Tag tone="green">当前出站</Tag>}
      {existing && !active && <Button type="button" size="sm" variant="outline" disabled={!valid || changed || busy} onClick={() => use(current)}><Waypoints />设为出站</Button>}
      <Button type="submit" className="ml-auto" variant="default" disabled={!valid || !changed || busy}><Check />保存链路</Button>
    </div>
  </form>
}

export function YamlEditor({ source, compiled, busy, save, reset }: {
  source: Subscription; compiled: string; busy: boolean; save: (draft: string) => void; reset: () => void
}) {
  const [tab, setTab] = useState<'local' | 'original' | 'effective'>('local')
  const [draft, setDraft] = useState(source.yaml)
  const value = tab === 'local' ? draft : tab === 'original' ? source.original : compiled
  function validate() {
    try { yamlProfile(draft); save(draft) }
    catch (err) { showMessage({ type: 'error', title: errorText(err) }) }
  }
  return <>
    <main className="page-scroll yaml-page">
      <div className="section-title"><strong><Code2 size={16} className="inline align-text-bottom text-primary" /> {source.name}</strong><Tag tone={source.edited ? 'blue' : 'gray'}>{source.edited ? '本地副本' : '订阅原文'}</Tag></div>
      <Segmented layoutId="android-yaml-view" ariaLabel="YAML 视图" size="md" fullWidth value={tab} onChange={setTab}
        options={[{ value: 'local', label: '本地副本' }, { value: 'original', label: '订阅原文' }, { value: 'effective', label: '生效预览' }]} />
      <CodeEditor key={tab} initial={value} editable={tab === 'local'} update={setDraft} />
    </main>
    <footer className="page-action flex items-center gap-2">
      {source.edited && <Button size="sm" variant="outline" disabled={busy} onClick={reset}>恢复订阅原文</Button>}
      <Button size="sm" variant="outline" className="ml-auto" onClick={() => {
        const copied = onAndroid ? native('copy', { text: value }) : navigator.clipboard.writeText(value)
        void copied.then(() => showMessage({ type: 'success', title: '已复制 YAML' })).catch(() => showMessage({ type: 'error', title: '复制失败' }))
      }}>复制</Button>
      <Button variant="default" disabled={tab !== 'local' || busy || draft === source.yaml} onClick={validate}><Check />保存并应用</Button>
    </footer>
  </>
}

function CodeEditor({ initial, editable, update }: { initial: string; editable: boolean; update: (text: string) => void }) {
  const target = useRef<HTMLDivElement>(null)
  const props = useRef({ initial, editable, update })
  useEffect(() => {
    const config = props.current
    const view = new EditorView({
      parent: target.current!,
      state: EditorState.create({
        doc: config.initial,
        extensions: [lineNumbers(), highlightActiveLine(), keymap.of(defaultKeymap), yaml(), syntaxHighlighting(defaultHighlightStyle),
          EditorState.readOnly.of(!config.editable), EditorView.editable.of(config.editable),
          EditorView.updateListener.of(event => { if (event.docChanged) config.update(event.state.doc.toString()) })],
      }),
    })
    return () => view.destroy()
  }, [])
  return <div className="yaml-editor" ref={target} />
}
