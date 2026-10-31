import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineConfig } from 'vitest/config'

// `defaultStateDir()` falls back to `~/.tokenboard`, and the pricing catalogue is read from
// `<stateDir>/model-pricing-cache.json`. A developer machine that has actually run the
// collector therefore has a fresh cache, which flips `loadModelPricingCatalogue` from the
// bundled static config to a generated `ccusage.dynamic.json` — and every provider test that
// asserts the `--config` argument fails. CI has an empty HOME, so this only ever went red
// locally, which is the wrong way round: the suite has to behave the same on both.
//
// A per-run temporary directory keeps the tests hermetic without changing what production
// resolves.
process.env.TOKENBOARD_STATE_DIR = mkdtempSync(join(tmpdir(), 'tokenboard-collector-tests-'))

export default defineConfig({
  test: {
    // Vitest's 5s default is a per-test wall clock, and several cases here spawn
    // SQLite fixtures or language-server stand-ins; under full-suite parallelism
    // on a shared runner those exceeded it and failed without being wrong. The
    // suite-level floor is 30s; the heaviest cases still carry their own
    // explicit, longer timeouts.
    testTimeout: 30_000,
    env: {
      TOKENBOARD_STATE_DIR: process.env.TOKENBOARD_STATE_DIR
    }
  }
})
