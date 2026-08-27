import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as XLSX from 'xlsx'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { IsolateRecord, Laboratory, SyncConfig } from '../src/shared/types'
import {
  OFFICIAL_BREAKPOINT_URLS,
  SyncManager,
  askLLM,
  buildFhirBundle,
  buildHl7Batch,
  buildMeasureBundle,
  createAggregateExecutor,
  createExport,
  createImportTemplate,
  deleteLocalModel,
  downloadOfficialBreakpointFile,
  importBreakpointWorkbook,
  listLocalModels,
  parseBreakpointWorkbook,
  parseImportPreview,
  pullLocalModel,
  redactPhi,
  sanitizeModelResponse,
  testLLM,
  type BreakpointRow
} from '../src/main/services'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const UUID_URN = /^urn:uuid:([0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i

function fhirEntries(bundle: Record<string, unknown>): Array<{ fullUrl: string; resource: Record<string, unknown> }> {
  expect(bundle.resourceType).toBe('Bundle')
  expect(bundle.type).toBe('collection')
  expect(bundle.id).toEqual(expect.stringMatching(UUID))
  expect(Array.isArray(bundle.entry)).toBe(true)
  return (bundle.entry as unknown[]).map((value) => {
    expect(value).toBeTruthy()
    expect(typeof value).toBe('object')
    const entry = value as Record<string, unknown>
    expect(entry.fullUrl).toEqual(expect.stringMatching(UUID_URN))
    expect(entry.resource).toBeTruthy()
    expect(typeof entry.resource).toBe('object')
    return { fullUrl: String(entry.fullUrl), resource: entry.resource as Record<string, unknown> }
  })
}

function collectUrnReferences(value: unknown, output: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) collectUrnReferences(item, output)
  } else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (key === 'reference' && typeof item === 'string' && item.startsWith('urn:uuid:')) output.push(item)
      collectUrnReferences(item, output)
    }
  }
  return output
}

function expectResolvableFhirBundle(bundle: Record<string, unknown>): Array<{ fullUrl: string; resource: Record<string, unknown> }> {
  const entries = fhirEntries(bundle)
  const fullUrls = new Set(entries.map((entry) => entry.fullUrl))
  expect(fullUrls.size).toBe(entries.length)
  for (const entry of entries) {
    const matched = entry.fullUrl.match(UUID_URN)
    expect(matched).not.toBeNull()
    expect(entry.resource.id).toBe(matched?.[1])
    expect(entry.resource.resourceType).toEqual(expect.any(String))
  }
  const references = collectUrnReferences(bundle)
  expect(references.length).toBeGreaterThan(0)
  for (const reference of references) {
    expect(reference).toMatch(UUID_URN)
    expect(fullUrls.has(reference)).toBe(true)
  }
  return entries
}

