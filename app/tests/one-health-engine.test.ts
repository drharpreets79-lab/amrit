import { describe, expect, it } from 'vitest'
import {
  ONE_HEALTH_MODULES,
  calculateOneHealthMetrics,
  createOneHealthAggregate,
  evaluateOneHealthRules,
  oneHealthCatalog,
  validateOneHealth
} from '../src/main/one-health-engine'

function minimumValues(moduleKey: string): Record<string, unknown> {
  const values: Record<string, unknown> = {}
  for (const item of ONE_HEALTH_MODULES[moduleKey]?.fields ?? []) {
    if (!item.required) continue
    if (item.choices?.length) values[item.key] = item.choices[0]
    else if (item.kind === 'number') values[item.key] = 1
    else if (item.kind === 'boolean') values[item.key] = true
    else if (item.kind === 'datetime') values[item.key] = '2026-07-13T10:00:00+05:30'
    else values[item.key] = `TEST-${item.key}`
  }
  return values
}

describe('versioned One Health engine', () => {
  it('round-trips minimum valid values for every Python parity module', () => {
    expect(oneHealthCatalog().map((item) => item.key)).toEqual(['human_quality', 'amc', 'stewardship', 'ipc_hai', 'veterinary', 'food', 'environment', 'genomics'])
    for (const moduleKey of Object.keys(ONE_HEALTH_MODULES)) expect(validateOneHealth(moduleKey, minimumValues(moduleKey))).toEqual([])
  })

  it('rejects missing, negative, invalid choice and invalid date fields', () => {
    expect(validateOneHealth('amc', { observed_at: 'bad', quantity_grams: -1, aware_group: 'Unknown' })).toEqual(expect.arrayContaining([
      'Facility / site ID is required', 'Observation date/time must be an ISO date or date-time', 'AWaRe must be one of: Access, Watch, Reserve, Not recommended',
      'Quantity (g) cannot be negative', 'WHO DDD (g) is required'
    ]))
  })

  it('creates explainable deterministic alerts', () => {
    const stewardship = { ...minimumValues('stewardship'), aware_group: 'Reserve', reserve_authorisation: '', review_due_at: '' }
    expect(evaluateOneHealthRules('stewardship', stewardship).map((item) => item.rule_code)).toEqual(['AMS-RESERVE-AUTH', 'AMS-TIMEOUT'])
    expect(evaluateOneHealthRules('food', { custody_status: 'collected', result_value: 2, maximum_limit: 1 }).map((item) => item.rule_code)).toEqual(['FOOD-MRL-EXCEED', 'FOOD-CUSTODY-OPEN'])
  })

  it('matches reference indicator formulas and builds aggregate-only products', () => {
    const metrics = calculateOneHealthMetrics('amc', [
      { quantity_grams: 20, who_ddd_grams: 2, bed_days: 100, aware_group: 'Access' },
      { quantity_grams: 10, who_ddd_grams: 2, bed_days: 100, aware_group: 'Watch' }
    ])
    expect(metrics.ddd).toBe(15)
    expect(metrics.ddd_per_100_bed_days).toBe(7.5)
    expect(metrics.access_share_percent).toBeCloseTo(66.6666667)
    const aggregate = createOneHealthAggregate('environment', 'SITE-1', [{ id: 'event-1', payload: { concentration: 2, resistance_genes: 'blaNDM' } }])
    expect(aggregate).toMatchObject({ contract: 'national-amr-data-product/1.0', module: 'environment', facility_id: 'SITE-1', record_count: 1 })
    expect(JSON.stringify(aggregate)).not.toContain('patient')
  })
})
