import { AppWindow } from 'lucide-react'

export function ConnectionApp({ name, executable, icon }: { name: string; executable?: string; icon?: string }) {
  return (
    <span className="flex min-w-0 items-center gap-2 font-medium" title={executable ? `${name} · ${executable}` : name}>
      {icon ? (
        <img src={icon} alt="" draggable={false} className="size-4 shrink-0 object-contain" />
      ) : (
        <AppWindow aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
      )}
      <span className="min-w-0 truncate">{name}</span>
    </span>
  )
}
