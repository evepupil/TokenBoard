import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, test } from 'vitest'
import { createSqliteD1, runSql } from '../../test/sqlite-d1'
import { D1DevicePairingRepository } from './repository'
import { pairDevice, renameDevice, revokeDevice, revokeInstallation, revokeUploadToken } from './service'

const crashFixturePath = fileURLToPath(new URL('../../test/fixtures/device-pairing-crash.ts', import.meta.url))

describe('device pairing sqlite contract', () => {
  const tempDirs: string[] = []

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('rolls back pairing consumption when credential creation fails', async () => {
    const { dbPath } = createDeviceDb(tempDirs)
    seedPairing(dbPath)

    const result = spawnSync(process.execPath, ['--import', 'tsx', crashFixturePath, dbPath], {
      encoding: 'utf8'
    })

    expect(result.status, result.stderr).toBe(42)
    expect(readScalar(dbPath, "SELECT consumed_at FROM pairing_codes WHERE id = 'pair_1'")).toBeNull()
    expect(readCount(dbPath, "SELECT COUNT(*) FROM devices WHERE id = 'dev_attempt'")).toBe(0)
    expect(readCount(dbPath, "SELECT COUNT(*) FROM device_installations WHERE id = 'inst_attempt'")).toBe(0)
    expect(readCount(dbPath, "SELECT COUNT(*) FROM upload_tokens WHERE id = 'ut_attempt'")).toBe(0)
    expect(readCount(dbPath, "SELECT COUNT(*) FROM audit_logs WHERE id = 'audit_attempt'")).toBe(0)
  }, 15000)

  test('creates credentials and consumes the pairing code in one batch', async () => {
    const { db, dbPath } = createDeviceDb(tempDirs)
    seedPairing(dbPath)

    const result = await pairDevice(new D1DevicePairingRepository(db), pairingRequest(), pairingDeps())

    expect(result.deviceId).toBe('dev_attempt')
    expect(readScalar(dbPath, "SELECT consumed_at FROM pairing_codes WHERE id = 'pair_1'")).toBe(
      '2026-07-11T01:00:00.000Z'
    )
    expect(readCount(dbPath, "SELECT COUNT(*) FROM device_installations WHERE id = 'inst_attempt'")).toBe(1)
    expect(readCount(dbPath, "SELECT COUNT(*) FROM upload_tokens WHERE id = 'ut_attempt'")).toBe(1)
    expect(readCount(dbPath, "SELECT COUNT(*) FROM audit_logs WHERE id = 'audit_attempt'")).toBe(1)
  })

  test('rejects a new-device pairing consumed after lookup without writing orphan credentials', async () => {
    const { db, dbPath } = createDeviceDb(tempDirs)
    seedPairing(dbPath)
    const repository = new D1DevicePairingRepository(db)
    const findUsablePairingCode = repository.findUsablePairingCode.bind(repository)
    repository.findUsablePairingCode = async (codeHash, now) => {
      const pairing = await findUsablePairingCode(codeHash, now)
      runSql(
        dbPath,
        `
        UPDATE pairing_codes
        SET consumed_at = '2026-07-11T01:00:01.000Z'
        WHERE id = 'pair_1';
      `
      )
      return pairing
    }

    await expect(pairDevice(repository, pairingRequest(), pairingDeps())).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
      message: 'Invalid or expired pairing code'
    })

    expect(readCount(dbPath, "SELECT COUNT(*) FROM devices WHERE id = 'dev_attempt'")).toBe(0)
    expect(readCount(dbPath, "SELECT COUNT(*) FROM device_installations WHERE id = 'inst_attempt'")).toBe(0)
    expect(readCount(dbPath, "SELECT COUNT(*) FROM upload_tokens WHERE id = 'ut_attempt'")).toBe(0)
    expect(readCount(dbPath, "SELECT COUNT(*) FROM audit_logs WHERE id = 'audit_attempt'")).toBe(0)
  })

  test('rolls back every pairing write when the audit insert fails', async () => {
    const { db, dbPath } = createDeviceDb(tempDirs)
    seedPairing(dbPath)
    runSql(
      dbPath,
      `
      INSERT INTO audit_logs (
        id, user_id, actor_type, action, target_type, target_id, created_at
      ) VALUES (
        'audit_attempt', 'user_1', 'user', 'existing', 'device', null,
        '2026-07-11T00:00:00.000Z'
      );
    `
    )

    await expect(pairDevice(new D1DevicePairingRepository(db), pairingRequest(), pairingDeps())).rejects.toThrow()

    expect(readScalar(dbPath, "SELECT consumed_at FROM pairing_codes WHERE id = 'pair_1'")).toBeNull()
    expect(readCount(dbPath, "SELECT COUNT(*) FROM devices WHERE id = 'dev_attempt'")).toBe(0)
    expect(readCount(dbPath, "SELECT COUNT(*) FROM device_installations WHERE id = 'inst_attempt'")).toBe(0)
    expect(readCount(dbPath, "SELECT COUNT(*) FROM upload_tokens WHERE id = 'ut_attempt'")).toBe(0)
  })

  test('reports an inactive reconnect target when it is revoked after pairing-code lookup', async () => {
    const { db, dbPath } = createDeviceDb(tempDirs)
    seedReconnectPairing(dbPath)
    const repository = new D1DevicePairingRepository(db)
    expect(await repository.findUsablePairingCode('hash:reconnect-pairing', '2026-07-11T01:00:00.000Z')).not.toBeNull()
    runSql(
      dbPath,
      `
      UPDATE device_installations
      SET revoked_at = '2026-07-11T01:00:01.000Z'
      WHERE id = 'inst_old';
    `
    )

    await expect(
      repository.createUploadTokenAndInstallation({
        pairingCodeId: 'pair_reconnect',
        consumedAt: '2026-07-11T01:00:02.000Z',
        uploadTokenId: 'ut_reconnect',
        uploadTokenHash: 'hash:reconnect-upload',
        deviceId: 'dev_old',
        installationId: 'inst_reconnect',
        installClaimHash: 'hash:reconnect-claim',
        userId: 'user_1',
        deviceName: 'Reinstalled',
        platform: 'linux',
        auditLogId: 'audit_reconnect',
        auditAction: 'device.reconnect',
        createdAt: '2026-07-11T01:00:02.000Z'
      })
    ).rejects.toThrow('Reconnect target is no longer active')

    expect(readCount(dbPath, "SELECT COUNT(*) FROM device_installations WHERE id = 'inst_reconnect'")).toBe(0)
    expect(readScalar(dbPath, "SELECT consumed_at FROM pairing_codes WHERE id = 'pair_reconnect'")).toBeNull()
  })

  test('creates reconnect credentials and consumes the reconnect pairing code in one batch', async () => {
    const { db, dbPath } = createDeviceDb(tempDirs)
    seedReconnectPairing(dbPath)

    const result = await pairDevice(
      new D1DevicePairingRepository(db),
      {
        pairingCode: 'reconnect-pairing',
        deviceName: 'Reinstalled workstation',
        platform: 'darwin',
        timezone: 'UTC'
      },
      pairingDeps()
    )

    expect(result.deviceId).toBe('dev_old')
    expect(readScalar(dbPath, "SELECT consumed_at FROM pairing_codes WHERE id = 'pair_reconnect'")).toBe(
      '2026-07-11T01:00:00.000Z'
    )
    expect(readCount(dbPath, "SELECT COUNT(*) FROM device_installations WHERE id = 'inst_attempt'")).toBe(1)
    expect(readCount(dbPath, "SELECT COUNT(*) FROM upload_tokens WHERE id = 'ut_attempt'")).toBe(1)
    expect(readCount(dbPath, "SELECT COUNT(*) FROM audit_logs WHERE id = 'audit_attempt'")).toBe(1)
  })

  test('preserves a device-link claim when the pairing code is consumed after lookup', async () => {
    const { db, dbPath } = createDeviceDb(tempDirs)
    seedReconnectPairing(dbPath)
    const repository = new D1DevicePairingRepository(db)
    expect(await repository.findUsablePairingCode('hash:reconnect-pairing', '2026-07-11T01:00:00.000Z')).not.toBeNull()
    runSql(
      dbPath,
      `
      UPDATE pairing_codes
      SET consumed_at = '2026-07-11T01:00:01.000Z'
      WHERE id = 'pair_reconnect';
    `
    )

    await expect(
      repository.createUploadTokenAndInstallation({
        pairingCodeId: 'pair_reconnect',
        consumedAt: '2026-07-11T01:00:02.000Z',
        uploadTokenId: 'ut_reconnect',
        uploadTokenHash: 'hash:reconnect-upload',
        deviceId: 'dev_old',
        installationId: 'inst_reconnect',
        installClaimHash: 'hash:reconnect-claim',
        userId: 'user_1',
        deviceName: 'Reinstalled',
        platform: 'linux',
        auditLogId: 'audit_reconnect',
        auditAction: 'device.reconnect',
        createdAt: '2026-07-11T01:00:02.000Z',
        sourceInstallationId: 'inst_old',
        sourceInstallClaimHash: 'hash:old-claim',
        consumedInstallClaimHash: 'hash:consumed-claim'
      })
    ).rejects.toThrow('Reconnect pairing code is no longer current')

    expect(
      readColumn(
        dbPath,
        "SELECT install_claim_hash FROM device_installations WHERE id = 'inst_old'",
        'install_claim_hash'
      )
    ).toBe('hash:old-claim')
    expect(readCount(dbPath, "SELECT COUNT(*) FROM device_installations WHERE id = 'inst_reconnect'")).toBe(0)
  })

  test('rejects a rotated device-link source claim without creating reconnect credentials', async () => {
    const { db, dbPath } = createDeviceDb(tempDirs)
    seedReconnectPairing(dbPath)
    runSql(
      dbPath,
      `
      UPDATE device_installations
      SET install_claim_hash = 'hash:rotated-claim'
      WHERE id = 'inst_old';
    `
    )

    await expect(
      new D1DevicePairingRepository(db).createUploadTokenAndInstallation({
        pairingCodeId: 'pair_reconnect',
        consumedAt: '2026-07-11T01:00:02.000Z',
        uploadTokenId: 'ut_reconnect',
        uploadTokenHash: 'hash:reconnect-upload',
        deviceId: 'dev_old',
        installationId: 'inst_reconnect',
        installClaimHash: 'hash:reconnect-claim',
        userId: 'user_1',
        deviceName: 'Reinstalled',
        platform: 'linux',
        auditLogId: 'audit_reconnect',
        auditAction: 'device.reconnect',
        createdAt: '2026-07-11T01:00:02.000Z',
        sourceInstallationId: 'inst_old',
        sourceInstallClaimHash: 'hash:old-claim',
        consumedInstallClaimHash: 'hash:consumed-claim'
      })
    ).rejects.toThrow('Reconnect source installation is no longer current')

    expect(
      readColumn(
        dbPath,
        "SELECT install_claim_hash FROM device_installations WHERE id = 'inst_old'",
        'install_claim_hash'
      )
    ).toBe('hash:rotated-claim')
    expect(readScalar(dbPath, "SELECT consumed_at FROM pairing_codes WHERE id = 'pair_reconnect'")).toBeNull()
    expect(readCount(dbPath, "SELECT COUNT(*) FROM device_installations WHERE id = 'inst_reconnect'")).toBe(0)
    expect(readCount(dbPath, "SELECT COUNT(*) FROM upload_tokens WHERE id = 'ut_reconnect'")).toBe(0)
    expect(readCount(dbPath, "SELECT COUNT(*) FROM audit_logs WHERE id = 'audit_reconnect'")).toBe(0)
  })

  test('rolls back source-claim consumption when reconnect auditing fails', async () => {
    const { db, dbPath } = createDeviceDb(tempDirs)
    seedReconnectPairing(dbPath)
    runSql(
      dbPath,
      `
      INSERT INTO audit_logs (
        id, user_id, actor_type, action, target_type, target_id, created_at
      ) VALUES (
        'audit_reconnect', 'user_1', 'user', 'existing', 'device', 'dev_old',
        '2026-07-11T00:00:00.000Z'
      );
    `
    )

    await expect(
      new D1DevicePairingRepository(db).createUploadTokenAndInstallation({
        pairingCodeId: 'pair_reconnect',
        consumedAt: '2026-07-11T01:00:02.000Z',
        uploadTokenId: 'ut_reconnect',
        uploadTokenHash: 'hash:reconnect-upload',
        deviceId: 'dev_old',
        installationId: 'inst_reconnect',
        installClaimHash: 'hash:reconnect-claim',
        userId: 'user_1',
        deviceName: 'Reinstalled',
        platform: 'linux',
        auditLogId: 'audit_reconnect',
        auditAction: 'device.reconnect',
        createdAt: '2026-07-11T01:00:02.000Z',
        sourceInstallationId: 'inst_old',
        sourceInstallClaimHash: 'hash:old-claim',
        consumedInstallClaimHash: 'hash:consumed-claim'
      })
    ).rejects.toThrow()

    expect(
      readColumn(
        dbPath,
        "SELECT install_claim_hash FROM device_installations WHERE id = 'inst_old'",
        'install_claim_hash'
      )
    ).toBe('hash:old-claim')
    expect(readScalar(dbPath, "SELECT consumed_at FROM pairing_codes WHERE id = 'pair_reconnect'")).toBeNull()
    expect(readCount(dbPath, "SELECT COUNT(*) FROM device_installations WHERE id = 'inst_reconnect'")).toBe(0)
    expect(readCount(dbPath, "SELECT COUNT(*) FROM upload_tokens WHERE id = 'ut_reconnect'")).toBe(0)
  })
})

