/**
 * The English catalogue — the source language, and the only one shipped today.
 *
 * One namespace per screen, plus `common` for the shared primitives. Keys are grouped by the
 * component that renders them rather than by phrase, so a translator sees each string in the
 * order it appears on screen and a reviewer can tell at a glance which screen a change affects.
 *
 * Imported as JSON on purpose: a translator edits these files without reading TypeScript, and
 * `makemessages`-style tooling can read them directly.
 */
import address from './address.json'
import ai from './ai.json'
import analytics from './analytics.json'
import audit from './audit.json'
import breakpoints from './breakpoints.json'
import common from './common.json'
import dashboard from './dashboard.json'
import deployment from './deployment.json'
import exports from './exports.json'
import imports from './imports.json'
import laboratories from './laboratories.json'
import masters from './masters.json'
import oneHealth from './oneHealth.json'
import records from './records.json'
import shell from './shell.json'
import sync from './sync.json'

export default {
  address, ai, analytics, audit, breakpoints, common, dashboard, deployment, exports, imports,
  laboratories, masters, oneHealth, records, shell, sync
}
