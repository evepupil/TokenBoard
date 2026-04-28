export function toIsoDate(date: Date) {
  return date.toISOString().slice(0, 10)
}