describe('device revocation sqlite contract', () => {
  const tempDirs: string[] = []

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('rolls back device revocation when the audit insert fails', async () => {
    const { db, dbPath } = createDeviceDb(tempDirs)
    seedRevocationTarget(dbPath)
    rejectRevocationAudits(dbPath)

    await expect(
      revokeDevice(db, {
        userId: 'user_1',
        deviceId: 'dev_1',
        now: '2026-07-11T01:00:00.000Z'
      })
    ).rejects.toThrow('audit failed')

    expect(readColumn(dbPath, "SELECT revoked_at FROM upload_tokens WHERE id = 'ut_1'", 'revoked_at')).toBeNull()
    expect(
      readColumn(dbPath, "SELECT revoked_at FROM device_installations WHERE id = 'inst_1'", 'revoked_at')
    ).toBeNull()
    expect(readColumn(dbPath, "SELECT updated_at FROM devices WHERE id = 'dev_1'", 'updated_at')).toBe(
      '2026-07-11T00:00:00.000Z'
    )
  })

  test('rolls back installation revocation when the audit insert fails', async () => {
    const { db, dbPath } = createDeviceDb(tempDirs)
    seedRevocationTarget(dbPath)
    rejectRevocationAudits(dbPath)

    await expect(
      revokeInstallation(db, {
        userId: 'user_1',
        installationId: 'inst_1',
        now: '2026-07-11T01:00:00.000Z'
      })
    ).rejects.toThrow('audit failed')

    expect(readColumn(dbPath, "SELECT revoked_at FROM upload_tokens WHERE id = 'ut_1'", 'revoked_at')).toBeNull()
    expect(
      readColumn(dbPath, "SELECT revoked_at FROM device_installations WHERE id = 'inst_1'", 'revoked_at')
    ).toBeNull()
  })

  test('rolls back a device rename when the audit insert fails', async () => {
    const { db, dbPath } = createDeviceDb(tempDirs)
    seedRevocationTarget(dbPath)
    rejectAuditAction(dbPath, 'device.rename')

    await expect(
      renameDevice(db, {
        userId: 'user_1',
        deviceId: 'dev_1',
        name: 'Renamed',
        now: '2026-07-11T01:00:00.000Z'
      })
    ).rejects.toThrow('audit failed')

    expect(readColumn(dbPath, "SELECT name FROM devices WHERE id = 'dev_1'", 'name')).toBe('Workstation')
  })

  test('does not record a second installation audit when the state change loses a race', async () => {
    const { db, dbPath } = createDeviceDb(tempDirs)
    seedRevocationTarget(dbPath)
    const input = {
      userId: 'user_1',
      installationId: 'inst_1',
      now: '2026-07-11T01:00:00.000Z'
    }

    await revokeInstallation(db, input)
    await expect(revokeInstallation(db, input)).rejects.toThrow('Installation not found')

    expect(readCount(dbPath, "SELECT COUNT(*) FROM audit_logs WHERE action = 'installation.revoke'")).toBe(1)
  })

  test('does not record a second token audit when the state change loses a race', async () => {
    const { db, dbPath } = createDeviceDb(tempDirs)
    seedRevocationTarget(dbPath)
    const input = {
      userId: 'user_1',
      uploadTokenId: 'ut_1',
      now: '2026-07-11T01:00:00.000Z'
    }

    await revokeUploadToken(db, input)
    await expect(revokeUploadToken(db, input)).rejects.toThrow('Upload token not found')

    expect(readCount(dbPath, "SELECT COUNT(*) FROM audit_logs WHERE action = 'token.revoke'")).toBe(1)
  })
})

