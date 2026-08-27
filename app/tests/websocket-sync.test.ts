import { EventEmitter } from 'node:events'

import { describe, expect, it, vi } from 'vitest'
import type WebSocket from 'ws'

import { SyncManager, type AggregateExecutor } from '../src/main/services'
import type { SyncConfig } from '../src/shared/types'

class FakeSocket extends EventEmitter {
  readyState = 1
  sent: string[] = []
  send(value: string): void { this.sent.push(value) }
  close(): void { this.readyState = 3 }
}

const config: SyncConfig = {
  serverUrl: 'https://central.example.org', authToken: 'secret-token', siteToken: 'site-token', pickupToken: '', labCode: 'LAB01',
  pollIntervalSeconds: 30, pollTimeoutSeconds: 60, verifyTls: true, autoConfigureToken: false,
  gpsConsent: true, gpsLatitude: 28.61, gpsLongitude: 77.21,
  allowedQueryTypes: ['resistance_rate', 'isolate_count', 'organism_distribution', 'specimen_distribution', 'measure_bundle', 'heartbeat']
}

describe('live aggregate WebSocket contract', () => {
  it('verifies the token, answers the exact server command, and never emits row identifiers', async () => {
    const fakeSocket = new FakeSocket()
    let websocketUrl = ''
    let websocketOptions: WebSocket.ClientOptions | undefined
    let observedCriteria: Record<string, unknown> = {}
    const executor: AggregateExecutor = {
      executeAggregate: async () => ({ result: {}, fhirBundle: { resourceType: 'Bundle', type: 'collection', entry: [] } }),
      executeLiveAggregate: async (criteria) => {
        observedCriteria = criteria
        return [{ lab_code: 'LAB01', organism: 'Escherichia coli', antibiotic_name: 'Meropenem', susceptible: 2, intermediate: 1, resistant: 3, total: 6, resistance_rate: 50 }]
      }
    }
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      expect(new URL(String(url)).pathname).toBe('/v1/api/token_code_verify/')
      expect(new URL(String(url)).searchParams.get('lab_code')).toBe('LAB01')
      return new Response('{}', { status: 200 })
    }) as unknown as typeof fetch
    const manager = new SyncManager({
      executor,
      fetchImpl,
      websocketFactory: (url, options) => { websocketUrl = url; websocketOptions = options; return fakeSocket as unknown as WebSocket }
    })
    ;(manager as unknown as { config: SyncConfig }).config = config
    await manager.startWebSocket(config)
    expect(websocketUrl).toBe('wss://central.example.org/ws/desktop/')
    expect(websocketUrl).not.toContain('secret-token')
    expect(websocketOptions).toMatchObject({
      headers: { Authorization: 'Bearer secret-token', 'X-AMRIT-Site': 'site-token' },
      maxPayload: 256 * 1024,
      perMessageDeflate: false
    })
    fakeSocket.emit('open')
    fakeSocket.emit('message', JSON.stringify({
      command: 'fetch_local_records', tx_id: 'tx-1', criteria: { lab_code: ['LAB01'], organism_code: 'ECOLI', year: '2026' }
    }))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(observedCriteria).toEqual({ lab_code: ['LAB01'], organism_code: 'ECOLI', year: '2026' })
    expect(fakeSocket.sent).toHaveLength(1)
    expect(JSON.parse(fakeSocket.sent[0] ?? '{}')).toMatchObject({
      type: 'local_data_response', tx_id: 'tx-1', payload: [{ lab_code: 'LAB01', total: 6, resistant: 3 }]
    })
    expect(fakeSocket.sent[0]).not.toContain('patient_id')
    expect(manager.getStatus().websocket).toBe('connected')
  })

  it('blocks a live executor response if it contains a forbidden identifier', async () => {
    const fakeSocket = new FakeSocket()
    const executor: AggregateExecutor = {
      executeAggregate: async () => ({ result: {}, fhirBundle: { resourceType: 'Bundle', type: 'collection', entry: [] } }),
      executeLiveAggregate: async () => [{ patient_id: 'P-SECRET', total: 1 }]
    }
    const manager = new SyncManager({
      executor,
      fetchImpl: vi.fn(async () => new Response('{}', { status: 200 })) as unknown as typeof fetch,
      websocketFactory: () => fakeSocket as unknown as WebSocket
    })
    ;(manager as unknown as { config: SyncConfig }).config = config
    await manager.startWebSocket(config)
    fakeSocket.emit('message', JSON.stringify({ command: 'fetch_local_records', tx_id: 'tx-unsafe', criteria: {} }))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(fakeSocket.sent).toEqual([])
    expect(manager.getStatus()).toMatchObject({ websocket: 'error', lastError: expect.stringMatching(/prohibited (aggregate key|field)/i) })
  })
})
