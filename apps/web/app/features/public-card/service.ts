import { renderUsageCardSvg } from './svg'

export function getEmptyPublicCard() {
  return renderUsageCardSvg({
    displayName: 'TokenBoard',
    todayTokens: 0,
    monthCostUsd: 0
  })
}