function createDeviceDb(tempDirs: string[]) {
  const root = mkdtempSync(join(tmpdir(), 'tokenboard-device-contract-'))
  tempDirs.push(root)
  const dbPath = join(root, 'device.db')
  runSql(
    dbPath,
    `
    PRAGMA foreign_keys = ON;
    CREATE TABLE users (id TEXT PRIMARY KEY NOT NULL);
    CREATE TABLE pairing_codes (
      id TEXT PRIMARY KEY NOT NULL,
      user_id TEXT NOT NULL,
      code_hash TEXT NOT NULL UNIQUE,
      pairing_type TEXT NOT NULL,
      target_device_id TEXT,
      metadata TEXT,
      expires_at TEXT NOT NULL,
      consumed_at TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE devices (
      id TEXT PRIMARY KEY NOT NULL,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      platform TEXT NOT NULL,
      last_synced_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE device_installations (
      id TEXT PRIMARY KEY NOT NULL,
      user_id TEXT NOT NULL,
      device_id TEXT NOT NULL REFERENCES devices(id),
      platform TEXT NOT NULL,
      hostname TEXT,
      client_version TEXT,
      install_claim_hash TEXT,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT,
      revoked_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE upload_tokens (
      id TEXT PRIMARY KEY NOT NULL,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      device_id TEXT,
      installation_id TEXT,
      supersedes_token_id TEXT,
      last_used_at TEXT,
      created_at TEXT NOT NULL,
      revoked_at TEXT
    );
    CREATE TABLE audit_logs (
      id TEXT PRIMARY KEY NOT NULL,
      user_id TEXT NOT NULL,
      actor_type TEXT NOT NULL,
      action TEXT NOT NULL,
      target_type TEXT NOT NULL,
      target_id TEXT,
      metadata TEXT,
      created_at TEXT NOT NULL
    );
  `
  )
  return { db: createSqliteD1(dbPath), dbPath }
}

