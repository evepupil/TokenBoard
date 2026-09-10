import { describe, expect, test } from 'vitest'
import { D1DevicePairingRepository } from './repository'

type BatchResult = {
  success?: boolean
  error?: string
  meta?: {
    changes?: number
  }
}

function createRecordingDb(
  firstResult: unknown = null,
  batchResults: BatchResult[] | null = null,
  runResult: BatchResult = { meta: { changes: 1 } }
) {
  const sqlStatements: string[] = []
  const bindings: unknown[][] = []
  const batches: unknown[][] = []
  const db = {
    prepare(sql: string) {
      sqlStatements.push(sql)
      return {
        bind(...values: unknown[]) {
          bindings.push(values)
          return {
            async first() {
              return firstResult
            },
            async run() {
              return runResult
            }
          }
        }
      }
    },
    async batch(statements: unknown[]) {
      batches.push(statements)
      return batchResults ?? statements.map(() => ({ success: true, meta: { changes: 1 } }))
    }
  } as unknown as D1Database

  return { db, sqlStatements, bindings, batches }
}

describe('D1DevicePairingRepository', () => {
  test('stores reconnect pairing code only when the target has an active installation', async () => {
    const { db, sqlStatements, bindings } = createRecordingDb()
    const repository = new D1DevicePairingRepository(db)

    await repository.createPairingCode({
      pairingCodeId: 'pair_1',
      userId: 'user_1',
      codeHash: 'hash:pair',
      pairingType: 'reconnect_device',
      targetDeviceId: 'dev_old',
      metadata: '{"reason":"reconnect"}',
      expiresAt: '2026-06-30T10:30:00.000Z',
      createdAt: '2026-06-30T10:00:00.000Z'
    })

    expect(sqlStatements[0]).toContain('INSERT INTO pairing_codes')
    expect(sqlStatements[0]).toContain('pairing_type')
    expect(sqlStatements[0]).toContain('target_device_id')
    expect(sqlStatements[0]).toContain('WHERE EXISTS')
    expect(sqlStatements[0]).toContain('FROM device_installations')
    expect(sqlStatements[0]).toContain('revoked_at IS NULL')
    expect(bindings[0]).toEqual([
      'pair_1',
      'user_1',
      'hash:pair',
      'reconnect_device',
      'dev_old',
      '{"reason":"reconnect"}',
      '2026-06-30T10:30:00.000Z',
      '2026-06-30T10:00:00.000Z',
      'user_1',
      'dev_old'
    ])
  })

  test('rejects reconnect pairing code creation without an active installation', async () => {
    const { db } = createRecordingDb(null, null, { meta: { changes: 0 } })
    const repository = new D1DevicePairingRepository(db)

    await expect(
      repository.createPairingCode({
        pairingCodeId: 'pair_1',
        userId: 'user_1',
        codeHash: 'hash:pair',
        pairingType: 'reconnect_device',
        targetDeviceId: 'dev_old',
        expiresAt: '2026-06-30T10:30:00.000Z',
        createdAt: '2026-06-30T10:00:00.000Z'
      })
    ).rejects.toThrow('Device has no active installation')
  })

  test('writes reconnect pairing, invalidates older codes, and audits without rotating the source claim', async () => {
    const { db, sqlStatements, bindings, batches } = createRecordingDb()
    const repository = new D1DevicePairingRepository(db)

    await repository.createReconnectPairingCodeExchange({
      pairingCodeId: 'pair_1',
      userId: 'user_1',
      codeHash: 'hash:pair',
      deviceId: 'dev_old',
      installationId: 'inst_1',
      previousInstallClaimHash: 'hash:old',
      pairingMetadata: '{"method":"device-link"}',
      auditLogId: 'audit_1',
      auditMetadata: '{"installationId":"inst_1"}',
      expiresAt: '2026-06-30T10:30:00.000Z',
      createdAt: '2026-06-30T10:00:00.000Z'
    })

    expect(batches).toHaveLength(1)
    expect(batches[0]).toHaveLength(3)
    expect(sqlStatements[0]).toContain('INSERT INTO pairing_codes')
    expect(sqlStatements[0]).toContain('WHERE EXISTS')
    expect(sqlStatements[0]).toContain('FROM device_installations')
    expect(sqlStatements[0]).not.toContain('UPDATE device_installations')
    expect(sqlStatements[0]).not.toContain('changes()')
    expect(sqlStatements[1]).toContain('UPDATE pairing_codes')
    expect(sqlStatements[1]).toContain('SET consumed_at = ?')
    expect(sqlStatements[1]).toContain('AND EXISTS')
    expect(sqlStatements[1]).toContain('id != ?')
    expect(sqlStatements[1]).not.toContain('changes()')
    expect(sqlStatements[2]).toContain('INSERT INTO audit_logs')
    expect(sqlStatements[2]).toContain('WHERE EXISTS')
    expect(sqlStatements[2]).toContain('FROM pairing_codes')
    expect(sqlStatements[2]).not.toContain('changes()')
    expect(bindings).toHaveLength(3)
    expect(bindings[0]).toEqual([
      'pair_1',
      'user_1',
      'hash:pair',
      'dev_old',
      '{"method":"device-link"}',
      '2026-06-30T10:30:00.000Z',
      '2026-06-30T10:00:00.000Z',
      'inst_1',
      'user_1',
      'dev_old',
      'hash:old'
    ])
    expect(bindings[1]).toEqual([
      '2026-06-30T10:00:00.000Z',
      'user_1',
      'dev_old',
      'pair_1',
      '2026-06-30T10:00:00.000Z',
      '{"method":"device-link"}',
      '{"method":"device-link"}',
      'pair_1',
      'user_1',
      'dev_old'
    ])
    expect(bindings[2]).toEqual([
      'audit_1',
      'user_1',
      'user',
      'device.reconnect.claim',
      'device',
      'dev_old',
      '{"installationId":"inst_1"}',
      '2026-06-30T10:00:00.000Z',
      'pair_1',
      'user_1',
      'dev_old'
    ])
  })

  test('writes null metadata for a reconnect exchange when metadata is absent', async () => {
    const { db, bindings } = createRecordingDb()
    const repository = new D1DevicePairingRepository(db)

    await repository.createReconnectPairingCodeExchange({
      pairingCodeId: 'pair_1',
      userId: 'user_1',
      codeHash: 'hash:pair',
      deviceId: 'dev_old',
      installationId: 'inst_1',
      previousInstallClaimHash: 'hash:old',
      auditLogId: 'audit_1',
      expiresAt: '2026-06-30T10:30:00.000Z',
      createdAt: '2026-06-30T10:00:00.000Z'
    })

    expect(bindings[0]?.[4]).toBeNull()
    expect(bindings[1]?.[5]).toBeNull()
    expect(bindings[1]?.[6]).toBeNull()
    expect(bindings[2]?.[6]).toBeNull()
  })

  test('surfaces a failed reconnect batch before returning success', async () => {
    const { db } = createRecordingDb(null, [
      { success: false, error: 'constraint failed' },
      { success: true, meta: { changes: 1 } }
    ])
    const repository = new D1DevicePairingRepository(db)

    await expect(
      repository.createReconnectPairingCodeExchange({
        pairingCodeId: 'pair_1',
        userId: 'user_1',
        codeHash: 'hash:pair',
        deviceId: 'dev_old',
        installationId: 'inst_1',
        previousInstallClaimHash: 'hash:old',
        auditLogId: 'audit_1',
        expiresAt: '2026-06-30T10:30:00.000Z',
        createdAt: '2026-06-30T10:00:00.000Z'
      })
    ).rejects.toThrow('D1 batch statement 1 failed: constraint failed')
  })

  test('surfaces an incomplete reconnect batch result', async () => {
    const { db } = createRecordingDb(null, [{ success: true, meta: { changes: 1 } }])
    const repository = new D1DevicePairingRepository(db)

    await expect(
      repository.createReconnectPairingCodeExchange({
        pairingCodeId: 'pair_1',
        userId: 'user_1',
        codeHash: 'hash:pair',
        deviceId: 'dev_old',
        installationId: 'inst_1',
        previousInstallClaimHash: 'hash:old',
        auditLogId: 'audit_1',
        expiresAt: '2026-06-30T10:30:00.000Z',
        createdAt: '2026-06-30T10:00:00.000Z'
      })
    ).rejects.toThrow('D1 batch statement 2 failed: expected 3 results, received 1')
  })

  test('rejects a reconnect exchange when the stored claim no longer matches', async () => {
    const { db } = createRecordingDb(null, [
      { success: true, meta: { changes: 0 } },
      { success: true, meta: { changes: 0 } },
      { success: true, meta: { changes: 0 } }
    ])
    const repository = new D1DevicePairingRepository(db)

    await expect(
      repository.createReconnectPairingCodeExchange({
        pairingCodeId: 'pair_1',
        userId: 'user_1',
        codeHash: 'hash:pair',
        deviceId: 'dev_old',
        installationId: 'inst_1',
        previousInstallClaimHash: 'hash:old',
        auditLogId: 'audit_1',
        expiresAt: '2026-06-30T10:30:00.000Z',
        createdAt: '2026-06-30T10:00:00.000Z'
      })
    ).rejects.toThrow('Invalid device link claim')
  })

  test('creates a logical device, installation, and upload token for new pairing', async () => {
    const { db, sqlStatements, bindings, batches } = createRecordingDb()
    const repository = new D1DevicePairingRepository(db)

    await repository.createUploadTokenAndDevice({
      pairingCodeId: 'pair_1',
      consumedAt: '2026-06-30T10:00:00.000Z',
      uploadTokenId: 'ut_1',
      uploadTokenHash: 'hash:upload',
      deviceId: 'dev_1',
      installationId: 'inst_1',
      installClaimHash: 'hash:claim',
      userId: 'user_1',
      deviceName: 'Workstation',
      platform: 'darwin',
      auditLogId: 'audit_1',
      auditAction: 'device.pair',
      auditMetadata: '{"installationId":"inst_1","platform":"darwin"}',
      createdAt: '2026-06-30T10:00:00.000Z'
    })

    expect(sqlStatements[0]).toContain('INSERT INTO devices')
    expect(sqlStatements[0]).toContain('SELECT ?, pairing.user_id')
    expect(sqlStatements[0]).toContain("pairing_type = 'new_device'")
    expect(sqlStatements[0]).toContain('pairing.consumed_at IS NULL')
    expect(sqlStatements[1]).toContain('INSERT INTO device_installations')
    expect(sqlStatements[1]).toContain('install_claim_hash')
    expect(sqlStatements[1]).toContain('JOIN pairing_codes pairing')
    expect(sqlStatements[2]).toContain('INSERT INTO upload_tokens')
    expect(sqlStatements[2]).toContain('installation_id')
    expect(sqlStatements[2]).toContain('JOIN pairing_codes pairing')
    expect(sqlStatements[3]).toContain('INSERT INTO audit_logs')
    expect(sqlStatements[3]).toContain('JOIN pairing_codes pairing')
    expect(sqlStatements[4]).toContain('UPDATE pairing_codes')
    expect(sqlStatements[4]).toContain('pairing_type = ?')
    expect(batches).toHaveLength(1)
    expect(batches[0]).toHaveLength(5)
    expect(bindings[0]).toEqual([
      'dev_1',
      'Workstation',
      'darwin',
      '2026-06-30T10:00:00.000Z',
      '2026-06-30T10:00:00.000Z',
      'pair_1',
      'user_1',
      '2026-06-30T10:00:00.000Z'
    ])
    expect(bindings[1]).toEqual([
      'inst_1',
      'darwin',
      'Workstation',
      'hash:claim',
      '2026-06-30T10:00:00.000Z',
      '2026-06-30T10:00:00.000Z',
      '2026-06-30T10:00:00.000Z',
      '2026-06-30T10:00:00.000Z',
      'pair_1',
      '2026-06-30T10:00:00.000Z',
      'dev_1',
      'user_1'
    ])
    expect(bindings[2]).toEqual([
      'ut_1',
      'Workstation',
      'hash:upload',
      '2026-06-30T10:00:00.000Z',
      'pair_1',
      '2026-06-30T10:00:00.000Z',
      'inst_1',
      'user_1',
      'dev_1'
    ])
    expect(bindings[3]).toEqual([
      'audit_1',
      'device.pair',
      '{"installationId":"inst_1","platform":"darwin"}',
      '2026-06-30T10:00:00.000Z',
      'pair_1',
      '2026-06-30T10:00:00.000Z',
      'inst_1',
      'user_1',
      'dev_1'
    ])
    expect(bindings[4]).toEqual([
      '2026-06-30T10:00:00.000Z',
      'pair_1',
      'user_1',
      'new_device',
      '2026-06-30T10:00:00.000Z',
      'ut_1',
      'user_1',
      'dev_1',
      'inst_1',
      'audit_1',
      'user_1'
    ])
  })

  test('surfaces a failed new-device credential batch before returning success', async () => {
    const { db } = createRecordingDb(null, [
      { success: true, meta: { changes: 1 } },
      { success: true, meta: { changes: 1 } },
      { success: false, error: 'constraint failed' },
      { success: true, meta: { changes: 1 } }
    ])
    const repository = new D1DevicePairingRepository(db)

    await expect(
      repository.createUploadTokenAndDevice({
        pairingCodeId: 'pair_1',
        consumedAt: '2026-06-30T10:00:00.000Z',
        uploadTokenId: 'ut_1',
        uploadTokenHash: 'hash:upload',
        deviceId: 'dev_1',
        installationId: 'inst_1',
        installClaimHash: 'hash:claim',
        userId: 'user_1',
        deviceName: 'Workstation',
        platform: 'darwin',
        auditLogId: 'audit_1',
        auditAction: 'device.pair',
        createdAt: '2026-06-30T10:00:00.000Z'
      })
    ).rejects.toThrow('D1 batch statement 3 failed: constraint failed')
  })

  test('surfaces an incomplete new-device credential batch result', async () => {
    const { db } = createRecordingDb(null, [
      { success: true, meta: { changes: 1 } },
      { success: true, meta: { changes: 1 } },
      { success: true, meta: { changes: 1 } }
    ])
    const repository = new D1DevicePairingRepository(db)

    await expect(
      repository.createUploadTokenAndDevice({
        pairingCodeId: 'pair_1',
        consumedAt: '2026-06-30T10:00:00.000Z',
        uploadTokenId: 'ut_1',
        uploadTokenHash: 'hash:upload',
        deviceId: 'dev_1',
        installationId: 'inst_1',
        installClaimHash: 'hash:claim',
        userId: 'user_1',
        deviceName: 'Workstation',
        platform: 'darwin',
        auditLogId: 'audit_1',
        auditAction: 'device.pair',
        createdAt: '2026-06-30T10:00:00.000Z'
      })
    ).rejects.toThrow('D1 batch statement 4 failed: expected 5 results, received 3')
  })

  test('rejects a new-device pairing batch when audit insert reports no changes', async () => {
    const { db } = createRecordingDb(null, [
      { success: true, meta: { changes: 1 } },
      { success: true, meta: { changes: 1 } },
      { success: true, meta: { changes: 1 } },
      { success: true, meta: { changes: 0 } },
      { success: true, meta: { changes: 1 } }
    ])
    const repository = new D1DevicePairingRepository(db)

    await expect(
      repository.createUploadTokenAndDevice({
        pairingCodeId: 'pair_1',
        consumedAt: '2026-06-30T10:00:00.000Z',
        uploadTokenId: 'ut_1',
        uploadTokenHash: 'hash:upload',
        deviceId: 'dev_1',
        installationId: 'inst_1',
        installClaimHash: 'hash:claim',
        userId: 'user_1',
        deviceName: 'Workstation',
        platform: 'darwin',
        auditLogId: 'audit_1',
        auditAction: 'device.pair',
        createdAt: '2026-06-30T10:00:00.000Z'
      })
    ).rejects.toThrow('Device pairing was not recorded')
  })

  test('guards the current pairing before consuming a device-link source claim', async () => {
    const { db, sqlStatements, bindings, batches } = createRecordingDb()
    const repository = new D1DevicePairingRepository(db)

    await repository.createUploadTokenAndInstallation({
      pairingCodeId: 'pair_1',
      consumedAt: '2026-06-30T10:00:00.000Z',
      uploadTokenId: 'ut_1',
      uploadTokenHash: 'hash:upload',
      deviceId: 'dev_old',
      installationId: 'inst_1',
      installClaimHash: 'hash:claim',
      userId: 'user_1',
      deviceName: 'Reinstalled',
      platform: 'linux',
      auditLogId: 'audit_1',
      auditAction: 'device.reconnect',
      auditMetadata: '{"installationId":"inst_1","platform":"linux"}',
      createdAt: '2026-06-30T10:00:00.000Z',
      sourceInstallationId: 'inst_old',
      sourceInstallClaimHash: 'hash:old-claim',
      consumedInstallClaimHash: 'hash:claim-consumed'
    })

    expect(sqlStatements.some((sql) => sql.includes('INSERT INTO devices'))).toBe(false)
    expect(sqlStatements[0]).toContain('UPDATE pairing_codes')
    expect(sqlStatements[0]).toContain("pairing_type = 'reconnect_device'")
    expect(sqlStatements[1]).toContain('UPDATE device_installations')
    expect(sqlStatements[1]).toContain('install_claim_hash = ?')
    expect(sqlStatements[1]).toContain('FROM pairing_codes pairing')
    expect(sqlStatements[2]).toContain('INSERT INTO device_installations')
    expect(sqlStatements[2]).toContain('JOIN pairing_codes pairing')
    expect(sqlStatements[2]).toContain('source.install_claim_hash = ?')
    expect(sqlStatements[3]).toContain('INSERT INTO upload_tokens')
    expect(sqlStatements[3]).toContain('WHERE EXISTS')
    expect(sqlStatements[4]).toContain('INSERT INTO audit_logs')
    expect(sqlStatements[4]).toContain('WHERE EXISTS')
    expect(batches).toHaveLength(1)
    expect(batches[0]).toHaveLength(6)
    expect(bindings[0]).toEqual(['pair_1', 'user_1', 'dev_old', '2026-06-30T10:00:00.000Z'])
    expect(bindings[1]).toEqual([
      'hash:claim-consumed',
      '2026-06-30T10:00:00.000Z',
      'inst_old',
      'user_1',
      'dev_old',
      'hash:old-claim',
      'pair_1',
      '2026-06-30T10:00:00.000Z'
    ])
    expect(bindings[2]).toEqual([
      'inst_1',
      'dev_old',
      'linux',
      'Reinstalled',
      'hash:claim',
      '2026-06-30T10:00:00.000Z',
      '2026-06-30T10:00:00.000Z',
      '2026-06-30T10:00:00.000Z',
      '2026-06-30T10:00:00.000Z',
      'pair_1',
      '2026-06-30T10:00:00.000Z',
      'user_1',
      'dev_old',
      'inst_old',
      'inst_old',
      'hash:claim-consumed',
      'hash:claim-consumed'
    ])
  })

  test('rejects partial source metadata before creating reconnect credentials', async () => {
    const { db, batches } = createRecordingDb()
    const repository = new D1DevicePairingRepository(db)

    await expect(
      repository.createUploadTokenAndInstallation({
        pairingCodeId: 'pair_1',
        consumedAt: '2026-06-30T10:00:00.000Z',
        uploadTokenId: 'ut_1',
        uploadTokenHash: 'hash:upload',
        deviceId: 'dev_old',
        installationId: 'inst_1',
        installClaimHash: 'hash:claim',
        userId: 'user_1',
        deviceName: 'Reinstalled',
        platform: 'linux',
        auditLogId: 'audit_1',
        auditAction: 'device.reconnect',
        createdAt: '2026-06-30T10:00:00.000Z',
        sourceInstallationId: 'inst_old'
      })
    ).rejects.toThrow('Reconnect source metadata is incomplete')
    expect(batches).toEqual([])
  })

  test('requires an active target installation for reconnect credentials without source metadata', async () => {
    const { db, sqlStatements, bindings, batches } = createRecordingDb()
    const repository = new D1DevicePairingRepository(db)

    await repository.createUploadTokenAndInstallation({
      pairingCodeId: 'pair_1',
      consumedAt: '2026-06-30T10:00:00.000Z',
      uploadTokenId: 'ut_1',
      uploadTokenHash: 'hash:upload',
      deviceId: 'dev_old',
      installationId: 'inst_1',
      installClaimHash: 'hash:claim',
      userId: 'user_1',
      deviceName: 'Reinstalled',
      platform: 'linux',
      auditLogId: 'audit_1',
      auditAction: 'device.reconnect',
      auditMetadata: '{"installationId":"inst_1","platform":"linux"}',
      createdAt: '2026-06-30T10:00:00.000Z'
    })

    expect(sqlStatements[0]).toContain('UPDATE pairing_codes')
    expect(sqlStatements[1]).toContain('INSERT INTO device_installations')
    expect(sqlStatements[1]).toContain('FROM device_installations source')
    expect(sqlStatements[1]).toContain('source.revoked_at IS NULL')
    expect(sqlStatements[1]).toContain('(? IS NULL OR source.id = ?)')
    expect(batches).toHaveLength(1)
    expect(batches[0]).toHaveLength(5)
    expect(bindings[1]?.slice(13, 17)).toEqual([null, null, null, null])
  })

  test('surfaces a failed reconnect credential batch before returning success', async () => {
    const { db } = createRecordingDb(null, [
      { success: true, meta: { changes: 1 } },
      { success: false, error: 'constraint failed' },
      { success: true, meta: { changes: 1 } },
      { success: true, meta: { changes: 1 } }
    ])
    const repository = new D1DevicePairingRepository(db)

    await expect(
      repository.createUploadTokenAndInstallation({
        pairingCodeId: 'pair_1',
        consumedAt: '2026-06-30T10:00:00.000Z',
        uploadTokenId: 'ut_1',
        uploadTokenHash: 'hash:upload',
        deviceId: 'dev_old',
        installationId: 'inst_1',
        installClaimHash: 'hash:claim',
        userId: 'user_1',
        deviceName: 'Reinstalled',
        platform: 'linux',
        auditLogId: 'audit_1',
        auditAction: 'device.reconnect',
        createdAt: '2026-06-30T10:00:00.000Z'
      })
    ).rejects.toThrow('D1 batch statement 2 failed: constraint failed')
  })

  test('rejects reconnect credentials when the source claim was revoked or rotated', async () => {
    const { db } = createRecordingDb(null, [
      { success: true, meta: { changes: 1 } },
      { success: true, meta: { changes: 0 } },
      { success: true, meta: { changes: 0 } },
      { success: true, meta: { changes: 0 } },
      { success: true, meta: { changes: 0 } },
      { success: true, meta: { changes: 0 } }
    ])
    const repository = new D1DevicePairingRepository(db)

    await expect(
      repository.createUploadTokenAndInstallation({
        pairingCodeId: 'pair_1',
        consumedAt: '2026-06-30T10:00:00.000Z',
        uploadTokenId: 'ut_1',
        uploadTokenHash: 'hash:upload',
        deviceId: 'dev_old',
        installationId: 'inst_1',
        installClaimHash: 'hash:claim',
        userId: 'user_1',
        deviceName: 'Reinstalled',
        platform: 'linux',
        auditLogId: 'audit_1',
        auditAction: 'device.reconnect',
        createdAt: '2026-06-30T10:00:00.000Z',
        sourceInstallationId: 'inst_old',
        sourceInstallClaimHash: 'hash:old-claim',
        consumedInstallClaimHash: 'hash:claim-consumed'
      })
    ).rejects.toThrow('Reconnect source installation is no longer current')
  })

  test('rejects reconnect credentials when no active target installation remains', async () => {
    const { db } = createRecordingDb(null, [
      { success: true, meta: { changes: 1 } },
      { success: true, meta: { changes: 0 } },
      { success: true, meta: { changes: 0 } },
      { success: true, meta: { changes: 0 } },
      { success: true, meta: { changes: 0 } }
    ])
    const repository = new D1DevicePairingRepository(db)

    await expect(
      repository.createUploadTokenAndInstallation({
        pairingCodeId: 'pair_1',
        consumedAt: '2026-06-30T10:00:00.000Z',
        uploadTokenId: 'ut_1',
        uploadTokenHash: 'hash:upload',
        deviceId: 'dev_old',
        installationId: 'inst_1',
        installClaimHash: 'hash:claim',
        userId: 'user_1',
        deviceName: 'Reinstalled',
        platform: 'linux',
        auditLogId: 'audit_1',
        auditAction: 'device.reconnect',
        createdAt: '2026-06-30T10:00:00.000Z'
      })
    ).rejects.toThrow('Reconnect target is no longer active')
  })

  test('checks whether a device has an active installation', async () => {
    const { db, sqlStatements, bindings } = createRecordingDb({ id: 'inst_1' })
    const repository = new D1DevicePairingRepository(db)

    await expect(repository.hasActiveInstallationForDevice('user_1', 'dev_1')).resolves.toBe(true)
    expect(sqlStatements[0]).toContain('FROM device_installations')
    expect(sqlStatements[0]).toContain('revoked_at IS NULL')
    expect(bindings[0]).toEqual(['user_1', 'dev_1'])
  })

  test('reports devices with only revoked installations as inactive', async () => {
    const { db } = createRecordingDb(null)
    const repository = new D1DevicePairingRepository(db)

    await expect(repository.hasActiveInstallationForDevice('user_1', 'dev_1')).resolves.toBe(false)
  })

  test('finds an installation by stored install claim hash', async () => {
    const { db, sqlStatements, bindings } = createRecordingDb({
      id: 'inst_1',
      userId: 'user_1',
      deviceId: 'dev_1',
      revokedAt: null
    })
    const repository = new D1DevicePairingRepository(db)

    await expect(
      repository.findInstallationByClaim({
        deviceId: 'dev_1',
        installationId: 'inst_1',
        installClaimHash: 'hash:claim'
      })
    ).resolves.toEqual({
      id: 'inst_1',
      userId: 'user_1',
      deviceId: 'dev_1',
      revokedAt: null
    })
    expect(sqlStatements[0]).toContain('FROM device_installations')
    expect(sqlStatements[0]).toContain('install_claim_hash = ?')
    expect(bindings[0]).toEqual(['inst_1', 'dev_1', 'hash:claim'])
  })

  test('records device pairing audit logs', async () => {
    const { db, sqlStatements, bindings } = createRecordingDb()
    const repository = new D1DevicePairingRepository(db)

    await repository.createAuditLog({
      auditLogId: 'audit_1',
      userId: 'user_1',
      actorType: 'user',
      action: 'device.reconnect',
      targetType: 'device',
      targetId: 'dev_old',
      metadata: '{"installationId":"inst_1"}',
      createdAt: '2026-06-30T10:00:00.000Z'
    })

    expect(sqlStatements[0]).toContain('INSERT INTO audit_logs')
    expect(bindings[0]).toEqual([
      'audit_1',
      'user_1',
      'user',
      'device.reconnect',
      'device',
      'dev_old',
      '{"installationId":"inst_1"}',
      '2026-06-30T10:00:00.000Z'
    ])
  })
})
