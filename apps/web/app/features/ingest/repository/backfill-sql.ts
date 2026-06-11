const summaryBackfillSelectSql = `
  SELECT
    user_id as userId,
    usage_date as usageDate,
    source,
    model
  FROM daily_usage
`

const summaryBackfillOrderSql = `
  GROUP BY user_id, usage_date, source, model
  ORDER BY user_id ASC, usage_date ASC, source ASC, model ASC
  LIMIT ?
`

export const summaryBackfillInitialSql = `
  ${summaryBackfillSelectSql}
  ${summaryBackfillOrderSql}
`

export const summaryBackfillCursorSql = `
  ${summaryBackfillSelectSql}
  WHERE (user_id, usage_date, source, model) > (?, ?, ?, ?)
  ${summaryBackfillOrderSql}
`

const totalsBackfillSelectSql = `
  SELECT user_id as userId
  FROM daily_usage_summary
`

const totalsBackfillOrderSql = `
  GROUP BY user_id
  ORDER BY user_id ASC
  LIMIT ?
`

export const totalsBackfillInitialSql = `
  ${totalsBackfillSelectSql}
  ${totalsBackfillOrderSql}
`

export const totalsBackfillCursorSql = `
  ${totalsBackfillSelectSql}
  WHERE user_id > ?
  ${totalsBackfillOrderSql}
`
