// @vitest-environment node

import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { availableGeoPacks, isoFallbackPack, loadGeoPack, validateGeoPack, type GeoPack } from '../src/main/geo-pack'
import { AMRITDatabase } from '../src/main/database'

/**
 * Phase 3 gate: geography is a per-country pack, validated by a loader that carries no
 * per-country knowledge. The India pack is produced by tools/split_catalog_seed.py, so
 * loading it here also proves the Python and TypeScript canonicalisations agree.
 */
describe('geo packs', () => {
  const directories: string[] = []

  afterEach(() => {
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
  })

  const directory = (): string => {
    const path = mkdtempSync(join(tmpdir(), 'amrit-geo-pack-'))
    directories.push(path)
    return path
  }

  const canonical = (value: unknown): string => {
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
    if (value && typeof value === 'object') {
      const row = value as Record<string, unknown>
      return `{${Object.keys(row).sort().map((key) => `${JSON.stringify(key)}:${canonical(row[key])}`).join(',')}}`
    }
    return JSON.stringify(value)
  }

  const pack = (overrides: Partial<GeoPack> = {}): GeoPack => {
    const units = overrides.units ?? [
      { level: 1, code: 'G1', parent_code: null, name: 'محافظة أولى', unit_type: 'governorate' },
      { level: 2, code: 'D1', parent_code: 'G1', name: 'قضاء أول', unit_type: 'district' },
      { level: 3, code: 'S1', parent_code: 'D1', name: 'ناحية أولى', unit_type: 'subdistrict' }
    ]
    const base: GeoPack = {
      schemaVersion: 1,
      dataset: 'amrit-geo-pack',
      version: '1.0',
      countryCode: 'TST',
      countryName: 'Testland',
      levels: [
        { level: 1, key: 'governorate', label: 'محافظة', label_plural: 'المحافظات', code_system: 'ISO3166-2' },
        { level: 2, key: 'district', label: 'قضاء', label_plural: 'الأقضية', code_system: 'GeoNames' },
        { level: 3, key: 'subdistrict', label: 'ناحية', label_plural: 'النواحي', code_system: 'GeoNames' }
      ],
      minimumCounts: { '1': 1, '2': 1, '3': 1 },
      rowCounts: { total: units.length },
      contentSha256: createHash('sha256').update(canonical(units), 'utf8').digest('hex'),
      units,
      ...overrides
    }
    return { ...base, contentSha256: overrides.contentSha256 ?? createHash('sha256').update(canonical(base.units), 'utf8').digest('hex') }
  }

  it('loads the packaged India pack written by the Python splitter', () => {
    const loaded = loadGeoPack('IN', resolve(process.cwd(), 'resources/shared/geo-packs/IN.json'))
    expect(loaded).not.toBeNull()
    expect(loaded?.pack.countryCode).toBe('IND')
    expect(loaded?.pack.rowCounts.total).toBe(36 + 785)
    expect(loaded?.pack.levels.map((level) => level.code_system)).toEqual(['LGD', 'LGD'])
    expect(loaded?.pack.levels[0]?.label).toBe('State / UT')
  })

  it('ships the India pack with the build', () => {
    expect(availableGeoPacks()).toContain('IN')
  })

  it('accepts an arbitrary depth with non-Latin labels', () => {
    const validated = validateGeoPack(pack())
    expect(validated.levels).toHaveLength(3)
    expect(validated.units).toHaveLength(3)
  })

  it('accepts a country with a single level', () => {
    const single = pack({
      levels: [{ level: 1, key: 'region', label: 'Region', label_plural: 'Regions', code_system: 'ISO3166-2' }],
      minimumCounts: { '1': 1 },
      units: [{ level: 1, code: 'R1', parent_code: null, name: 'Region One' }]
    })
    expect(validateGeoPack(single).units).toHaveLength(1)
  })

  it('rejects a unit whose parent is not in the pack', () => {
    const orphaned = pack({
      units: [
        { level: 1, code: 'G1', parent_code: null, name: 'One' },
        { level: 2, code: 'D9', parent_code: 'MISSING', name: 'Orphan' }
      ]
    })
    expect(() => validateGeoPack(orphaned)).toThrow(/references a parent that is not in the pack/)
  })

  it('rejects duplicate codes within a level', () => {
    const duplicated = pack({
      units: [
        { level: 1, code: 'G1', parent_code: null, name: 'One' },
        { level: 1, code: 'G1', parent_code: null, name: 'One again' }
      ]
    })
    expect(() => validateGeoPack(duplicated)).toThrow(/duplicate unit at level 1/)
  })

  it('rejects a top-level unit that claims a parent', () => {
    const wrong = pack({ units: [{ level: 1, code: 'G1', parent_code: 'X', name: 'One' }] })
    expect(() => validateGeoPack(wrong)).toThrow(/must not declare a parent/)
  })

  it('rejects a level that is not declared', () => {
    const undeclared = pack({
      levels: [{ level: 1, key: 'region', label: 'Region', label_plural: 'Regions', code_system: 'ISO3166-2' }],
      minimumCounts: { '1': 1 },
      units: [
        { level: 1, code: 'R1', parent_code: null, name: 'One' },
        { level: 2, code: 'X1', parent_code: 'R1', name: 'Undeclared' }
      ]
    })
    expect(() => validateGeoPack(undeclared)).toThrow(/undeclared level 2/)
  })

  it('rejects a truncated pack using the counts it declares about itself', () => {
    const truncated = pack({ minimumCounts: { '1': 50 } })
    expect(() => validateGeoPack(truncated)).toThrow(/level 1 is unexpectedly small/)
  })

  it('rejects tampered content', () => {
    const tampered = pack()
    tampered.units[0]!.name = 'Renamed after hashing'
    expect(() => validateGeoPack(tampered)).toThrow(/content hash mismatch/)
  })

  it('returns null rather than throwing when a country has no pack', () => {
    expect(loadGeoPack('ZZ')).toBeNull()
  })

  it('reads a pack from disk', () => {
    const path = join(directory(), 'TST.json')
    writeFileSync(path, JSON.stringify(pack()), 'utf8')
    expect(loadGeoPack('TST', path)?.pack.countryCode).toBe('TST')
  })

  it('imports a pack at runtime, adding a country the build never shipped', () => {
    const dir = directory()
    const packPath = join(dir, 'TST.json')
    writeFileSync(packPath, JSON.stringify(pack()), 'utf8')

    const database = new AMRITDatabase(join(dir, 'amrit.sqlite3')).initialize()
    try {
      const result = database.importGeoPack(packPath)
      expect(result).toEqual({ countryCode: 'TST', units: 3 })

      const units = database.listMaster('admin-units', { includeInactive: true, limit: 10000 } as never)
      expect(units).toHaveLength(3)
      const deepest = units.find((unit) => Number(unit.level) === 3)
      // The materialised path is built from the pack's own parent chain.
      expect(deepest?.admin_path).toBe('TST/G1/D1/S1')
      expect(deepest?.parent_id).toBe('TST:2:D1')

      // Re-importing updates in place rather than duplicating.
      const renamed = pack()
      renamed.units[0]!.name = 'Renamed governorate'
      renamed.contentSha256 = createHash('sha256')
        .update(canonical(renamed.units), 'utf8').digest('hex')
      writeFileSync(packPath, JSON.stringify(renamed), 'utf8')
      database.importGeoPack(packPath)

      const after = database.listMaster('admin-units', { includeInactive: true, limit: 10000 } as never)
      expect(after).toHaveLength(3)
      expect(after.find((unit) => unit.code === 'G1')?.name).toBe('Renamed governorate')
    } finally {
      database.close()
    }
  })

  describe('ISO 3166-2 fallback', () => {
    it('gives a country with no curated pack its subdivisions', () => {
      // Before this, such a country started with an empty tree and could scope nothing
      // until someone imported units by hand.
      const nigeria = isoFallbackPack('NGA')
      expect(nigeria?.countryCode).toBe('NGA')
      expect(nigeria?.units.length).toBe(37)
      expect(nigeria?.levels[0]?.code_system).toBe('ISO3166-2')
    })

    it("names the level after the standard's own subdivision type", () => {
      // "Emirate" and "Land" rather than a generic "Administrative area".
      expect(isoFallbackPack('ARE')?.levels[0]?.label).toBe('Emirate')
      expect(isoFallbackPack('DEU')?.levels[0]?.label).toBe('Land')
      expect(isoFallbackPack('NGA')?.levels[0]?.label).toBe('State')
    })

    it('carries the ISO licence with the pack', () => {
      expect(isoFallbackPack('NGA')?.licence?.name).toBe('ISO 3166-2')
    })

    it('returns null for a territory the standard gives no subdivisions', () => {
      // Fifty of them; they keep an empty tree and import their own units.
      expect(isoFallbackPack('BMU')).toBeNull()
    })

    it('is used automatically when no curated pack exists', () => {
      const loaded = loadGeoPack('NGA')
      expect(loaded?.pack.countryCode).toBe('NGA')
      expect(loaded?.pack.units.length).toBe(37)
    })

    it('does not override a curated pack', () => {
      // India's LGD codes are not ISO 3166-2 and must win.
      const loaded = loadGeoPack('IN')
      expect(loaded?.pack.countryCode).toBe('IND')
      expect(loaded?.pack.levels[0]?.code_system).toBe('LGD')
      expect(loaded?.pack.units.length).toBe(36 + 785)
    })

    it('is not advertised as a country pack', () => {
      expect(availableGeoPacks()).not.toContain('_iso3166-2')
    })
  })
})
