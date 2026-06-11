export function eachIsoDate(startDate: string, endDate: string) {
  const dates: string[] = []
  const current = new Date(`${startDate}T00:00:00.000Z`)
  const end = new Date(`${endDate}T00:00:00.000Z`)

  while (current <= end) {
    dates.push(current.toISOString().slice(0, 10))
    current.setUTCDate(current.getUTCDate() + 1)
  }

  return dates
}

export function roundMetric(value: number) {
  return Math.round(value * 10000) / 10000
}

export function summaryRangeBindings(
  summaryStrict: boolean | undefined,
  userId: string,
  startDate: string,
  endDate: string
) {
  return summaryStrict
    ? [userId, startDate, endDate]
    : [userId, startDate, endDate, userId, startDate, endDate]
}
