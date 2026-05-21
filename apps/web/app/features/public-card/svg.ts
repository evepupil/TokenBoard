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
    <linearGradient id="card-logo-panel" x1="96" y1="48" x2="416" y2="464" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#272a22"/>
      <stop offset="1" stop-color="#11130f"/>
    </linearGradient>
    <linearGradient id="card-logo-lime" x1="132" y1="108" x2="380" y2="404" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#ecfccb"/>
      <stop offset="0.42" stop-color="#bef264"/>
      <stop offset="1" stop-color="#84cc16"/>
    </linearGradient>
  </defs>
  <rect width="520" height="220" rx="16" fill="url(#card-bg)"/>
  <rect width="520" height="220" rx="16" fill="url(#glow)"/>
  <rect x="0.5" y="0.5" width="519" height="219" rx="15.5" fill="none" stroke="#78716c" stroke-opacity="0.36"/>
  ${logoMark()}
  <text x="94" y="41" fill="#fafaf9" font-family="Arial, sans-serif" font-size="20" font-weight="800">TokenBoard 统计</text>
  <text x="94" y="64" fill="#a8a29e" font-family="Arial, sans-serif" font-size="13">${escapeXml(input.displayName)} · ${publicUrl}</text>
  ${metricBlock(24, 94, '总 token', formatInteger(input.totalTokens), true)}
  ${metricBlock(270, 94, '总额度', formatUsd(input.totalCostUsd))}
  ${metricBlock(24, 152, '本月 token', formatInteger(input.monthTokens))}
  ${metricBlock(270, 152, '本月额度', formatUsd(input.monthCostUsd))}
</svg>`
}

function logoMark() {
  return `<g transform="translate(22 18) scale(0.118)">
    <rect width="512" height="512" rx="104" fill="#090a08"/>
    <rect x="42" y="42" width="428" height="428" rx="82" fill="url(#card-logo-panel)"/>
    <rect x="66" y="66" width="380" height="380" rx="62" fill="none" stroke="#bef264" stroke-opacity="0.16" stroke-width="4"/>
    <g opacity="0.42" stroke="#f7fee7" stroke-width="2">
      <path d="M118 166H394"/>
      <path d="M118 246H394"/>
      <path d="M118 326H394"/>
      <path d="M176 118V386"/>
      <path d="M256 118V386"/>
      <path d="M336 118V386"/>
    </g>
    <g fill="url(#card-logo-lime)">
      <path d="M130 118H282V164H229V382H181V164H130V118Z"/>
      <path d="M280 118H352C389 118 415 143 415 178C415 200 404 218 386 228C410 238 425 260 425 287C425 324 397 350 356 350H280V118ZM328 164V211H348C360 211 368 201 368 187C368 173 360 164 347 164H328ZM328 253V304H354C369 304 377 294 377 278C377 263 368 253 353 253H328Z"/>
    </g>
    <g fill="#11130f">
      <rect x="145" y="296" width="18" height="54" rx="9"/>
      <rect x="185" y="260" width="18" height="90" rx="9"/>
      <rect x="225" y="224" width="18" height="126" rx="9"/>
    </g>
    <path d="M120 390H392" stroke="#bef264" stroke-opacity="0.72" stroke-width="12" stroke-linecap="round"/>
  </g>`
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