function seedPairing(dbPath: string) {
  runSql(
    dbPath,
    `
    INSERT INTO users (id) VALUES ('user_1');
    INSERT INTO pairing_codes (
      id, user_id, code_hash, pairing_type, expires_at, created_at
    ) VALUES (
      'pair_1', 'user_1', 'hash:pairing-code', 'new_device',
      '2026-07-11T02:00:00.000Z', '2026-07-11T00:00:00.000Z'
    );
  `
  )
}

function seedRevocationTarget(dbPath: string) {
  runSql(
    dbPath,
    `
    INSERT INTO users (id) VALUES ('user_1');
    INSERT INTO devices (
      id, user_id, name, platform, created_at, updated_at
    ) VALUES (
      'dev_1', 'user_1', 'Workstation', 'linux',
      '2026-07-11T00:00:00.000Z', '2026-07-11T00:00:00.000Z'
    );
    INSERT INTO device_installations (
      id, user_id, device_id, platform, install_claim_hash,
      first_seen_at, created_at, updated_at
    ) VALUES (
      'inst_1', 'user_1', 'dev_1', 'linux', 'hash:claim',
      '2026-07-11T00:00:00.000Z', '2026-07-11T00:00:00.000Z',
      '2026-07-11T00:00:00.000Z'
    );
    INSERT INTO upload_tokens (
      id, user_id, name, token_hash, device_id, installation_id, created_at
    ) VALUES (
      'ut_1', 'user_1', 'Workstation', 'hash:upload', 'dev_1', 'inst_1',
      '2026-07-11T00:00:00.000Z'
    );
  `
  )
}

