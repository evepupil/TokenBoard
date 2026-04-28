export type UsageCardInput = {
  displayName: string
  todayTokens: number
  monthCostUsd: number
}

export function renderUsageCardSvg(input: UsageCardInput) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="420" height="120" role="img" aria-label="AI token usage">
  <rect width="420" height="120" rx="8" fill="#09090b"/>
  <text x="24" y="34" fill="#fafafa" font-family="Arial, sans-serif" font-size="18" font-weight="700">${escapeXml(input.displayName)}</text>
  <text x="24" y="68" fill="#a1a1aa" font-family="Arial, sans-serif" font-size="14">Today tokens</text>
  <text x="148" y="68" fill="#fafafa" font-family="Arial, sans-serif" font-size="16">${input.todayTokens.toLocaleString()}</text>
  <text x="24" y="96" fill="#a1a1aa" font-family="Arial, sans-serif" font-size="14">Month cost</text>
  <text x="148" y="96" fill="#fafafa" font-family="Arial, sans-serif" font-size="16">$${input.monthCostUsd.toFixed(2)}</text>
</svg>`
}

function escapeXml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

