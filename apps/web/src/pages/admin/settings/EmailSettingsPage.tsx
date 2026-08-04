import { EmailSettingsCard } from '@/components/settings/EmailSettingsCard'
import { EmailTemplatesCard } from '@/components/settings/EmailTemplatesCard'

export default function EmailSettingsPage() {
  return (
    <div className="space-y-6">
      <EmailSettingsCard />
      <EmailTemplatesCard />
    </div>
  )
}
