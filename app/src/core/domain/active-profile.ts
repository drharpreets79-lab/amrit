/**
 * The profile in force for this process, without knowing how a profile is loaded.
 *
 * Phase 17. The old module read `process.env.AMRIT_COUNTRY_PROFILE` and called
 * `getCountryProfile`, which reads files — so a pure domain module that only wanted to know
 * which country it was running for dragged the filesystem in behind it. Four modules failed the
 * `core/` purity gate for exactly that reason, which is what the gate is for.
 *
 * The holder is the same; what changed is where the fallback comes from. The host resolves a
 * profile however its platform allows — a file on the desktop, a bundled asset on a phone — and
 * calls `setProfileResolver` once at startup. `core/` never learns which.
 */

import type { CountryProfile } from '../../shared/types'

let override: CountryProfile | null = null
let resolver: (() => CountryProfile) | null = null

/**
 * How this platform produces a profile when none has been set explicitly.
 *
 * Called once by the host during startup. Until it is, `activeProfile()` throws rather than
 * inventing a country: a surveillance record filed under the wrong country's rules is worse
 * than a startup that stops and says what is missing.
 */
export function setProfileResolver(resolve: () => CountryProfile): void {
  resolver = resolve
}

export function setActiveCountryProfile(profile: CountryProfile | null): void {
  override = profile
}

export function activeProfile(): CountryProfile {
  if (override) return override
  if (!resolver) {
    throw new Error('No country profile resolver has been installed. The host calls '
      + 'setProfileResolver() during startup; core/ cannot read one for itself because it does '
      + 'not know whether this platform has a filesystem.')
  }
  return resolver()
}

/** Run an operation with a specific profile in force, then restore the previous one. */
export function withCountryProfile<T>(profile: CountryProfile, operation: () => T): T {
  const previous = override
  override = profile
  try {
    return operation()
  } finally {
    override = previous
  }
}
