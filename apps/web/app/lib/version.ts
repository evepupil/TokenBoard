// The worker and the collector ship on different clocks, so they carry different version
// numbers. This file is the single source for both; the footer and `/api/public/version`
// read them from here so the two surfaces cannot drift apart.
//
// - `serverVersion` is this Worker's version. Every production deploy that changes
//   behaviour bumps it (patch for fixes, minor for new surface). It starts at 0.1.0
//   because the web app never had a version before this file existed.
// - `clientVersion` is the newest **published** TokenBoard client (collector) release —
//   the build a user can actually download today. It tracks `gh release list`, not a local
//   or unreleased build: the footer says "客户端 v0.2.0" only while v0.2.0 is the newest
//   non-draft release. It is bumped when a client release is published, never when the
//   Worker deploys. (A locally built client that is newer than the published one is a
//   per-user state; it shows on the devices page, not here.)
//
// Both are displayed to users and served over HTTP, so treat them as public: never put a
// deployment identifier, commit hash or anything environment-specific here. A per-device
// client version (what a user actually has installed) comes from `device_installations`,
// not from this constant.
export const serverVersion = '0.1.0'
export const clientVersion = '0.2.0'
