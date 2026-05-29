import type { LeaderboardQuery } from './queries'

type LeaderboardTitleInput = {
  period?: LeaderboardQuery['period'] | string | null
  metric?: LeaderboardQuery['metric'] | string | null
}

export function leaderboardDocumentTitle(input: LeaderboardTitleInput) {
  return `${leaderboardPeriodTitle(input.period)}${leaderboardMetricTitle(input.metric)}排行榜 - TokenBoard`
}

function leaderboardPeriodTitle(period: LeaderboardTitleInput['period']) {
  return period === 'monthly' ? '每月' : '每日'
}

function leaderboardMetricTitle(metric: LeaderboardTitleInput['metric']) {
  if (metric === 'cost') return '费用'
  if (metric === 'tokens-without-cache-read') return '不含缓存读 token'
  return 'token'
}
