import { AppRouter } from './router'
import { useBranding } from './hooks/useBranding'

function BrandingApplier() {
  useBranding()
  return null
}

export default function App() {
  return (
    <>
      <BrandingApplier />
      <AppRouter />
    </>
  )
}
