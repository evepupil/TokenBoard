import { createRoute } from 'honox/factory'
import { DashboardPreview } from '../features/usage/components/dashboard-preview'

export default createRoute((c) => {
  return c.render(
    <main class="min-h-screen bg-zinc-950 px-6 py-8 text-zinc-50">
      <title>TokenBoard</title>
      <DashboardPreview />
    </main>
  )
})
