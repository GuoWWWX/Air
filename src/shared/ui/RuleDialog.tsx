import type { RuleOverlay } from './GlobalRuleList'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from './dialog'

export const ruleDialog: RuleOverlay = (title, close, content) => <Dialog open onOpenChange={open => { if (!open) close() }}>
  <DialogContent className="max-h-[85dvh] overflow-y-auto">
    <DialogHeader><DialogTitle>{title}</DialogTitle></DialogHeader>{content}
  </DialogContent>
</Dialog>
