export type UsageCardInput = {
  displayName: string
  totalTokens: number
  totalCostUsd: number
  monthTokens: number
  monthCostUsd: number
}

const publicUrl = 'https://tokenboard.chaosyn.com'

export function renderUsageCardSvg(input: UsageCardInput) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="520" height="220" viewBox="0 0 520 220" role="img" aria-label="TokenBoard 统计">
  <title>TokenBoard 统计</title>
  <defs>
    <linearGradient id="card-bg" x1="0" y1="0" x2="520" y2="220" gradientUnits="userSpaceOnUse">
      <stop stop-color="#161a13"/>
      <stop offset="1" stop-color="#0c0d0a"/>
    </linearGradient>
    <radialGradient id="glow" cx="86%" cy="10%" r="56%">
      <stop stop-color="#bef264" stop-opacity="0.28"/>
      <stop offset="1" stop-color="#bef264" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="520" height="220" rx="16" fill="url(#card-bg)"/>
  <rect width="520" height="220" rx="16" fill="url(#glow)"/>
  <rect x="0.5" y="0.5" width="519" height="219" rx="15.5" fill="none" stroke="#78716c" stroke-opacity="0.36"/>
  <rect x="24" y="24" width="46" height="46" rx="12" fill="#bef264"/>
  <text x="36" y="54" fill="#1c1917" font-family="Arial, sans-serif" font-size="18" font-weight="800">TB</text>
  <text x="84" y="41" fill="#fafaf9" font-family="Arial, sans-serif" font-size="20" font-weight="800">TokenBoard 统计</text>
  <text x="84" y="64" fill="#a8a29e" font-family="Arial, sans-serif" font-size="13">${escapeXml(input.displayName)} · ${publicUrl}</text>
  ${metricBlock(24, 94, '总 token', formatInteger(input.totalTokens), true)}
  ${metricBlock(270, 94, '总额度', formatUsd(input.totalCostUsd))}
  ${metricBlock(24, 152, '本月 token', formatInteger(input.monthTokens))}
  ${metricBlock(270, 152, '本月额度', formatUsd(input.monthCostUsd))}
</svg>`
}

function metricBlock(x: number, y: number, label: string, value: string, highlight = false) {
  const valueFill = highlight ? '#bef264' : '#fafaf9'
  return `<g>
      <rect x="${x}" y="${y}" width="226" height="44" rx="10" fill="${highlight ? '#bef264' : '#151812'}" fill-opacity="${highlight ? '0.14' : '0.78'}" stroke="${highlight ? '#bef264' : '#78716c'}" stroke-opacity="${highlight ? '0.45' : '0.28'}"/>
      <text x="${x + 14}" y="${y + 18}" fill="#a8a29e" font-family="Arial, sans-serif" font-size="12">${label}</text>
      <text x="${x + 14}" y="${y + 35}" fill="${valueFill}" font-family="Arial, sans-serif" font-size="18" font-weight="800">${value}</text>
    </g>`
}

function formatInteger(value: number) {
  return new Intl.NumberFormat('en-US').format(value)
}

function formatUsd(value: number) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(value)
}

function escapeXml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}
