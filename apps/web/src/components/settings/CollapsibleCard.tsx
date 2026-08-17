import { ChevronDown } from 'lucide-react'
import { useState } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { cn } from '@/lib/utils'

export function CollapsibleCard({
  title,
  description,
  children,
}: {
  title: string
  description: string
  children: React.ReactNode
}) {
  // Every current usage is one of the 1–2 cards that make up an entire
  // settings tab (Organisation, Provisioning, and Branding have exactly one;
  // Email and SSO have two) — not a long list where collapsing-by-default
  // reduces clutter. Starting closed meant an admin had to click through
  // every card just to see their current SMTP host, SSO status, etc., on
  // every visit. Collapse remains available for whoever wants to tidy up
  // after reviewing.
  const [open, setOpen] = useState(true)

  return (
    <Card>
      <CardHeader
        className="cursor-pointer select-none"
        onClick={() => setOpen((o) => !o)}
      >
        <div className="flex items-center justify-between">
          <div className="space-y-1">
            <CardTitle>{title}</CardTitle>
            <CardDescription>{description}</CardDescription>
          </div>
          <ChevronDown
            className={cn('h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-200', open && 'rotate-180')}
          />
        </div>
      </CardHeader>
      {open && <CardContent>{children}</CardContent>}
    </Card>
  )
}
