import { AuthProvidersCard } from '@/components/settings/AuthProvidersCard'
import { LoginDisplayCard } from '@/components/settings/LoginDisplayCard'

export default function SsoSettingsPage() {
  return (
    <div className="space-y-6">
      <AuthProvidersCard />
      <LoginDisplayCard />
    </div>
  )
}
