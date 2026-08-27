// @vitest-environment node

import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

/**
 * A country profile names a logo by filename, and each product resolves that name against
 * its own asset root: the renderer as `./resources/<file>`, the portal as
 * `static('img/<file>')`. Nothing in either resolver checks the file is there — a missing
 * one is a silent 404 and an empty space where the emblem should be.
 *
 * That is not hypothetical. A profile was pointed at `icmr_logo.png`, which existed only
 * under the portal's static folder, and the desktop application shipped with no emblem at
 * all until someone looked at the screen. Tests do not look at screens, so this one checks
 * the filenames instead.
 */

const PROFILE_DIR = join(__dirname, '..', 'resources', 'shared', 'country-profiles')
const RENDERER_ASSETS = join(__dirname, '..', 'src', 'renderer', 'public', 'resources')
const PORTAL_ASSETS = join(__dirname, '..', '..', 'server', 'amrit_central_server', 'central', 'static', 'img')

interface Branding { logo?: string | null; logo_reverse?: string | null }

/** Every shipped profile, by the filename it is stored under. */
function profiles(): Array<[string, { branding?: Branding }]> {
  return readdirSync(PROFILE_DIR)
    .filter((name) => name.endsWith('.json') && name !== 'profile.schema.json')
    .map((name) => [name, JSON.parse(readFileSync(join(PROFILE_DIR, name), 'utf8'))])
}

/** The bundled filenames a profile names. An uploaded data URI is not a file. */
function bundledMarks(branding: Branding | undefined): string[] {
  return [branding?.logo, branding?.logo_reverse]
    .filter((mark): mark is string => typeof mark === 'string' && mark.length > 0 && !mark.startsWith('data:'))
}

describe('branding assets', () => {
  it('finds every mark a shipped profile names, in both products', () => {
    const missing: string[] = []
    for (const [name, profile] of profiles()) {
      for (const mark of bundledMarks(profile.branding)) {
        if (!existsSync(join(RENDERER_ASSETS, mark))) missing.push(`${name}: desktop is missing ${mark}`)
        if (!existsSync(join(PORTAL_ASSETS, mark))) missing.push(`${name}: portal is missing ${mark}`)
      }
    }
    expect(missing).toEqual([])
  })

  it('gives India an emblem and a reversed emblem, because its sidebar is dark', () => {
    const india = JSON.parse(readFileSync(join(PROFILE_DIR, 'IN.json'), 'utf8')) as { branding: Branding }
    expect(india.branding.logo).toBe('icmr-emblem.png')
    expect(india.branding.logo_reverse).toBe('icmr-emblem-light.png')
  })

  it('keeps the two products byte-identical for a shared mark', () => {
    // The same filename resolving to different artwork per product would be worse than a
    // missing file: it would look correct on whichever product the author happened to open.
    for (const [, profile] of profiles()) {
      for (const mark of bundledMarks(profile.branding)) {
        expect(readFileSync(join(RENDERER_ASSETS, mark))).toEqual(readFileSync(join(PORTAL_ASSETS, mark)))
      }
    }
  })
})