function seedReconnectPairing(dbPath: string) {
  runSql(
    dbPath,
    `
    INSERT INTO users (id) VALUES ('user_1');
    INSERT INTO devices (
      id, user_id, name, platform, created_at, updated_at
    ) VALUES (
      'dev_old', 'user_1', 'Workstation', 'linux',
      '2026-07-11T00:00:00.000Z', '2026-07-11T00:00:00.000Z'
    );
    INSERT INTO device_installations (
      id, user_id, device_id, platform, install_claim_hash,
      first_seen_at, created_at, updated_at
    ) VALUES (
      'inst_old', 'user_1', 'dev_old', 'linux', 'hash:old-claim',
      '2026-07-11T00:00:00.000Z', '2026-07-11T00:00:00.000Z',
      '2026-07-11T00:00:00.000Z'
    );
    INSERT INTO pairing_codes (
      id, user_id, code_hash, pairing_type, target_device_id,
      expires_at, created_at
    ) VALUES (
      'pair_reconnect', 'user_1', 'hash:reconnect-pairing', 'reconnect_device',
      'dev_old', '2026-07-11T02:00:00.000Z', '2026-07-11T00:00:00.000Z'
    );
  `
  )
}

function rejectRevocationAudits(dbPath: string) {
  runSql(
    dbPath,
    `
    CREATE TRIGGER reject_revocation_audit
    BEFORE INSERT ON audit_logs
    WHEN NEW.action IN ('device.revoke', 'installation.revoke')
    BEGIN
      SELECT RAISE(ABORT, 'audit failed');
    END;
  `
  )
}

