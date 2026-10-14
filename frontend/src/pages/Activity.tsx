import { Page, PageHeader, Surface } from '@/components/app/page'
import { ActivityFeed } from '@/components/app/updates'

export function ActivityPage() {
  return (
    <Page className="max-w-4xl">
      <PageHeader title="Activity" description="Every action run through Harbor, with its full output." />
      <Surface>
        <ActivityFeed limit={200} />
      </Surface>
    </Page>
  )
}
