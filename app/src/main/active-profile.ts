/**
 * The desktop's country-profile wiring.
 *
 * Phase 17 moved the holder into `core/domain/active-profile.ts`, which knows nothing about
 * files. This is the half that does: it installs the resolver that reads a profile from disk,
 * so every existing caller of `activeProfile()` keeps working unchanged.
 *
 * The resolver is installed on import rather than in `index.ts` because this module is imported
 * by everything that needs a profile, and a startup ordering rule that has to be remembered is
 * one that will eventually be forgotten.
 */

import { setProfileResolver } from '../core/domain/active-profile'
import { getCountryProfile } from './country-profile'

setProfileResolver(() => getCountryProfile(process.env.AMRIT_COUNTRY_PROFILE))

export * from '../core/domain/active-profile'
