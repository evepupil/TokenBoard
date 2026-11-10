# Third Party Notices

This directory and its subdirectories contain frozen pricing data ported from
the following open-source projects and data sources. Each is used under its
respective license.

---

## ccusage (v20.0.33, commit 1308c416)

- Source: https://github.com/ryoppippi/ccusage
- License: MIT
- Files:
  - `clients/go/internal/nativepricing/data/models-dev-pricing.json`
  - `clients/go/internal/nativepricing/data/models-dev-catalog-rules.json`
  - `clients/go/internal/nativepricing/data/fast-multipliers.json`
  - `clients/go/internal/nativepricing/data/flex-multipliers.json`
  - `clients/go/internal/nativepricing/corpus.go` (architecture and constants
    ported from `rust/crates/ccusage-core/src/pricing.rs` and `build.rs`)

The client used to redistribute ccusage binaries inside its release archives.
Since 2026-11-10 it does not: every source collects in process, and the
archives carry only `tokenboard`. The MIT notice above is kept for the source
derived from ccusage that remains compiled into the client.

ccusage is Copyright (c) 2025 ryoppippi. Permission is hereby granted, free of
charge, to any person obtaining a copy of this software and associated
documentation files (the "Software"), to deal in the Software without
restriction, including without limitation the rights to use, copy, modify,
merge, publish, distribute, sublicense, and/or sell copies of the Software, and
to permit persons to whom the Software is furnished to do so, subject to the
following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

---

## LiteLLM (rev 6e0f0f7adb3083fb6681e636c947e3d6b8f53b26)

- Source: https://github.com/BerriAI/litellm
- License: MIT (code outside the `enterprise/` directory)
- File: `clients/go/internal/nativepricing/data/litellm.json`

Portions of this software are licensed as follows:

* All content that resides under the "enterprise/" directory of this repository,
  if that directory exists, is licensed under the license defined in
  "enterprise/LICENSE".
* Content outside of the above mentioned directories or restrictions above is
  available under the MIT license as defined below.

The MIT License applies to the LiteLLM snapshot included in this repository,
which is derived from code outside the `enterprise/` directory.

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
the Software, and to permit persons to whom the Software is furnished to do so,
subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

---

## models.dev pricing data

- Source: https://models.dev/api.json
- Retrieved from the ccusage v20.0.33 vendored snapshot.
- Date: 2026-10-14 (ccusage v20.0.33 tag date)
- Files:
  - `clients/go/internal/nativepricing/data/models-dev-pricing.json`
  - `clients/go/internal/nativepricing/data/models-dev-catalog-rules.json`

models.dev is an open model catalogue that aggregates publicly available pricing
data from model providers. The data is used for informational billing estimation
purposes only and is not guaranteed to be current. Refer to each model
provider's official pricing page for authoritative rates.
