-- `daily_usage_user_date_idx(user_id, usage_date)` is a strict prefix of
-- `daily_usage_logical_key_device_idx(user_id, usage_date, source, model, device_id)`, so it
-- serves no read the longer index cannot and only adds one index write per new row.
DROP INDEX IF EXISTS daily_usage_user_date_idx;
