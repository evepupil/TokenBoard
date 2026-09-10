SELECT
  upload_tokens.installation_id,
  upload_tokens.supersedes_token_id
FROM upload_tokens
LIMIT 0;

SELECT
  install_claim_hash
FROM device_installations
LIMIT 0;

SELECT
  pairing_type,
  target_device_id,
  metadata
FROM pairing_codes
LIMIT 0;

SELECT id
FROM audit_logs
LIMIT 0;

SELECT
  model_pricing.provider,
  model_pricing.model_id,
  model_pricing.input_cost_per_million,
  model_pricing.official_docs_url
FROM model_pricing
LIMIT 0;

SELECT
  model_pricing_sync_state.status,
  model_pricing_sync_state.last_success_at,
  model_pricing_sync_state.active_generation
FROM model_pricing_sync_state
LIMIT 0;

SELECT
  model_pricing_staging.generation_id,
  model_pricing_staging.provider,
  model_pricing_staging.model_id
FROM model_pricing_staging
LIMIT 0;
