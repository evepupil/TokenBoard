import { createRoute } from 'honox/factory'
import { Badge } from '../../components/ui/badge'
import { LinkButton } from '../../components/ui/button'
import { Card, CardContent, CardHeader } from '../../components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../components/ui/table'
import { getOptionalUser } from '../../features/auth/middleware'
import { getDailyLeaderboard } from '../../features/leaderboards/service'
import { formatUsd } from '../../lib/money'

export default createRoute(async (c) => {
  const user = await getOptionalUser(c)
  const entries = await getDailyLeaderboard(c.env.DB)

  return c.render(
    <main class="min-h-screen bg-[#10130f] px-5 py-6 text-stone-50">
      <title>Leaderboards - TokenBoard</title>
      <nav class="mx-auto mb-6 flex max-w-6xl items-center justify-between rounded-2xl border border-stone-800 bg-stone-950/75 px-4 py-3">
        <a class="font-black text-lime-200" href={user ? '/dashboard' : '/'}>TokenBoard</a>
        <div class="flex items-center gap-2 text-sm">
          {user ? <LinkButton variant="ghost" size="sm" href="/dashboard">Dashboard</LinkButton> : null}
          {user ? <LinkButton variant="ghost" size="sm" href="/settings/install">Install</LinkButton> : null}
          {user ? null : <LinkButton size="sm" href="/auth/sign-in">Sign in</LinkButton>}
        </div>
      </nav>
      <Card class="mx-auto max-w-6xl rounded-[1.75rem]">
        <CardHeader class="flex-col gap-4 border-b border-stone-800 md:flex-row md:items-end md:justify-between">
          <div>
            <Badge>Leaderboards</Badge>
            <h1 class="mt-3 text-4xl font-black tracking-tight">Daily token ranking</h1>
          </div>
          <div class="flex rounded-full border border-stone-800 p-1 text-sm text-stone-300">
            <Badge>Daily</Badge>
            <span class="px-3 py-1.5 text-stone-500">Monthly</span>
          </div>
        </CardHeader>
        <CardContent class="pt-5">
          <div class="overflow-x-auto">
            <Table class="min-w-[620px] border-separate border-spacing-y-2">
              <TableHeader>
                <TableRow class="border-0">
                  <TableHead>Rank</TableHead>
                  <TableHead>User</TableHead>
                  <TableHead>Tokens</TableHead>
                  <TableHead>Cost</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {entries.length > 0 ? entries.map((entry) => (
                  <TableRow class="border-0 bg-stone-900/70">
                    <TableCell class="rounded-l-xl font-black text-lime-200">#{entry.rank}</TableCell>
                    <TableCell>{entry.displayName}</TableCell>
                    <TableCell class="font-bold">{formatInteger(entry.totalTokens)}</TableCell>
                    <TableCell class="rounded-r-xl text-stone-300">{formatUsd(entry.costUsd)}</TableCell>
                  </TableRow>
                )) : (
                  <TableRow>
                    <TableCell class="rounded-xl border border-dashed border-stone-800 py-8 text-center text-stone-500" colSpan={4}>No public leaderboard data yet.</TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </main>
  )
})

function formatInteger(value: number) {
  return new Intl.NumberFormat('en-US').format(value)
}
