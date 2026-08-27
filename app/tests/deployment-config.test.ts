// @vitest-environment node

import { describe, expect, it } from 'vitest'

import {
  applyOverrides,
  detectImageFormat,
  irreversibleChanges,
  logoDataUri,
  overridesFromProfile,
  validateHttpsUrl,
  validateLogo,
  validateOverrides,
  validateUrnPrefix
} from '../src/main/deployment-config'
import { indiaProfile } from './helpers/profile'

const bytes = (...values: number[]): Uint8Array => new Uint8Array(values)
const ascii = (text: string): Uint8Array => new Uint8Array([...text].map((c) => c.charCodeAt(0)))
const PNG_HEADER = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)

/**
 * Phase 6b gate: the settings screen's security rules, mirroring the server's.
 * Each case is a route by which an administrator-supplied value reaches somewhere it is
 * rendered, fetched, or written into exported FHIR.
 */
describe('deployment settings validation', () => {
  describe('logo uploads', () => {
    it('refuses SVG outright, whatever the file is called', () => {
      expect(() => validateLogo(ascii('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'logo.svg'))
        .toThrow(/SVG/)
      // A lying filename must not help.
      expect(() => validateLogo(ascii('<?xml version="1.0"?><svg onload="alert(1)"/>'), 'logo.png'))
        .toThrow(/SVG/)
    })

    it('judges content by its bytes, not by its name', () => {
      expect(() => validateLogo(ascii('GIF89a not really an image'), 'logo.png'))
        .toThrow(/not a PNG, JPEG or WebP/)
      expect(() => validateLogo(ascii('<html><script>alert(1)</script></html>'), 'logo.jpg'))
        .toThrow(/not a PNG, JPEG or WebP/)
    })

    it('refuses an empty or oversized file', () => {
      expect(() => validateLogo(new Uint8Array(0), 'logo.png')).toThrow(/empty/)
      const huge = new Uint8Array(3 * 1024 * 1024)
      huge.set(PNG_HEADER)
      expect(() => validateLogo(huge, 'logo.png')).toThrow(/limit is/)
    })

    it('accepts the three renderable formats', () => {
      expect(validateLogo(new Uint8Array([...PNG_HEADER, 0, 0]), 'logo.png').contentType).toBe('image/png')
      expect(validateLogo(bytes(0xff, 0xd8, 0xff, 0xe0, 0, 0), 'logo.jpg').contentType).toBe('image/jpeg')
      const webp = new Uint8Array([...ascii('RIFF'), 0, 0, 0, 0, ...ascii('WEBP')])
      expect(validateLogo(webp, 'logo.webp').contentType).toBe('image/webp')
    })

    it('refuses a RIFF container that is not WebP', () => {
      const wav = new Uint8Array([...ascii('RIFF'), 0, 0, 0, 0, ...ascii('WAVE')])
      expect(detectImageFormat(wav)).toBeNull()
      expect(() => validateLogo(wav, 'logo.webp')).toThrow(/not a PNG, JPEG or WebP/)
    })
  })

  describe('URLs', () => {
    it('accepts only absolute https', () => {
      for (const bad of [
        'javascript:alert(1)',
        'data:text/html;base64,PHNjcmlwdD4=',
        'file:///etc/passwd',
        'http://example.org',
        '//example.org',
        'example.org',
        ''
      ]) {
        expect(() => validateHttpsUrl(bad, 'Base URI')).toThrow()
      }
      expect(validateHttpsUrl('https://amr.example/', 'Base URI')).toBe('https://amr.example')
    })

    it('enforces the URN prefix shape', () => {
      expect(validateUrnPrefix('urn:example:amr')).toBe('urn:example:amr')
      expect(validateUrnPrefix('urn:example:amr:')).toBe('urn:example:amr')
      for (const bad of ['example:amr', 'urn:', 'urn:Example:AMR']) {
        expect(() => validateUrnPrefix(bad)).toThrow()
      }
    })
  })

  describe('override documents', () => {
    it('refuses build-time-only settings with an explanation', () => {
      expect(() => validateOverrides({ branding: { app_id: 'com.example.amr' } }))
        .toThrow(/built and signed/)
    })

    it('refuses unknown settings', () => {
      expect(() => validateOverrides({ not_a_setting: 1 })).toThrow(/Unknown setting/)
    })

    it('sends namespace and tile URLs through the URL rule', () => {
      expect(() => validateOverrides({
        identifier_namespace: { base_uri: 'javascript:alert(1)', urn_prefix: 'urn:x:y' }
      })).toThrow()
      expect(() => validateOverrides({ map: { tile_url: 'http://tiles.example/{z}.png' } })).toThrow()
    })

    it('requires hex colours', () => {
      expect(() => validateOverrides({ branding: { colors: { navy: 'red' } } })).toThrow(/hex/)
    })

    it('accepts a valid document', () => {
      const cleaned = validateOverrides({
        identifier_namespace: { base_uri: 'https://amr.example', urn_prefix: 'urn:example:amr' },
        map: { tile_url: 'https://tiles.example/{z}/{x}/{y}.png' }
      })
      expect((cleaned.identifier_namespace as Record<string, unknown>).base_uri).toBe('https://amr.example')
    })
  })

  describe('applying overrides', () => {
    it('merges one level deep and keeps the rest of the profile', () => {
      const merged = applyOverrides(indiaProfile, { branding: { product_name: 'AMR Example' } })
      expect(merged.branding?.product_name).toBe('AMR Example')
      // Untouched keys inside the same object survive.
      expect(merged.branding?.authority_name).toBe('Indian Council of Medical Research')
      expect(merged.country_code).toBe('IND')
    })

    it('refuses a merge that would produce an invalid profile', () => {
      expect(() => applyOverrides(indiaProfile, { admin_levels: [{ level: 99 }] as never })).toThrow()
    })

    it('reports a namespace change as irreversible', () => {
      const current = { identifier_namespace: { base_uri: 'https://a.example', urn_prefix: 'urn:a:b' } }
      const proposed = { identifier_namespace: { base_uri: 'https://b.example', urn_prefix: 'urn:a:b' } }
      expect(irreversibleChanges(current, proposed)).toEqual(['identifier_namespace'])
      expect(irreversibleChanges(current, current)).toEqual([])
    })
  })

  describe('adopting an exported profile', () => {
    it('takes the editable fields and drops what belongs to the exporting build', () => {
      const adopted = overridesFromProfile({
        ...indiaProfile,
        profile_id: 'IN',
        country_code: 'IND',
        branding: { product_name: 'AMR Example', authority_name: 'Ministry', app_id: 'gov.example.amr' }
      } as unknown as Record<string, unknown>)
      // Identity comes from this installation's own country resolution, never from a file.
      expect(adopted.profile_id).toBeUndefined()
      expect(adopted.country_code).toBeUndefined()
      // The application id belongs to the signed bundle that exported it.
      expect(adopted.branding).toEqual({ product_name: 'AMR Example', authority_name: 'Ministry' })
      expect(adopted.country_name).toBe('India')
    })

    it('refuses a document that carries nothing this deployment can adopt', () => {
      expect(() => overridesFromProfile({ profile_id: 'IN', country_code: 'IND' })).toThrow(/no settings/)
      expect(() => overridesFromProfile([] as unknown as Record<string, unknown>)).toThrow(/JSON object/)
    })

    it('validates an imported document by the same rules as a typed one', () => {
      expect(() => overridesFromProfile({
        identifier_namespace: { base_uri: 'javascript:alert(1)', urn_prefix: 'urn:a:b' }
      })).toThrow(/https/)
    })
  })

  describe('storing a re-encoded logo', () => {
    it('carries the content type the bytes were re-encoded to', () => {
      expect(logoDataUri(PNG_HEADER, 'image/png')).toBe('data:image/png;base64,iVBORw0KGgo=')
    })

    it('refuses to store an empty re-encode rather than recording a broken image', () => {
      expect(() => logoDataUri(new Uint8Array(), 'image/png')).toThrow(/could not be re-encoded/)
    })
  })
})