function rejectAuditAction(dbPath: string, action: string) {
  runSql(
    dbPath,
    `
    CREATE TRIGGER reject_selected_audit
    BEFORE INSERT ON audit_logs
    WHEN NEW.action = '${action}'
    BEGIN
      SELECT RAISE(ABORT, 'audit failed');
    END;
  `
  )
}

function pairingRequest() {
  return {
    pairingCode: 'pairing-code',
    deviceName: 'Workstation',
    platform: 'linux',
    timezone: 'UTC'
  }
}

function pairingDeps() {
  return {
    now: () => '2026-07-11T01:00:00.000Z',
    endpoint: 'https://tokenboard.example/api/v1/ingest',
    randomId: () => 'attempt',
    randomToken: () => 'upload-token',
    randomInstallClaim: () => 'install-claim',
    hash: async (value: string) => `hash:${value}`
  }
}

function readScalar(dbPath: string, sql: string) {
  const output = runSql(dbPath, `.mode json\n${sql};`)
  return (JSON.parse(output || '[]') as Array<Record<string, unknown>>)[0]?.consumed_at ?? null
}

function readCount(dbPath: string, sql: string) {
  const output = runSql(dbPath, `.mode json\n${sql};`)
  const row = (JSON.parse(output || '[]') as Array<Record<string, unknown>>)[0]
  return Number(row?.['COUNT(*)'] ?? 0)
}

function readColumn(dbPath: string, sql: string, column: string) {
  const output = runSql(dbPath, `.mode json\n${sql};`)
  return (JSON.parse(output || '[]') as Array<Record<string, unknown>>)[0]?.[column] ?? null
}
