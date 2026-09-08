import { Button } from './ui/button'

export function QueryError({ message, retry }: { message: string; retry: () => void }) {
  return (
    <div role="alert" className="rounded-lg border border-destructive/30 p-6 space-y-3">
      <p>{message}</p>
      <Button variant="outline" onClick={retry}>Try again</Button>
    </div>
  )
}
