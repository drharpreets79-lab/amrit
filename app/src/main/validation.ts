/**
 * Moved to `core/domain/` in Phase 17. This file is the seam's compatibility shim.
 *
 * The extraction's exit criterion is that every existing test passes **unchanged**, which is
 * what makes it an extraction rather than a rewrite: a test that had to be edited to keep
 * passing would be hiding a behaviour change. Callers keep importing the old path and get the
 * same module from its new home. The shims go when the callers do, not before.
 */

export * from '../core/domain/validation'
