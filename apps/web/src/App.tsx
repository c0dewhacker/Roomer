import { AppRouter } from './router'
import { useBranding } from './hooks/useBranding'
import { useDateFormatInit } from './hooks/useDateFormatInit'

function AppInitializers() {
  useBranding()
  useDateFormatInit()
  return null
}

export default function App() {
  return (
    <>
      <AppInitializers />
      <AppRouter />
    </>
  )
}
