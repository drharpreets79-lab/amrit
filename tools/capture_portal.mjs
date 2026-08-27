/**
 * Screenshot the central portal for the manual.
 *
 * Documentation tooling, not part of either product. It drives a real browser against a
 * running server, signs in as an operator, and writes one PNG per screen — so the manual
 * shows what the portal actually renders rather than a mock-up that drifts.
 *
 *   AMRIT_PORTAL_URL=http://127.0.0.1:8765 \
 *   AMRIT_PORTAL_USER=portaladmin AMRIT_PORTAL_PASSWORD=... \
 *   AMRIT_CAPTURE_DIR=/tmp/shots \
 *   app/node_modules/.bin/electron tools/capture_portal.mjs
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { app, BrowserWindow } from 'electron'

const base = (process.env.AMRIT_PORTAL_URL || 'http://127.0.0.1:8765').replace(/\/$/, '')
const directory = process.env.AMRIT_CAPTURE_DIR || '/tmp/amrit-portal-shots'
const username = process.env.AMRIT_PORTAL_USER || 'portaladmin'
const password = process.env.AMRIT_PORTAL_PASSWORD || ''

/**
 * Every stakeholder's own view of the portal.
 *
 * A role is not a filter on one screen: the dashboard a policy maker opens is a different
 * composition from the one an epidemiologist or a hospital coordinator opens, and their
 * scopes differ too — country, administrative unit, single facility. The manual has to show
 * each of them as that person actually sees it, so each is captured signed in as that role
 * rather than as an administrator with the scope switched.
 *
 * [username, password, [[file name, path, settle], …]]
 */
const ROLE_SCREENS = [
  ['policy_maker', 'Policy@2026', [
    ['portal-role-policy-maker', '/dashboard/', 2000],
    ['portal-role-policy-maker-advanced', '/dashboard/roles/country/?section=advanced', 2000]
  ]],
  ['epidemiologist', 'Epi@2026', [
    ['portal-role-epidemiologist', '/dashboard/', 2000],
    ['portal-role-epidemiologist-outbreaks', '/dashboard/outbreaks/', 2200]
  ]],
  ['researcher', 'Research@2026', [['portal-role-researcher', '/dashboard/', 2000]]],
  ['public_health', 'PubHealth@2026', [['portal-role-public-health', '/dashboard/', 2000]]],
  ['state_officer', 'StateOff@2026', [['portal-role-admin-officer', '/dashboard/', 2000]]],
  ['hospital_admin', 'Hospital@2026', [['portal-role-hospital-admin', '/dashboard/', 2000]]],
  ['press', 'Press@2026', [['portal-role-press', '/dashboard/public/', 1500]]],
  ['citizen', 'Citizen@2026', [['portal-role-citizen', '/dashboard/public/', 1500]]]
]

/** [file name, path, extra settle time for maps and charts]. */
const SCREENS = [
  ['portal-overview', '/', 2500],
  ['portal-sites', '/dashboard/sites/', 900],
  ['portal-map', '/dashboard/sites/map/', 3000],
  ['portal-query-new', '/dashboard/queries/new/', 900],
  ['portal-queries', '/dashboard/queries/', 900],
  ['portal-dashboard-country', '/dashboard/roles/country/', 1500],
  ['portal-dashboard-advanced', '/dashboard/roles/country/?section=advanced', 1800],
  ['portal-action-inbox', '/actions/', 900],
  ['portal-action-tracking', '/actions/tracking/', 900],
  ['portal-audit', '/dashboard/audit/', 900],
  ['portal-public', '/dashboard/public/', 900],
  ['portal-admin-home', '/portal-admin/', 900],
  ['portal-admin-users', '/portal-admin/users/', 900],
  ['portal-admin-roles', '/portal-admin/roles/', 900],
  ['portal-deployment', '/dashboard/deployment/', 1200],
  ['portal-licences', '/dashboard/licences/', 900],
  ['portal-site-requests', '/dashboard/sites/requests/', 900],
  ['portal-outbreaks', '/dashboard/outbreaks/', 2200]
]

const settle = (milliseconds) => new Promise((done) => setTimeout(done, milliseconds))

/** Drop the session so the next sign-in is really that role's, not the last one's. */
async function signOut(window) {
  await window.webContents.session.clearStorageData({ storages: ['cookies'] })
}

async function signIn(window, user = username, secretValue = password) {
  await window.loadURL(`${base}/accounts/login/`)
  await settle(500)
  // A session may already be open from an earlier run, in which case the login URL
  // redirects and there is no form to fill. Signing in again is not an error.
  const outcome = await window.webContents.executeJavaScript(`
    (() => {
      const user = document.querySelector('input[name=username]');
      const secret = document.querySelector('input[name=password]');
      if (!user || !secret) return 'already signed in';
      user.value = ${JSON.stringify(user)};
      secret.value = ${JSON.stringify(secretValue)};
      (user.form || document.querySelector('form')).submit();
      return 'submitted';
    })()
  `)
  console.log(`sign-in: ${outcome}`)
  await settle(1500)
}

app.whenReady().then(async () => {
  await mkdir(directory, { recursive: true })
  const window = new BrowserWindow({
    width: 1440,
    height: 1000,
    show: false,
    webPreferences: { offscreen: false, sandbox: true }
  })

  const capture = async (screens) => {
    for (const [name, path, wait] of screens) {
      try {
        await window.loadURL(`${base}${path}`)
        await settle(wait)
        const image = await window.webContents.capturePage()
        await writeFile(join(directory, `${name}.png`), image.toPNG())
        console.log(`captured ${name}`)
      } catch (error) {
        // A screen a deployment does not expose is reported, not fatal: the manual then
        // simply has no picture of it, which is better than a half-written run.
        console.warn(`skipped ${name}: ${error instanceof Error ? error.message : error}`)
      }
    }
  }

  await signIn(window)
  await capture(SCREENS)

  if (process.env.AMRIT_CAPTURE_ROLES !== '0') {
    for (const [roleUser, rolePassword, screens] of ROLE_SCREENS) {
      await signOut(window)
      await signIn(window, roleUser, rolePassword)
      await capture(screens)
    }
  }
  app.quit()
})
