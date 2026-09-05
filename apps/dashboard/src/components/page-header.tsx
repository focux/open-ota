/** Title, the one question the page answers, and the actions for it. */
export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  readonly title: React.ReactNode
  readonly subtitle: React.ReactNode
  readonly actions?: React.ReactNode
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="flex min-w-0 flex-col gap-1">
        <h1 className="text-xl leading-tight font-semibold">{title}</h1>
        <p className="text-sm text-pretty text-muted-foreground">{subtitle}</p>
      </div>
      {actions ? (
        <div className="flex flex-wrap items-center gap-2">{actions}</div>
      ) : null}
    </div>
  )
}
