import type React from 'react'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { indiaProfile, testlandProfile } from './helpers/profile'
import { ToastProvider } from '../src/renderer/components/Toast'
import { DeploymentPage } from '../src/renderer/pages/DeploymentPage'
import { overridesFor } from '../src/shared/deployment'
import type { AMRITApi } from '../src/shared/api'
import type { CountryProfile } from '../src/shared/types'

/**
 * Phase 6b, desktop half: an administrator edits every profile-driven value from the UI.
 *
 * The main process enforces authorisation and validation again on every one of these calls;
 * these tests cover the screen's own obligations — that it sends only what was changed, that
 * an irreversible change cannot be saved by accident, and that a refusal is shown rather
 * than swallowed.
 */
describe('DeploymentPage', () => {
  const get = vi.fn<() => Promise<{ overrides: Record<string, unknown>; profile: CountryProfile }>>()
  const save = vi.fn<(overrides: Record<string, unknown>, options?: { confirmIrreversible?: boolean }) => Promise<CountryProfile>>()
  const selectCountry = vi.fn<(countryCode: string, options?: { confirmCountryChange?: boolean }) => Promise<CountryProfile>>()
  const reset = vi.fn<() => Promise<CountryProfile>>()
  const logo = vi.fn<(path: string) => Promise<CountryProfile>>()
  const exportProfile = vi.fn<(path: string) => Promise<string>>()
  const importProfile = vi.fn<(path: string) => Promise<CountryProfile>>()
  const purge = vi.fn<(options?: { dryRun?: boolean }) => Promise<Record<string, unknown>>>()
  const eraseAudit = vi.fn<(objectType: string, objectId: string, reason: string) => Promise<{ erased: number; alreadyErased: number }>>()
  const chooseFile = vi.fn<() => Promise<string | null>>()
  const chooseSave = vi.fn<() => Promise<string | null>>()
  const onChanged = vi.fn<() => Promise<void>>()

  beforeEach(() => {
    vi.clearAllMocks()
    get.mockResolvedValue({ overrides: {}, profile: indiaProfile })
    save.mockResolvedValue(indiaProfile)
    selectCountry.mockResolvedValue(testlandProfile)
    reset.mockResolvedValue(indiaProfile)
    logo.mockResolvedValue(indiaProfile)
    exportProfile.mockResolvedValue('/tmp/IN.json')
    importProfile.mockResolvedValue(testlandProfile)
    onChanged.mockResolvedValue()
    purge.mockResolvedValue({ applied: true, dryRun: true, retentionDays: 30, cutoff: '2026-07-13', removed: [{ table: 'isolates', label: 'Isolate records', rows: 4 }] })
    eraseAudit.mockResolvedValue({ erased: 2, alreadyErased: 0 })
    const api = {
      countries: vi.fn(async () => [
        { alpha3: 'IND', alpha2: 'IN', name: 'India', who_region: 'SEARO' },
        { alpha3: 'TST', alpha2: 'TS', name: 'Testland', who_region: 'EMRO' }
      ]),
      deployment: { get, save, selectCountry, reset, logo, export: exportProfile, import: importProfile },
      privacy: { purge, eraseAudit },
      chooseFile, chooseSave
    } as unknown as AMRITApi
    Object.defineProperty(window, 'amrit', { configurable: true, value: api })
  })

  const view = (): React.JSX.Element => <ToastProvider><DeploymentPage onChanged={onChanged} /></ToastProvider>

  it('renders one row per administrative level, labelled by the profile', async () => {
    get.mockResolvedValue({ overrides: {}, profile: testlandProfile })
    render(view())
    await screen.findByRole('heading', { name: 'Administrative levels' })
    expect(screen.getByDisplayValue('محافظة')).toBeInTheDocument()
    expect(screen.getByDisplayValue('قضاء')).toBeInTheDocument()
    expect(screen.getByDisplayValue('ناحية')).toBeInTheDocument()
  })

  it('requires confirmation before changing an already configured country', async () => {
    render(view())
    const picker = await screen.findByRole('combobox', { name: /^Deployment country/ })
    await waitFor(() => expect(picker).toHaveValue('India'))
    fireEvent.change(picker, { target: { value: 'TST' } })
    expect(selectCountry).not.toHaveBeenCalled()

    const dialog = await screen.findByRole('dialog', { name: 'Change the deployment country?' })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Change country' }))
    await waitFor(() => expect(selectCountry).toHaveBeenCalledWith('TST', { confirmCountryChange: true }))
  })

  it('sends only the fields that changed, so untouched settings keep tracking the base profile', async () => {
    render(view())
    const productName = await screen.findByLabelText(/^Product name/)
    fireEvent.change(productName, { target: { value: 'National AMR Portal' } })
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }))

    await waitFor(() => expect(save).toHaveBeenCalled())
    const [sent] = save.mock.calls[0]!
    expect(Object.keys(sent)).toEqual(['branding'])
    expect((sent.branding as Record<string, unknown>).product_name).toBe('National AMR Portal')
  })

  it('refuses to save a namespace change until it is explicitly confirmed', async () => {
    // Mirrors the main process, which is where the rule is actually enforced: an unconfirmed
    // namespace change is rejected, so the screen must not report a save that did not happen.
    save.mockImplementation(async (_overrides, options) => {
      if (!options?.confirmIrreversible) throw new Error('Changing the identifier namespace cannot be undone.')
      return indiaProfile
    })
    render(view())
    fireEvent.change(await screen.findByLabelText(/^Base URI/), { target: { value: 'https://amr.example.gov' } })

    fireEvent.click(screen.getByRole('button', { name: /save changes/i }))
    await waitFor(() => expect(save).toHaveBeenCalledWith(expect.anything(), { confirmIrreversible: false }))
    expect(await screen.findByText('Changing the identifier namespace cannot be undone.')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('switch', { name: /want to change the identifier namespace/i }))
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }))
    await waitFor(() => expect(save).toHaveBeenCalledWith(expect.anything(), { confirmIrreversible: true }))
  })

  it('shows the main process refusal rather than reporting a save that did not happen', async () => {
    save.mockRejectedValue(new Error("Error invoking remote method 'deployment-settings:save': Error: SVG logos are not accepted."))
    render(view())
    fireEvent.change(await screen.findByLabelText(/^Product name/), { target: { value: 'Changed' } })
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }))
    expect(await screen.findByText('SVG logos are not accepted.')).toBeInTheDocument()
  })

  it('explains the restriction instead of a blank screen when the caller is not an administrator', async () => {
    get.mockRejectedValue(new Error('Permission denied: users:manage'))
    render(view())
    expect(await screen.findByRole('alert')).toHaveTextContent(/One Health administrator/i)
  })

  it('names the fields that a running installation cannot change', async () => {
    render(view())
    expect(await screen.findByText('Application id')).toBeInTheDocument()
    expect(screen.getByText('Code-signing identity')).toBeInTheDocument()
  })

  it('lists what this deployment has customised and reverts one field without touching the rest', async () => {
    get.mockResolvedValue({
      overrides: { branding: { product_name: 'Custom' }, map: { zoom: 6 } },
      profile: indiaProfile
    })
    render(view())
    await screen.findByRole('heading', { name: 'Customisations' })
    const [revertBranding] = screen.getAllByRole('button', { name: /revert to base/i })
    fireEvent.click(revertBranding!)
    await waitFor(() => expect(save).toHaveBeenCalled())
    expect(save.mock.calls[0]![0]).toEqual({ map: { zoom: 6 } })
  })

  it('validates a chosen logo through the main process rather than storing it from the renderer', async () => {
    chooseFile.mockResolvedValue('/tmp/emblem.png')
    render(view())
    fireEvent.click(await screen.findByRole('button', { name: /choose a logo/i }))
    await waitFor(() => expect(logo).toHaveBeenCalledWith('/tmp/emblem.png'))
    expect(save).not.toHaveBeenCalled()
  })

  it('round-trips an effective profile between deployments', async () => {
    chooseSave.mockResolvedValue('/tmp/IN.json')
    chooseFile.mockResolvedValue('/tmp/TESTLAND.json')
    render(view())
    fireEvent.click(await screen.findByRole('button', { name: /^export$/i }))
    await waitFor(() => expect(exportProfile).toHaveBeenCalledWith('/tmp/IN.json'))

    fireEvent.click(screen.getByRole('button', { name: /^import$/i }))
    await waitFor(() => expect(importProfile).toHaveBeenCalledWith('/tmp/TESTLAND.json', { confirmIrreversible: false }))
    expect(await screen.findByDisplayValue('AMR Testland')).toBeInTheDocument()
  })

  describe('DeploymentPage privacy operations', () => {
    const retaining = { ...indiaProfile, privacy: { k_anonymity_floor: 5, retention_days: 30 } }

    beforeEach(() => { get.mockResolvedValue({ overrides: {}, profile: retaining }) })

    it('offers nothing to purge when the profile sets no retention period', async () => {
      get.mockResolvedValue({ overrides: {}, profile: indiaProfile })
      render(view())
      await screen.findByRole('heading', { name: 'Retention and erasure' })
      expect(screen.queryByRole('button', { name: /preview what would expire/i })).not.toBeInTheDocument()
    })

    it('previews as a dry run before anything can be deleted', async () => {
      render(view())
      fireEvent.click(await screen.findByRole('button', { name: /preview what would expire/i }))
      await waitFor(() => expect(purge).toHaveBeenCalledWith({ dryRun: true }))
      expect(await screen.findByText(/4 in Isolate records/)).toBeInTheDocument()
    })

    it('will not purge without an explicit confirmation', async () => {
      render(view())
      fireEvent.click(await screen.findByRole('button', { name: /preview what would expire/i }))
      await screen.findByText(/4 in Isolate records/)

      purge.mockClear()
      fireEvent.click(screen.getByRole('button', { name: /^purge expired data$/i }))
      expect(purge).not.toHaveBeenCalled()

      const dialog = await screen.findByRole('dialog', { name: 'Purge expired data?' })
      fireEvent.click(within(dialog).getByRole('button', { name: /^purge expired data$/i }))
      await waitFor(() => expect(purge).toHaveBeenCalledWith({ dryRun: false }))
    })

    it('erases audit details only after naming the subject, the record and a reason', async () => {
      render(view())
      await screen.findByRole('heading', { name: 'Retention and erasure' })
      const erase = screen.getByRole('button', { name: /^erase details$/i })
      expect(erase).toBeDisabled()

      fireEvent.change(screen.getByLabelText(/^Record type/), { target: { value: 'user' } })
      fireEvent.change(screen.getByLabelText(/^Record identifier/), { target: { value: 'subject-1' } })
      fireEvent.change(screen.getByLabelText(/^Reason for erasure/), { target: { value: 'subject request' } })
      fireEvent.click(screen.getByRole('button', { name: /^erase details$/i }))
      expect(eraseAudit).not.toHaveBeenCalled()

      const dialog = await screen.findByRole('dialog', { name: 'Erase these audit details?' })
      fireEvent.click(within(dialog).getByRole('button', { name: /^erase details$/i }))
      await waitFor(() => expect(eraseAudit).toHaveBeenCalledWith('user', 'subject-1', 'subject request'))
    })

    it('reports a refused purge instead of implying it succeeded', async () => {
      purge.mockRejectedValue(new Error('Permission denied: users:manage'))
      render(view())
      fireEvent.click(await screen.findByRole('button', { name: /preview what would expire/i }))
      expect(await screen.findByText('Permission denied: users:manage')).toBeInTheDocument()
    })
  })
})

describe('overridesFor', () => {
  it('carries stored overrides through untouched when an unrelated field is edited', () => {
    const stored = { map: { zoom: 6 } }
    const next = overridesFor(stored, indiaProfile, { ...indiaProfile, country_name: 'Bhārat' })
    expect(next).toEqual({ map: { zoom: 6 }, country_name: 'Bhārat' })
  })

  it('writes nothing when nothing was edited', () => {
    expect(overridesFor({}, indiaProfile, indiaProfile)).toEqual({})
  })
})
