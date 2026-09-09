import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

/**
 * The single frame every page sits in.
 *
 * Page containers had drifted into four different widths chosen ad hoc —
 * `max-w-3xl` (×3), `max-w-4xl` (×9), `max-w-6xl` (×2) and `max-w-7xl` (×1) —
 * with `space-y-6` present on some and missing on others, so each page
 * improvised its own frame and the content column visibly jumped as you moved
 * between them.
 *
 * The widths are named by what the page *is* rather than by a Tailwind size, so
 * the choice is a decision about content rather than a number someone typed:
 *
 *   form   — single-column forms and settings. Held near 65ch so lines stay
 *            readable; wider is actively worse for a stack of labelled inputs.
 *   list   — record lists and detail pages, the default.
 *   wide   — dense multi-column work (floor plans, big tables).
 *   full   — dashboards that genuinely use the whole viewport, like Reports.
 */
const WIDTHS = {
  form: 'max-w-2xl',
  list: 'max-w-4xl',
  wide: 'max-w-6xl',
  full: 'max-w-screen-2xl',
} as const

export interface PageShellProps {
  title: string
  /** Sits under the title. Keep it to what the page actually does. */
  description?: string
  /** Primary action(s) for the page, aligned opposite the title. */
  actions?: ReactNode
  width?: keyof typeof WIDTHS
  children: ReactNode
  className?: string
}

export function PageShell({
  title, description, actions, width = 'list', children, className,
}: PageShellProps) {
  return (
    <div className={cn('mx-auto w-full px-6 py-8', WIDTHS[width], className)}>
      <header
        className={cn(
          'flex flex-wrap items-start justify-between gap-x-6 gap-y-3',
          // The rule under the header does the separating, so the gap below it
          // can stay tight — the title and the content belong together.
          'border-b border-border pb-5 mb-6',
        )}
      >
        <div className="min-w-0">
          {/* One treatment for every page title. It had been text-2xl font-bold
              (×23), text-2xl font-semibold (×4) and text-xl font-bold (×1) —
              the same role rendered three ways. Semibold rather than bold: at
              this size Inter's bold is heavier than the hierarchy needs once
              the scale is doing the work. */}
          <h1 className="text-2xl font-semibold tracking-tight text-foreground text-balance">
            {title}
          </h1>
          {description && (
            <p className="mt-1.5 text-sm text-muted-foreground text-pretty">{description}</p>
          )}
        </div>
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </header>
      <div className="space-y-6">{children}</div>
    </div>
  )
}
