import { createRoute } from 'honox/factory'
import { AppNav } from '../../components/app-nav'
import { Badge } from '../../components/ui/badge'
import { Card, CardContent, CardHeader } from '../../components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../components/ui/table'
import { getOptionalUser } from '../../features/auth/middleware'
import { getDailyLeaderboard } from '../../features/leaderboards/service'
import { formatUsd } from '../../lib/money'

export default createRoute(async (c) => {
  const user = await getOptionalUser(c)
  const entries = await getDailyLeaderboard(c.env.DB)

  return c.render(
    <main class="min-h-screen bg-[var(--app-bg)] px-5 py-6 text-[var(--app-text)]">
      <title>排行榜 - TokenBoard</title>
      <AppNav active="leaderboards" email={user?.email} isAuthenticated={Boolean(user)} />
      <Card class="mx-auto max-w-6xl rounded-2xl">
        <CardHeader class="flex-col gap-4 border-b border-[var(--app-border)] md:flex-row md:items-end md:justify-between">
          <div>
            <Badge>排行榜</Badge>
            <h1 class="mt-3 text-4xl font-black tracking-tight">每日 token 排名</h1>
          </div>
          <div class="flex rounded-full border border-[var(--app-border)] p-1 text-sm text-[var(--app-muted)]">
            <Badge>每日</Badge>
            <span class="px-3 py-1.5 text-[var(--app-subtle)]">每月</span>
          </div>
        </CardHeader>
        <CardContent class="pt-5">
          <div class="overflow-x-auto">
            <Table class="min-w-[620px] border-separate border-spacing-y-2">
              <TableHeader>
                <TableRow class="border-0">
                  <TableHead>排名</TableHead>
                  <TableHead>用户</TableHead>
                  <TableHead>Tokens</TableHead>
                  <TableHead>费用</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {entries.length > 0 ? entries.map((entry) => (
                  <TableRow class="border-0 bg-[var(--app-bg-soft)]">
                    <TableCell class="rounded-l-xl font-black text-lime-300">#{entry.rank}</TableCell>
                    <TableCell>{entry.displayName}</TableCell>
                    <TableCell class="font-bold">{formatInteger(entry.totalTokens)}</TableCell>
                    <TableCell class="rounded-r-xl text-[var(--app-muted)]">{formatUsd(entry.costUsd)}</TableCell>
                  </TableRow>
                )) : (
                  <TableRow>
                    <TableCell class="rounded-xl border border-dashed border-[var(--app-border)] py-8 text-center text-[var(--app-muted)]" colSpan={4}>还没有公开排行榜数据。</TableCell>
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
