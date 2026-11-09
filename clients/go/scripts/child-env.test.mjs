import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { SCRUBBED_ENV_KEYS, scrubbedEnv } from "./child-env.mjs";

// The generator scripts exec third-party binaries; AGENTS.md requires the
// collector credentials never to appear in a child's environment. The list is
// mirrored in packages/collector/src/child-env.ts, internal/ccusage/credentials.go
// and skills/tokenboard/scripts/child-env.mjs — a drift means one spawn path
// leaks what the others strip.
test("scrubbedEnv removes exactly the collector credential keys", () => {
  assert.deepEqual(SCRUBBED_ENV_KEYS.slice().sort(), [
    "TOKENBOARD_PAIRING_CODE",
    "TOKENBOARD_RELEASE_BASE_URL",
    "TOKENBOARD_REPO_URL",
    "TOKENBOARD_UPLOAD_TOKEN",
  ]);

  const env = scrubbedEnv({
    PATH: "/usr/bin",
    TOKENBOARD_UPLOAD_TOKEN: "tb_upload_secret",
    TOKENBOARD_PAIRING_CODE: "pairing",
    TOKENBOARD_RELEASE_BASE_URL: "https://release.example",
    TOKENBOARD_REPO_URL: "https://repo.example",
  });

  assert.deepEqual(env, { PATH: "/usr/bin" });
});

test("the key list matches the Go and skill mirrors", () => {
  const mirrors = [
    new URL("../internal/ccusage/credentials.go", import.meta.url),
    new URL("../../../skills/tokenboard/scripts/child-env.mjs", import.meta.url),
  ];
  for (const mirror of mirrors) {
    const source = readFileSync(mirror, "utf8");
    for (const key of SCRUBBED_ENV_KEYS) {
      assert.ok(source.includes(key), `${mirror.pathname} is missing ${key}`);
    }
  }
});

test("scrubbedEnv copies instead of mutating", () => {
  const original = { TOKENBOARD_UPLOAD_TOKEN: "x", HOME: "/home/x" };
  scrubbedEnv(original);
  assert.equal(original.TOKENBOARD_UPLOAD_TOKEN, "x");
});
