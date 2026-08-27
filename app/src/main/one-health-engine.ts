/**
 * Moved to `core/domain/` in Phase 17. This file is the seam's compatibility shim.
 *
 * The extraction's exit criterion is that every existing test passes **unchanged**, which is
 * what makes it an extraction rather than a rewrite: a test that had to be edited to keep
 * passing would be hiding a behaviour change. Callers keep importing the old path and get the
 * same module from its new home. The shims go when the callers do, not before.
 */

// Importing the desktop's profile wiring for its side effect: it installs the resolver that
// `core/domain/active-profile.ts` refuses to invent for itself. A caller that reached this
// module through its old path is on the desktop by definition, and expects the behaviour the
// old path had — the extraction is not allowed to change it.
import './active-profile'

export * from '../core/domain/one-health-engine'
