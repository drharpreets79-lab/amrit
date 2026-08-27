// @vitest-environment node

/**
 * Opt-in cross-process proof against a running AMRIT Central instance.
 *
 * The administrator approval and out-of-band site-token delivery are deliberately
 * performed outside this process. Set the three AMRIT_REAL_* paths/URL, run this test,
 * approve the request in the portal, then write the once-shown site token to the token
 * file. No secret is written to the evidence file.
 */
import { readFile, writeFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

import { SyncManager, type AggregateExecutor } from '../src/main/services'
import type { SyncConfig, SyncStatus } from '../src/shared/types'

const serverUrl = process.env.AMRIT_REAL_SERVER_URL ?? ''
const coordinationFile = process.env.AMRIT_REAL_COORDINATION_FILE ?? ''
const siteTokenFile = process.env.AMRIT_REAL_SITE_TOKEN_FILE ?? ''
const labCode = process.env.AMRIT_REAL_LAB_CODE ?? 'REAL-E2E-01'

async function waitUntil<T>(read: () => T | Promise<T>, accept: (value: T) => boolean, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let latest = await read()
  while (!accept(latest) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 200))
    latest = await read()
  }
  if (!accept(latest)) throw new Error(`Real-system condition was not reached within ${timeoutMs} ms`)
  return latest
}

async function writeEvidence(value: Record<string, unknown>): Promise<void> {
  if (coordinationFile) await writeFile(coordinationFile, JSON.stringify(value, null, 2), 'utf8')
}

const real = serverUrl && coordinationFile && siteTokenFile ? describe : describe.skip

real('real desktop-to-central enrolment', () => {
  it('requests, collects after approval, authenticates both channels, and answers a live pull', async () => {
    let storedBearer = ''
    let liveExecutions = 0
    let latestStatus: SyncStatus = {
      mode: 'off', websocket: 'off', lastError: '', tokenConfigured: false
    }
    const executor: AggregateExecutor = {
      async executeAggregate() {
        return {
          result: { count: 1 },
          fhirBundle: { resourceType: 'Bundle', type: 'collection', entry: [] }
        }
      },
      async executeLiveAggregate() {
        liveExecutions += 1
        return [{ organism: 'Escherichia coli', isolate_count: 1 }]
      }
    }
    const manager = new SyncManager({
      executor,
      appVersion: 'real-enrolment-test',
      tokenStore: {
        get: async () => storedBearer,
        set: async (value) => { storedBearer = value }
      },
      onStatus: (status) => { latestStatus = status }
    })
    const base: SyncConfig = {
      serverUrl,
      authToken: '',
      siteToken: '',
      pickupToken: '',
      labCode,
      pollIntervalSeconds: 5,
      pollTimeoutSeconds: 5,
      verifyTls: true,
      autoConfigureToken: true,
      gpsConsent: true,
      gpsLatitude: 28.6139,
      gpsLongitude: 77.209,
      allowedQueryTypes: ['isolate_count']
    }

    const request = await manager.requestAccess(base, {
      name: 'AMRIT real-system enrolment test',
      country: 'India',
      country_code: 'IND',
      contact_email: 'site-admin@example.test',
      app_version: 'real-enrolment-test'
    })
    expect(request.status).toBe('pending')
    expect(request.pickupToken).not.toBe('')
    await writeEvidence({ phase: 'awaiting_approval', labCode, requestStatus: request.status })

    const approved = await manager.waitForApproval(
      { ...base, pickupToken: request.pickupToken },
      { intervalSeconds: request.intervalSeconds, pickupExpiresAt: request.pickupExpiresAt }
    )
    expect(storedBearer).not.toBe('')
    await writeEvidence({
      phase: 'bearer_collected', labCode, requestStatus: request.status,
      bearerStored: true, pickupSecretExposed: false
    })

    const siteToken = await waitUntil(
      async () => {
        try { return (await readFile(siteTokenFile, 'utf8')).trim() } catch { return '' }
      },
      (value) => value.length > 0,
      60_000
    )
    const started = await manager.start({ ...approved, siteToken, autoConfigureToken: false })
    expect(['connecting', 'idle']).toContain(started.mode)
    await waitUntil(
      () => latestStatus,
      (status) => status.websocket === 'connected' && status.mode !== 'error',
      20_000
    )
    await writeEvidence({
      phase: 'channel_open', labCode, requestStatus: request.status,
      bearerStored: true, siteTokenLoaded: true, websocket: latestStatus.websocket,
      longPollMode: latestStatus.mode, pickupSecretExposed: false
    })

    await waitUntil(() => liveExecutions, (count) => count > 0, 30_000)
    await writeEvidence({
      phase: 'complete', labCode, requestStatus: request.status,
      bearerStored: true, siteTokenLoaded: true, websocket: latestStatus.websocket,
      longPollMode: latestStatus.mode, liveAggregateReplies: liveExecutions,
      pickupSecretExposed: false
    })
    await manager.stop()
  }, 120_000)
})