describe('AMRIT service boundaries', () => {
  let temporaryDirectory = ''

  beforeEach(async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), 'amrit-services-'))
  })

  afterEach(async () => {
    await rm(temporaryDirectory, { recursive: true, force: true })
  })

  it('previews CSV rows, normalises AST and keeps incomplete rows as drafts', async () => {
    const path = join(temporaryDirectory, 'isolates.csv')
    await writeFile(path, [
      'Patient ID,Specimen number,Specimen date,Specimen type,Organism,MEM result,MEM measurement',
      'P-1,S-1,2026-08-01,Blood,Escherichia coli,Resistant,8',
      'P-2,S-2,01/08/2026,Blood,,S,24'
    ].join('\n'))

    const preview = await parseImportPreview(path, 'LAB01')

    expect(preview.rows).toHaveLength(2)
    expect(preview.validCount).toBe(1)
    expect(preview.draftCount).toBe(1)
    expect(preview.rows[0]).toMatchObject({
      lab_code: 'LAB01',
      specimen_date: '2026-08-01',
      record_status: 'final',
      antibiotic_results: { MEM: { result: 'R', measurement: '8' } }
    })
    expect(preview.issues).toContainEqual(expect.objectContaining({ row: 3, field: 'organism', severity: 'warning' }))
  })

  it('supports row validation hooks without committing partial batches', async () => {
    const path = join(temporaryDirectory, 'validation.csv')
    await writeFile(path, 'Patient ID,Specimen date,Specimen type,Organism,MEM result\nP1,2026-01-01,Blood,E. coli,S\n')
    const preview = await parseImportPreview(path, 'LAB01', {}, {
      validateRow: (row) => row.patient_id === 'P1' ? [{ severity: 'error', field: 'patient_id', message: 'Synthetic rejection' }] : []
    })
    expect(preview.errorCount).toBe(1)
    expect(preview.validCount).toBe(0)
  })

  it('applies caller-selected delimiters and default row-state controls', async () => {
    const path = join(temporaryDirectory, 'semicolon.csv')
    await writeFile(path, 'Patient ID;Specimen date;Specimen type;Organism;MEM result\nP1;2026-01-01;Blood;E. coli;S\n')
    const draft = await parseImportPreview(path, 'LAB01', {}, { delimiter: ';', defaults: { record_status: 'draft' } })
    expect(draft.rows).toHaveLength(1)
    expect(draft.rows[0]?.record_status).toBe('draft')
    expect(draft.draftCount).toBe(1)
    const final = await parseImportPreview(path, 'LAB01', {}, { delimiter: ';', defaults: { record_status: 'final' } })
    expect(final.rows[0]?.record_status).toBe('final')
    expect(final.validCount).toBe(1)
  })

  it('creates a directly importable structured template with isolates first', async () => {
    const path = join(temporaryDirectory, 'template.xlsx')
    await createImportTemplate(path, 'LAB01', ['MEM'], {
      antibiotics: [{ code: 'MEM', name: 'Meropenem' }], organisms: [{ code: 'ECOLI', name: 'Escherichia coli' }],
      samples: [{ code: 'BLOOD', name: 'Blood' }]
    })
    const workbook = XLSX.read(await readFile(path), { type: 'buffer' })
    expect(workbook.SheetNames).toEqual(['Isolates', 'Instructions', 'Master lookups'])
    expect(workbook.Workbook?.Sheets?.find((item) => item.name === 'Master lookups')?.Hidden).toBe(1)
    const sheet = workbook.Sheets.Isolates
    expect(sheet).toBeDefined()
    const matrix = XLSX.utils.sheet_to_json<string[]>(sheet!, { header: 1 })
    expect(matrix[0]).toContain('MEM result')
    const lookups = XLSX.utils.sheet_to_json<string[]>(workbook.Sheets['Master lookups']!, { header: 1 })
    expect(lookups).toEqual(expect.arrayContaining([['Antibiotic', 'MEM', 'Meropenem'], ['Organism', 'ECOLI', 'Escherichia coli']]))
    const preview = await parseImportPreview(path, 'LAB01')
    expect(preview.rows).toHaveLength(0)
  })

  it('rejects spreadsheet formulas and error cells before import preview', async () => {
    const formulaPath = join(temporaryDirectory, 'formula.xlsx')
    const formulaBook = XLSX.utils.book_new()
    const formulaSheet = XLSX.utils.aoa_to_sheet([
      ['Patient ID', 'Specimen number'],
      ['P1', 'S1']
    ])
    formulaSheet.A2 = { t: 'n', v: 2, f: '1+1' }
    XLSX.utils.book_append_sheet(formulaBook, formulaSheet, 'Isolates')
    await writeFile(formulaPath, XLSX.write(formulaBook, { type: 'buffer', bookType: 'xlsx' }))
    await expect(parseImportPreview(formulaPath, 'LAB01')).rejects.toThrow(/formula cell.*Isolates!A2/i)

    const errorPath = join(temporaryDirectory, 'error.xlsx')
    const errorBook = XLSX.utils.book_new()
    const sheet = XLSX.utils.aoa_to_sheet([['Patient ID'], ['P1']])
    sheet.A2 = { t: 'e', v: 7 }
    XLSX.utils.book_append_sheet(errorBook, sheet, 'Isolates')
    await writeFile(errorPath, XLSX.write(errorBook, { type: 'buffer', bookType: 'xlsx' }))
    await expect(parseImportPreview(errorPath, 'LAB01')).rejects.toThrow(/error cell.*Isolates!A2/i)
  })

  it('parses the official CLSI Part B layout and stages an inactive set', async () => {
    const path = join(temporaryDirectory, 'part-b.xlsx')
    const workbook = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['This workbook contains M100 36th edition and M45 3rd edition breakpoints.']]), 'App B Intro')
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
      ['DRUG NAME', 'Organism/Organism Group', 'CLSI\n<= S ', 'CLSI \n= I/SDD', 'CLSI\n>= R', 'FDA STIC <=S', 'FDA STIC\n=I', 'FDA STIC >=R', 'CLSI & FDA match?', 'Comments'],
      ['Meropenem', 'Enterobacterales', '1', '2', '4', 'same', 'same', 'same', 'Yes', '']
    ]), 'MIC BP Table')
    await writeFile(path, XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }))

    const parsed = await parseBreakpointWorkbook(path)
    expect(parsed.edition).toBe('M100 Ed36 / M45 Ed3')
    expect(parsed.rows).toEqual([
      expect.objectContaining({ guideline: 'CLSI', test_method: 'MIC', antibiotic_name: 'Meropenem', organism_name: 'Enterobacterales', susceptible: '1', intermediate: '2', resistant: '4', units: 'µg/mL' })
    ])

    let stagedRows: BreakpointRow[] = []
    let activate: boolean | undefined
    const result = await importBreakpointWorkbook(path, { title: 'CLSI test set' }, {
      async stageBreakpointSet(input) {
        stagedRows = input.rows
        activate = input.activate
        return { imported: input.rows.length, skipped: 0 }
      }
    })
    expect(result.imported).toBe(1)
    expect(stagedRows).toHaveLength(1)
    expect(activate).toBe(false)
    expect(result.sourceHash).toMatch(/^[a-f0-9]{64}$/)
  })

  it.runIf(Boolean(process.env.CLSI_TEST_FILE))('parses a caller-supplied official CLSI Part B workbook', async () => {
    const parsed = await parseBreakpointWorkbook(process.env.CLSI_TEST_FILE!)
    expect(parsed.rows.length).toBeGreaterThan(1_000)
    expect(new Set(parsed.rows.map((row) => row.test_method))).toEqual(new Set(['MIC', 'Disk diffusion']))
    expect(parsed.edition).toContain('M100 Ed36')
  })

  it('downloads only allowlisted HTTPS CLSI files and records provenance', async () => {
    const destination = join(temporaryDirectory, 'part-b.xlsb')
    const fetchImpl = vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), {
      status: 200,
      headers: { 'content-length': '3' }
    })) as unknown as typeof fetch

    const result = await downloadOfficialBreakpointFile(OFFICIAL_BREAKPOINT_URLS.toolkitPartB, destination, { fetchImpl })

    expect(await readFile(destination)).toEqual(Buffer.from([1, 2, 3]))
    expect(result.sourceHash).toBe('039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81')
    await expect(downloadOfficialBreakpointFile('http://clsi.org/test.xlsb', destination, { fetchImpl })).rejects.toThrow(/HTTPS/)
    await expect(downloadOfficialBreakpointFile('https://example.com/test.xlsb', destination, { fetchImpl })).rejects.toThrow(/allowlisted/)
  })

  const lab: Laboratory = { code: 'LAB01', name: 'ICMR Test Laboratory', country: 'India' }
  const isolates: IsolateRecord[] = [{
    id: 1,
    lab_code: 'LAB01',
    patient_id: 'P1',
    specimen_number: 'S1',
    specimen_date: '2026-01-02',
    specimen_type: 'Blood',
    organism: 'Escherichia coli',
    organism_code: 'eco',
    record_status: 'final',
    antibiotic_results: {
      MEM: {
        result: 'R',
        measurement: '8',
        method: 'MIC',
        guideline: 'CLSI M100 Ed36',
        potency: '10 µg',
        source: 'configured breakpoint set BP-1'
      }
    }
  }]

  it('preserves WHONET interpretation, measurement and AST provenance without moving legacy columns', () => {
    const csv = createExport('whonet', isolates, lab).replace(/^\uFEFF/, '').trimEnd()
    const [headerLine, valueLine] = csv.split('\r\n')
    const headers = headerLine?.split(',') ?? []
    const values = valueLine?.split(',') ?? []
    const legacyTail = ['MEM result', 'MEM measurement', 'Origin', 'Alerts', 'Expert comments']
    const resultIndex = headers.indexOf('MEM result')

    expect(resultIndex).toBeGreaterThan(-1)
    expect(headers.slice(resultIndex, resultIndex + legacyTail.length)).toEqual(legacyTail)
    expect(Object.fromEntries(headers.map((header, index) => [header, values[index]]))).toMatchObject({
      'MEM result': 'R',
      'MEM measurement': '8',
      'MEM method': 'MIC',
      'MEM guideline': 'CLSI M100 Ed36',
      'MEM potency': '10 µg',
      'MEM source': 'configured breakpoint set BP-1'
    })
  })

  it('neutralizes spreadsheet formula injection without changing negative numeric measurements', () => {
    const csv = createExport('whonet', [{
      ...isolates[0]!,
      patient_id: '=HYPERLINK("https://attacker.invalid")',
      notes: '@SUM(1,1)',
      antibiotic_results: { MEM: { ...isolates[0]!.antibiotic_results!.MEM!, measurement: '-1' } }
    }], lab).replace(/^\uFEFF/, '')
    expect(csv).toContain(`'=HYPERLINK`)
    expect(csv).toContain(`'@SUM`)
    expect(csv).toContain(',R,-1,')
  })

  it('creates FHIR R4 bundles with actual UUID fullUrls and fully resolved internal references', () => {
    const fhir = buildFhirBundle(isolates, lab)
    const entries = expectResolvableFhirBundle(fhir)
    expect(entries.map((entry) => entry.resource.resourceType)).toEqual([
      'Organization', 'Patient', 'Specimen', 'Observation', 'Observation', 'DiagnosticReport'
    ])
    const report = entries.find((entry) => entry.resource.resourceType === 'DiagnosticReport')?.resource
    expect(report?.status).toBe('final')
    expect(report?.result).toHaveLength(2)

    const rebuilt = buildFhirBundle(isolates, lab)
    expect(fhirEntries(rebuilt).map((entry) => entry.fullUrl)).toEqual(entries.map((entry) => entry.fullUrl))

    const measure = buildMeasureBundle(isolates, lab, { antibioticCode: 'MEM' })
    const measureEntries = expectResolvableFhirBundle(measure)
    expect(measureEntries.map((entry) => entry.resource.resourceType)).toEqual(['Organization', 'Measure', 'MeasureReport'])
    const reportResource = measureEntries.find((entry) => entry.resource.resourceType === 'MeasureReport')?.resource
    expect(JSON.stringify(reportResource)).toContain('100')
  })

  it('creates structurally complete HL7 v2.5.1 ORU messages with typed AST OBX segments', () => {
    const hl7 = buildHl7Batch(isolates, lab)
    expect(hl7.endsWith('\r')).toBe(true)
    const segments = hl7.split('\r').filter(Boolean).map((segment) => segment.split('|'))
    expect(segments.map((segment) => segment[0])).toEqual(['MSH', 'PID', 'PV1', 'SPM', 'OBR', 'OBX', 'OBX'])

    const msh = segments[0]!
    expect(msh[8]).toBe('ORU^R01')
    expect(msh[10]).toBe('P')
    expect(msh[11]).toBe('2.5.1')

    const obx = segments.filter((segment) => segment[0] === 'OBX')
    expect(obx.map((segment) => segment[1])).toEqual(['1', '2'])
    // OBX-3 carries the local triplet first and the LOINC one in the alternate identifier,
    // which is what components 4-6 exist for: a receiver with no WHONET mapping table can
    // still file the result. Phase 23; before it, only the local triplet was sent.
    expect(obx[0]).toMatchObject({
      2: 'CWE',
      3: 'ORG^Organism identified^L^11475-1^Microorganism identified in Specimen by Culture^LN',
      11: 'F'
    })
    expect(obx[1]).toMatchObject({
      2: 'NM',
      // Meropenem by MIC, which is a different LOINC concept from meropenem by disk diffusion.
      3: 'MEM^MEM susceptibility^WHONET^6652-2^Meropenem [Susceptibility] by Minimum inhibitory concentration (MIC)^LN',
      5: '8',
      // OBX-6, the units field, was empty on every susceptibility result before Phase 23.
      6: 'mg/L',
      8: 'R',
      11: 'F',
      14: '20260102'
    })
  })

  it('executes only aggregate sync query shapes and excludes drafts', async () => {
    const executor = createAggregateExecutor({
      listIsolates: () => [...isolates, { ...isolates[0]!, id: 2, record_status: 'draft' }],
      getLaboratory: () => lab
    })
    const count = await executor.executeAggregate({ type: 'isolate_count', lab_code: 'LAB01' })
    expect(count.result).toEqual({ count: 1 })
    expect(JSON.stringify(count.fhirBundle)).not.toContain('Patient')
    expectResolvableFhirBundle(count.fhirBundle)
    const rate = await executor.executeAggregate({ type: 'resistance_rate', lab_code: 'LAB01', antibiotic_code: 'MEM' })
    expect(rate.result).toMatchObject({ denominator: 1, numerator: 1, rate_percent: 100 })
    const outbreak = await executor.executeAggregate({ type: 'cluster_scan', lab_code: 'LAB01', filters: { deduplication_days: 30 } })
    expect(outbreak.result).toMatchObject({ schema_version: 1, source_records: 1, deduplication_days: 30 })
    expect(JSON.stringify(outbreak.result)).not.toMatch(/patient_id|specimen_number|location|ward/i)
    expectResolvableFhirBundle(outbreak.fhirBundle)
    const live = await executor.executeLiveAggregate({ lab_code: ['LAB01'] })
    expect(live).toEqual([expect.objectContaining({ lab_code: 'LAB01', resistant: 1, total: 1 })])
    expect(JSON.stringify(live)).not.toContain('patient_id')
  })

  it('redacts identifiers and suppresses hidden reasoning in LLM responses', async () => {
    expect(redactPhi('patient_id: ABC12345; email p@example.org; 2026-01-02')).not.toContain('ABC12345')
    expect(sanitizeModelResponse('<think>secret</think>Direct answer.')).toBe('Direct answer.')

    let requestBody = ''
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      requestBody = String(init?.body ?? '')
      return new Response(JSON.stringify({ choices: [{ message: { content: '<think>private</think>Safe answer.' } }] }), { status: 200 })
    }) as unknown as typeof fetch
    const answer = await askLLM({ provider: 'openai', apiKey: 'test', networkEnabled: true }, 'free', { text: 'patient_id: ABC12345' }, { fetchImpl })
    expect(requestBody).not.toContain('ABC12345')
    expect(answer.text).toBe('Safe answer.')
    await expect(askLLM({ provider: 'openai', apiKey: 'test', networkEnabled: true, baseUrl: 'http://api.example.com' }, 'free', { text: 'hello' }, { fetchImpl })).rejects.toThrow(/HTTPS/)
    await expect(askLLM({ provider: 'ollama', networkEnabled: false }, 'free', { text: 'hello' }, { fetchImpl })).rejects.toThrow(/network access is off/i)
  })

  it('lists, pulls, deletes and tests loopback Ollama models behind opt-in', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const path = new URL(String(url)).pathname
      if (path === '/api/tags') return new Response(JSON.stringify({ models: [{ name: 'qwen3.5:27b' }] }), { status: 200 })
      if (path === '/api/pull') return new Response('{"status":"pulling","completed":5,"total":10}\n{"status":"success"}\n', { status: 200 })
      if (path === '/api/delete') return new Response('{}', { status: 200 })
      return new Response(JSON.stringify({ version: '1.0.0' }), { status: 200 })
    }) as unknown as typeof fetch
    expect(await listLocalModels('http://127.0.0.1:11434', true, { fetchImpl })).toEqual(['qwen3.5:27b'])
    const progress: number[] = []
    await pullLocalModel('qwen3.5:27b', 'http://127.0.0.1:11434', true, { fetchImpl, onProgress: (item) => { if (item.percent) progress.push(item.percent) } })
    expect(progress).toEqual([50])
    await deleteLocalModel('qwen3.5:27b', 'http://127.0.0.1:11434', true, { fetchImpl })
    expect(await testLLM({ provider: 'ollama', baseUrl: 'http://127.0.0.1:11434', networkEnabled: true }, { fetchImpl })).toEqual({ ok: true, message: 'Ollama reachable (version 1.0.0).' })
  })

  it('auto-configures a token only when missing or explicitly rotated', async () => {
    const base: SyncConfig = {
      serverUrl: 'https://central.example.org',
      authToken: '',
      siteToken: '', pickupToken: 'pickup-secret',
      labCode: 'LAB01',
      pollIntervalSeconds: 30,
      pollTimeoutSeconds: 60,
      verifyTls: true,
      autoConfigureToken: true,
      gpsConsent: true,
      gpsLatitude: 28.61,
      gpsLongitude: 77.21,
      allowedQueryTypes: ['isolate_count']
    }
    let stored = ''
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ new_token: 'new-secret-token' }), { status: 200 })) as unknown as typeof fetch
    const manager = new SyncManager({
      executor: createAggregateExecutor({ listIsolates: () => isolates, getLaboratory: () => lab }),
      tokenStore: { get: async () => stored, set: async (value) => { stored = value } },
      fetchImpl
    })
    const configured = await manager.configureToken(base)
    expect(configured.authToken).toBe('new-secret-token')
    expect(stored).toBe('new-secret-token')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    await manager.configureToken({ ...base, authToken: 'existing' })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    await manager.configureToken({ ...base, authToken: 'existing' }, true)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('sends POST bodies with a Content-Length a real server can read', async () => {
    // Exercised against an actual socket, with no fetchImpl, because that is the path the
    // packaged app takes and the only one where this can go wrong. Every mocked test passed
    // while the real client sent `Transfer-Encoding: chunked`, whose body the ASGI server
    // discarded — so registering, collecting a token and submitting results all arrived empty
    // and the server answered "lab_code is required" to a request that carried one.
    const seen: Array<{ headers: Record<string, unknown>; body: string }> = []
    const server = createServer((request, response) => {
      const chunks: Buffer[] = []
      request.on('data', (chunk: Buffer) => chunks.push(chunk))
      request.on('end', () => {
        seen.push({ headers: request.headers as Record<string, unknown>, body: Buffer.concat(chunks).toString('utf8') })
        response.writeHead(202, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify({ status: 'pending', lab_code: 'LAB01', pickup_token: 'real-pickup', requested_at: '2026-08-13T00:00:00Z' }))
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port

    try {
      const config: SyncConfig = {
        serverUrl: `http://127.0.0.1:${port}`, authToken: '', siteToken: '', pickupToken: '', labCode: 'LAB01',
        pollIntervalSeconds: 30, pollTimeoutSeconds: 60, verifyTls: true, autoConfigureToken: true,
        gpsConsent: true, gpsLatitude: 28.61, gpsLongitude: 77.21, allowedQueryTypes: ['isolate_count']
      }
      // No fetchImpl: this goes through the Node client the packaged app actually uses.
      const manager = new SyncManager({ executor: createAggregateExecutor({ listIsolates: () => isolates, getLaboratory: () => lab }) })
      const result = await manager.requestAccess(config, { name: 'Ünïcode Läb' })

      expect(result).toMatchObject({ status: 'pending', pickupToken: 'real-pickup' })
      expect(seen).toHaveLength(1)
      const sent = seen[0]!
      expect(sent.headers['content-length']).toBe(String(Buffer.byteLength(sent.body, 'utf8')))
      expect(sent.headers['transfer-encoding']).toBeUndefined()
      // The body the server can actually parse, with the lab code present in it.
      expect(JSON.parse(sent.body)).toMatchObject({ lab_code: 'LAB01', name: 'Ünïcode Läb' })
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it('requests access, keeps the pickup token, and collects the approved token with it', async () => {
    const config: SyncConfig = {
      serverUrl: 'https://central.example.org', authToken: '', siteToken: '', pickupToken: '', labCode: 'LAB01',
      pollIntervalSeconds: 30, pollTimeoutSeconds: 60, verifyTls: true, autoConfigureToken: true,
      gpsConsent: true, gpsLatitude: 28.61, gpsLongitude: 77.21, allowedQueryTypes: ['isolate_count']
    }
    const calls: Array<{ url: string; body: Record<string, unknown> }> = []
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const target = String(url)
      calls.push({ url: target, body: init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {} })
      if (target.includes('/api/v2/sites/register/')) {
        return new Response(JSON.stringify({
          status: 'pending', lab_code: 'LAB01', pickup_token: 'pickup-secret',
          requested_at: '2026-08-13T00:00:00Z', detail: 'awaiting approval', interval: 7,
          pickup_expires_at: '2099-08-14T00:00:00Z'
        }), { status: 202 })
      }
      return new Response(JSON.stringify({ new_token: 'collected-bearer-token', status: 'registered', site_token_required: true }), { status: 200 })
    }) as unknown as typeof fetch
    let stored = ''
    const manager = new SyncManager({
      executor: createAggregateExecutor({ listIsolates: () => isolates, getLaboratory: () => lab }),
      tokenStore: { get: async () => stored, set: async (value) => { stored = value } },
      fetchImpl
    })

    const requested = await manager.requestAccess(config, { name: 'Demo lab', country_code: 'IND' })

    expect(requested).toMatchObject({
      status: 'pending', pickupToken: 'pickup-secret', intervalSeconds: 7,
      pickupExpiresAt: '2099-08-14T00:00:00Z'
    })
    expect(calls[0]?.body).toMatchObject({ lab_code: 'LAB01', name: 'Demo lab', country_code: 'IND' })

    // Asking grants nothing on its own; the pickup token is what collects afterwards.
    const configured = await manager.configureToken({ ...config, pickupToken: requested.pickupToken })
    expect(configured.authToken).toBe('collected-bearer-token')
    expect(stored).toBe('collected-bearer-token')
    expect(calls[1]?.url).toContain('/fetch_site_token/')
    expect(calls[1]?.body).toMatchObject({ lab_code: 'LAB01', pickup_token: 'pickup-secret' })
  })

  it('polls pending approval automatically and stores the returned auth token', async () => {
    const config: SyncConfig = {
      // This is the regression case: a re-approval request can retain the old bearer locally.
      // A pending pickup response must not treat it as the newly collected credential.
      serverUrl: 'https://central.example.org', authToken: 'stale-bearer-token', siteToken: '', pickupToken: 'pickup-secret', labCode: 'LAB01',
      pollIntervalSeconds: 30, pollTimeoutSeconds: 60, verifyTls: true, autoConfigureToken: true,
      gpsConsent: true, gpsLatitude: 28.61, gpsLongitude: 77.21, allowedQueryTypes: ['isolate_count']
    }
    let attempt = 0
    let stored = ''
    const delay = vi.fn(async () => undefined)
    const manager = new SyncManager({
      executor: createAggregateExecutor({ listIsolates: () => isolates, getLaboratory: () => lab }),
      tokenStore: { get: async () => stored, set: async (value) => { stored = value } },
      delay,
      fetchImpl: vi.fn(async () => {
        attempt += 1
        return attempt === 1
          ? new Response(JSON.stringify({ new_token: null, status: 'pending', detail: 'awaiting approval' }), { status: 202 })
          : new Response(JSON.stringify({ new_token: 'approved-auth-token', status: 'registered' }), { status: 200 })
      }) as unknown as typeof fetch
    })

    const approved = await manager.waitForApproval(config, {
      intervalSeconds: 5,
      pickupExpiresAt: '2099-08-14T00:00:00Z'
    })

    expect(approved.authToken).toBe('approved-auth-token')
    expect(stored).toBe('approved-auth-token')
    expect(attempt).toBe(2)
    expect(delay).toHaveBeenCalledWith(5_000, undefined)
  })

  it('does not accept an inherited bearer when an explicit token collection is still pending', async () => {
    const config: SyncConfig = {
      serverUrl: 'https://central.example.org', authToken: 'stale-bearer-token', siteToken: '', pickupToken: 'pickup-secret', labCode: 'LAB01',
      pollIntervalSeconds: 30, pollTimeoutSeconds: 60, verifyTls: true, autoConfigureToken: true,
      gpsConsent: true, gpsLatitude: 28.61, gpsLongitude: 77.21, allowedQueryTypes: ['isolate_count']
    }
    const manager = new SyncManager({
      executor: createAggregateExecutor({ listIsolates: () => isolates, getLaboratory: () => lab }),
      fetchImpl: vi.fn(async () => new Response(JSON.stringify({
        new_token: null, status: 'pending', detail: 'This laboratory is awaiting approval by an administrator.'
      }), { status: 202 })) as unknown as typeof fetch
    })

    await expect(manager.configureToken(config, true)).rejects.toThrow(/awaiting approval/i)
  })

  it('will not try to collect a token before access has been requested', async () => {
    const config: SyncConfig = {
      serverUrl: 'https://central.example.org', authToken: '', siteToken: '', pickupToken: '', labCode: 'LAB01',
      pollIntervalSeconds: 30, pollTimeoutSeconds: 60, verifyTls: true, autoConfigureToken: true,
      gpsConsent: true, gpsLatitude: 28.61, gpsLongitude: 77.21, allowedQueryTypes: ['isolate_count']
    }
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 })) as unknown as typeof fetch
    const manager = new SyncManager({
      executor: createAggregateExecutor({ listIsolates: () => isolates, getLaboratory: () => lab }),
      fetchImpl
    })
    await expect(manager.configureToken(config)).rejects.toThrow(/Request access/i)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('says a laboratory is still awaiting approval rather than "no token"', async () => {
    const config: SyncConfig = {
      serverUrl: 'https://central.example.org', authToken: '', siteToken: '', pickupToken: 'pickup-secret', labCode: 'LAB01',
      pollIntervalSeconds: 30, pollTimeoutSeconds: 60, verifyTls: true, autoConfigureToken: true,
      gpsConsent: true, gpsLatitude: 28.61, gpsLongitude: 77.21, allowedQueryTypes: ['isolate_count']
    }
    const manager = new SyncManager({
      executor: createAggregateExecutor({ listIsolates: () => isolates, getLaboratory: () => lab }),
      fetchImpl: vi.fn(async () => new Response(JSON.stringify({
        new_token: null, status: 'pending', detail: 'This laboratory is awaiting approval by an administrator.'
      }), { status: 202 })) as unknown as typeof fetch
    })
    await expect(manager.configureToken(config)).rejects.toThrow(/awaiting approval/i)
  })

  it('reports the server’s explanation of a refusal, not the raw body', async () => {
    // A registry and a desktop disagreeing about the laboratory code used to surface as
    // `HTTP 403: {"error": "lab_code mismatch"}` with nothing in it to act on.
    const config: SyncConfig = {
      serverUrl: 'https://central.example.org', authToken: '', siteToken: 'site-factor', pickupToken: 'pickup-secret', labCode: 'IN-AIIMS-DEL',
      pollIntervalSeconds: 30, pollTimeoutSeconds: 60, verifyTls: true, autoConfigureToken: true,
      gpsConsent: true, gpsLatitude: 28.61, gpsLongitude: 77.21, allowedQueryTypes: ['isolate_count']
    }
    const body = JSON.stringify({
      error: 'lab_code mismatch',
      registered_lab_code: 'INDIA01',
      sent_lab_code: 'IN-AIIMS-DEL',
      detail: 'This token is registered to INDIA01, but the request was sent as IN-AIIMS-DEL. Either set the laboratory code on the desktop to INDIA01, or have the central server rename the site to IN-AIIMS-DEL from Registry → Sites → rename.'
    })
    const manager = new SyncManager({
      executor: createAggregateExecutor({ listIsolates: () => isolates, getLaboratory: () => lab }),
      fetchImpl: vi.fn(async () => new Response(body, { status: 403 })) as unknown as typeof fetch
    })
    const status = await manager.start(config)
    expect(status.mode).toBe('error')
    expect(status.lastError).toContain('HTTP 403')
    expect(status.lastError).toContain('registered to INDIA01')
    expect(status.lastError).toContain('rename the site to IN-AIIMS-DEL')
    // The whole remedy has to survive: it used to be clipped at 240 characters of raw JSON.
    expect(status.lastError).toContain('Registry → Sites → rename')
  })

  it('falls back to the raw body when a refusal is not JSON', async () => {
    const config: SyncConfig = {
      serverUrl: 'https://central.example.org', authToken: '', siteToken: 'site-factor', pickupToken: 'pickup-secret', labCode: 'LAB01',
      pollIntervalSeconds: 30, pollTimeoutSeconds: 60, verifyTls: true, autoConfigureToken: true,
      gpsConsent: true, gpsLatitude: 28.61, gpsLongitude: 77.21, allowedQueryTypes: ['isolate_count']
    }
    const manager = new SyncManager({
      executor: createAggregateExecutor({ listIsolates: () => isolates, getLaboratory: () => lab }),
      fetchImpl: vi.fn(async () => new Response('<html>502 Bad Gateway</html>', { status: 502 })) as unknown as typeof fetch
    })
    const status = await manager.start(config)
    expect(status.lastError).toContain('HTTP 502')
    expect(status.lastError).toContain('502 Bad Gateway')
  })

  it('reports presence without coordinates when the laboratory did not enter any', async () => {
    // Consent given, coordinates left blank — which the settings screen, the stored
    // configuration and the server all treat as allowed. Requiring them here meant such a
    // site never reported presence at all and sat on a standing error saying so.
    const config: SyncConfig = {
      serverUrl: 'https://central.example.org', authToken: 'secret', siteToken: 'site', pickupToken: '', labCode: 'LAB01',
      pollIntervalSeconds: 30, pollTimeoutSeconds: 60, verifyTls: true, autoConfigureToken: false,
      gpsConsent: true, allowedQueryTypes: ['isolate_count']
    }
    const sent: Array<{ path: string; body: Record<string, unknown> }> = []
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      sent.push({
        path: new URL(String(url)).pathname,
        body: init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {}
      })
      return new Response(null, { status: 204 })
    }) as unknown as typeof fetch
    const manager = new SyncManager({
      executor: createAggregateExecutor({ listIsolates: () => isolates, getLaboratory: () => lab }),
      fetchImpl,
      delay: () => new Promise<void>(() => {})
    })

    await manager.start(config)
    await vi.waitFor(() => expect(sent.some((item) => item.path === '/v1/poll')).toBe(true))
    const heartbeat = sent.find((item) => item.path === '/v1/heartbeat')
    expect(heartbeat?.body).toMatchObject({ lab_code: 'LAB01', gps_consent: true })
    // Consent is reported; a location this site never gave is not invented.
    expect(heartbeat?.body).not.toHaveProperty('latitude')
    expect(heartbeat?.body).not.toHaveProperty('longitude')
    const status = manager.getStatus()
    expect(status.mode).toBe('idle')
    // The WebSocket cannot resolve this test host, and says so; the heartbeat has nothing
    // to report, which is the point.
    expect(status.lastError).not.toMatch(/heartbeat/i)
    expect(status.lastHeartbeat).toBeTruthy()
    await manager.stop()
  })

  it('keeps polling when the heartbeat cannot be sent, and says why', async () => {
    // Half a coordinate pair is a misconfiguration, not an absence. The first heartbeat
    // used to be awaited before the loop started, so anything it threw killed the
    // long-poll worker outright: the desktop sat in `error` and answered no queries, while
    // its WebSocket stayed connected and made the site look online from the portal.
    const config: SyncConfig = {
      serverUrl: 'https://central.example.org', authToken: 'secret', siteToken: 'site', pickupToken: '', labCode: 'LAB01',
      pollIntervalSeconds: 30, pollTimeoutSeconds: 60, verifyTls: true, autoConfigureToken: false,
      gpsConsent: true, gpsLatitude: 28.61, allowedQueryTypes: ['isolate_count']
    }
    const paths: string[] = []
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      paths.push(new URL(String(url)).pathname)
      return new Response(null, { status: 204 })
    }) as unknown as typeof fetch
    const manager = new SyncManager({
      executor: createAggregateExecutor({ listIsolates: () => isolates, getLaboratory: () => lab }),
      fetchImpl,
      // Parks the worker after its first empty poll, so the status under test is the one a
      // running desktop sits in rather than a shutdown state.
      delay: () => new Promise<void>(() => {})
    })

    await manager.start(config)
    await vi.waitFor(() => expect(paths).toContain('/v1/poll'))
    const status = manager.getStatus()
    expect(status.mode).toBe('idle')
    expect(status.lastError).toMatch(/heartbeat not sent/i)
    expect(status.lastError).toMatch(/both a latitude and a longitude/i)
    expect(status.lastError).toMatch(/still being answered/i)
    expect(paths).not.toContain('/v1/heartbeat')
    await manager.stop()
  })

  it('refuses a coordinate that is out of range rather than sending it', async () => {
    const config: SyncConfig = {
      serverUrl: 'https://central.example.org', authToken: 'secret', siteToken: 'site', pickupToken: '', labCode: 'LAB01',
      pollIntervalSeconds: 30, pollTimeoutSeconds: 60, verifyTls: true, autoConfigureToken: false,
      gpsConsent: true, gpsLatitude: 128.61, gpsLongitude: 77.21, allowedQueryTypes: ['isolate_count']
    }
    const paths: string[] = []
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      paths.push(new URL(String(url)).pathname)
      return new Response(null, { status: 204 })
    }) as unknown as typeof fetch
    const manager = new SyncManager({
      executor: createAggregateExecutor({ listIsolates: () => isolates, getLaboratory: () => lab }),
      fetchImpl,
      delay: () => new Promise<void>(() => {})
    })

    await manager.start(config)
    await vi.waitFor(() => expect(paths).toContain('/v1/poll'))
    expect(manager.getStatus().lastError).toMatch(/outside valid ranges/i)
    expect(paths).not.toContain('/v1/heartbeat')
    await manager.stop()
  })

  it('will not open any sync channel until the separately delivered site token is present', async () => {
    const config: SyncConfig = {
      serverUrl: 'https://central.example.org', authToken: 'approved-bearer', siteToken: '', pickupToken: '', labCode: 'LAB01',
      pollIntervalSeconds: 30, pollTimeoutSeconds: 60, verifyTls: true, autoConfigureToken: false,
      gpsConsent: true, gpsLatitude: 28.61, gpsLongitude: 77.21, allowedQueryTypes: ['isolate_count']
    }
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 })) as unknown as typeof fetch
    const manager = new SyncManager({
      executor: createAggregateExecutor({ listIsolates: () => isolates, getLaboratory: () => lab }),
      fetchImpl
    })

    const status = await manager.start(config)

    expect(status.mode).toBe('error')
    expect(status.lastError).toMatch(/site token is required/i)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('posts exact aggregate-only long-poll responses and enforces the site allowlist', async () => {
    const config: SyncConfig = {
      serverUrl: 'https://central.example.org', authToken: 'secret', siteToken: 'site', pickupToken: '', labCode: 'LAB01',
      pollIntervalSeconds: 30, pollTimeoutSeconds: 60, verifyTls: true, autoConfigureToken: false,
      gpsConsent: true, gpsLatitude: 28.61, gpsLongitude: 77.21, allowedQueryTypes: ['isolate_count']
    }
    const posted: Array<Record<string, unknown>> = []
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      if (init?.body) posted.push(JSON.parse(String(init.body)) as Record<string, unknown>)
      return new Response('{}', { status: 200 })
    }) as unknown as typeof fetch
    const manager = new SyncManager({
      executor: createAggregateExecutor({ listIsolates: () => isolates, getLaboratory: () => lab }),
      fetchImpl
    })
    ;(manager as unknown as { config: SyncConfig }).config = config
    await manager.handleQuery({ id: 'q-1', type: 'isolate_count', lab_code: 'LAB01' })
    expect(posted[0]).toMatchObject({ query_id: 'q-1', ok: true, result: { count: 1 } })
    expect(JSON.stringify(posted[0])).not.toContain('patient_id')
    await manager.handleQuery({ id: 'q-2', type: 'organism_distribution', lab_code: 'LAB01' })
    expect(posted[1]).toMatchObject({ query_id: 'q-2', ok: false, error: "site does not allow query type 'organism_distribution'" })
  })

  it('flushes the durable One Health outbox through the exact aggregate ingest contract', async () => {
    const config: SyncConfig = {
      serverUrl: 'https://central.example.org', authToken: 'secret', siteToken: 'site', pickupToken: '', labCode: 'LAB01',
      pollIntervalSeconds: 30, pollTimeoutSeconds: 60, verifyTls: true, autoConfigureToken: false,
      gpsConsent: true, gpsLatitude: 28.61, gpsLongitude: 77.21, allowedQueryTypes: ['isolate_count']
    }
    const requests: Array<{ path: string; body: Record<string, unknown> }> = []
    const sent: string[] = []
    const failed: string[] = []
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ path: new URL(String(url)).pathname, body: JSON.parse(String(init?.body)) as Record<string, unknown> })
      return new Response('{}', { status: 200 })
    }) as unknown as typeof fetch
    const manager = new SyncManager({
      executor: createAggregateExecutor({ listIsolates: () => isolates, getLaboratory: () => lab }),
      fetchImpl,
      appVersion: '2.0-test',
      listOneHealthOutbox: () => [{
        id: 'outbox-1', status: 'pending', payload_hash: 'abc123',
        payload_json: JSON.stringify({ contract: 'national-amr-data-product/1.0', module: 'environment', record_count: 2, metrics: { samples: 2 } })
      }],
      markOneHealthOutboxSent: (id) => { sent.push(id) },
      markOneHealthOutboxFailure: (id) => { failed.push(id) }
    })
    ;(manager as unknown as { config: SyncConfig }).config = config
    expect(await manager.flushOneHealthOutbox()).toBe(1)
    expect(requests[0]).toMatchObject({
      path: '/api/v1/ecosystem/ingest/',
      body: { sector: 'environment', module: 'environment', lineage: { edge_outbox_id: 'outbox-1', payload_sha256: 'abc123', app_version: '2.0-test' } }
    })
    expect(JSON.stringify(requests[0])).not.toContain('patient_id')
    expect(sent).toEqual(['outbox-1'])
    expect(failed).toEqual([])
  })
})
