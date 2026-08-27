import type { Row } from '../../shared/types'
import { activeProfile } from './active-profile'

export type OneHealthExportFormat = 'aggregate' | 'glass' | 'animuse' | 'infarm'

function payload(event: Row): Record<string, unknown> {
  const value = event.payload
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

function generatedAt(): string {
  return new Date().toISOString()
}

export function glassProduct(events: Row[]): Record<string, unknown> {
  return {
    profile: 'WHO-GLASS-compatible/1.0',
    generated_at: generatedAt(),
    records: events.map((event) => {
      const values = payload(event)
      return {
        laboratory: event.facility_id ?? null,
        date: event.observed_at ?? null,
        organism: values.organism ?? null,
        specimen: values.sample_type ?? null,
        susceptibility: values.ast_summary ?? null,
        quality_status: event.quality_status ?? null
      }
    })
  }
}

/**
 * WOAH ANIMUSE requires a reporting country on every record. It used to be the literal
 * 'IND', which made every deployment report as India; it now comes from the active
 * country profile. The India profile still yields 'IND', so existing output is unchanged.
 */
export function animuseProduct(events: Row[], countryCode = activeProfile().country_code): Record<string, unknown> {
  return {
    profile: 'WOAH-ANIMUSE-aligned/1.0',
    generated_at: generatedAt(),
    records: events.map((event) => {
      const values = payload(event)
      return {
        country: countryCode,
        species: values.host_species ?? null,
        production_class: values.production_class ?? null,
        active_ingredient: values.active_ingredient ?? null,
        quantity_mg: values.quantity_mg ?? null,
        biomass_kg: values.biomass_kg ?? null,
        route: values.route ?? null,
        purpose: values.purpose ?? null
      }
    })
  }
}

export function infarmProduct(animalEvents: Row[], foodEvents: Row[]): Record<string, unknown> {
  const records: Array<Record<string, unknown>> = []
  for (const [sector, events] of [['animal', animalEvents], ['food', foodEvents]] as const) {
    for (const event of events) {
      const values = payload(event)
      records.push({
        sector,
        facility: event.facility_id ?? null,
        date: event.observed_at ?? null,
        host_or_commodity: values.host_species ?? values.commodity ?? null,
        sample: values.sample_type ?? values.sample_id ?? null,
        organism: values.organism ?? null,
        ast: values.ast_summary ?? null,
        sampling_frame: values.sampling_frame ?? values.sampling_programme ?? null
      })
    }
  }
  return { profile: 'FAO-InFARM-compatible/1.0', generated_at: generatedAt(), records }
}
