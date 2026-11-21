import { ShieldAlert } from 'lucide-react'
import { Button } from '@/shared/ui/button'

export function TunServiceButton({ onClick, disabled }: {
  onClick: () => void
  disabled?: boolean
}) {
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      className="text-warning hover:bg-warning-soft hover:text-warning"
      aria-label="安装虚拟网卡服务"
      title="安装虚拟网卡服务"
      onClick={onClick}
      disabled={disabled}
    >
      <ShieldAlert />
    </Button>
  )
}
