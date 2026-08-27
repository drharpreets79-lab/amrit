import type React from 'react'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { indiaProfile, testlandProfile } from './helpers/profile'
import { ToastProvider } from '../src/renderer/components/Toast'
import { LaboratoriesPage } from '../src/renderer/pages/LaboratoriesPage'
import type { AMRITApi } from '../src/shared/api'
import type { Laboratory, LaboratoryCloneResult, MasterKind, Row } from '../src/shared/types'

const source: Laboratory = {
  code: 'SOURCE', name: 'Source Laboratory', country: 'India', country_code: 'IND',
  admin_unit_id: 'IND:2:10', admin_path: 'IND/1/10',
  address: { country_code: 'IND', address_lines: ['12 Hospital Road'], locality: 'Ernakulam', admin_area: 'Kerala', postal_code: '682011' },
  site_group: 'Human health',
  default_guideline: 'EUCAST', default_test_method: 'MIC', guideline_year: '2025'
}

/** Only the parts of the pack the form reads. India: street, city, state, PIN. */
const indiaAddressFormat = {
  alpha2: 'IN', format: '%N%n%O%n%A%n%C %Z%n%S', latin_format: null,
  fields: ['recipient', 'organization', 'address_lines', 'locality', 'admin_area', 'postal_code'],
  required: ['address_lines', 'locality', 'admin_area', 'postal_code'],
  uppercase: [],
  labels: { admin_area: 'state', locality: 'city', dependent_locality: 'suburb', postal_code: 'pin' },
  postal_code_pattern: '\\d{6}', postal_code_examples: ['110001'], postal_code_prefix: null,
  language: 'en', languages: ['en', 'hi'], postal_authority_url: null, admin_area_iso_codes: []
}

/** The United States entry, trimmed the same way: street, city, state, ZIP. */
const usAddressFormat = {
  ...indiaAddressFormat,
  alpha2: 'US', format: '%N%n%O%n%A%n%C, %S %Z',
  required: ['address_lines', 'locality', 'admin_area', 'postal_code'],
  labels: { admin_area: 'state', locality: 'city', dependent_locality: 'suburb', postal_code: 'zip' },
  postal_code_pattern: '\\d{5}(?:-\\d{4})?', postal_code_examples: ['95014'], language: 'en', languages: ['en']
}

describe('LaboratoriesPage configuration copy', () => {
  const clone = vi.fn<(sourceCode: string, targetLab: Laboratory) => Promise<LaboratoryCloneResult>>()
  const save = vi.fn<(lab: Laboratory) => Promise<Laboratory>>()
  const onChanged = vi.fn<() => Promise<void>>()

  beforeEach(() => {
    vi.clearAllMocks()
    clone.mockResolvedValue({
      laboratory: { code: 'TARGET', name: 'Target Laboratory' }, sourceCode: 'SOURCE', counts: { lab_panels: 1 },
      copied: ['panels'], excluded: ['isolates']
    })
    save.mockImplementation(async (lab) => lab)
    onChanged.mockResolvedValue()
    const masterRows: Partial<Record<MasterKind, Row[]>> = {
      domains: [{ code: 'HUMAN', label: 'Human health' }, { code: 'ENVIRONMENT', label: 'Environment' }],
      codeValues: [{ code_set: 'country', code: 'IND', display_label: 'India' }],
      // Named to match the source laboratory's address, because the reporting unit is now
      // resolved from the address rather than picked from a dropdown.
      'admin-units': [
        { id: 'IND:1:1', country_code: 'IND', level: 1, parent_id: null, code: 'IN-KL', name: 'Kerala', admin_path: 'IND/1' },
        { id: 'IND:2:10', country_code: 'IND', level: 2, parent_id: 'IND:1:1', code: '10', name: 'Ernakulam', admin_path: 'IND/1/10' }
      ]
    }
    const api = {
      labs: {
        list: vi.fn(), save, clone, delete: vi.fn(), select: vi.fn()
      },
      masters: {
        list: vi.fn(async (kind: MasterKind) => masterRows[kind] ?? [])
      },
      addressFormat: vi.fn(async (code: string) => code === 'USA' ? usAddressFormat : indiaAddressFormat),
      countries: vi.fn(async () => [
        { alpha3: 'IND', alpha2: 'IN', name: 'India', who_region: 'SEARO' },
        { alpha3: 'NPL', alpha2: 'NP', name: 'Nepal', who_region: 'SEARO' },
        { alpha3: 'USA', alpha2: 'US', name: 'United States of America', who_region: 'AMRO' }
      ]),
      geo: {
        postalCode: vi.fn(async () => ({ candidates: [], postalCodeUnknown: false, countryHasNoPostalDirectory: false })),
        locality: vi.fn(async () => []),
        reportingUnits: vi.fn(async (countryCode: string) =>
          (masterRows['admin-units'] ?? []).filter((row) => String(row.country_code ?? '') === countryCode))
      }
    } as unknown as AMRITApi
    Object.defineProperty(window, 'amrit', { configurable: true, value: api })
  })

  function view(): React.JSX.Element {
    return <ToastProvider><LaboratoriesPage laboratories={[source]} currentLab={source} countryProfile={indiaProfile} onChanged={onChanged} /></ToastProvider>
  }

  it('uses the clone IPC and clearly excludes operational, credential and One Health data', async () => {
    render(view())
    fireEvent.click(screen.getByRole('button', { name: /copy configuration/i }))
    const dialog = screen.getByRole('dialog', { name: 'Copy laboratory configuration' })
    expect(within(dialog).getByText(/never copies isolates, AST results, import history, audits/i)).toBeInTheDocument()
    expect(within(dialog).getByText(/credentials, tokens, One Health events or catalogue-seed state/i)).toBeInTheDocument()
    expect(within(dialog).queryByLabelText('Default guideline')).not.toBeInTheDocument()

    fireEvent.change(within(dialog).getByLabelText(/Laboratory code/), { target: { value: 'target' } })
    fireEvent.change(within(dialog).getByLabelText(/Laboratory name/), { target: { value: 'Target Laboratory' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Copy configuration' }))

    await waitFor(() => expect(clone).toHaveBeenCalledTimes(1))
    expect(clone).toHaveBeenCalledWith('SOURCE', expect.objectContaining({
      code: 'TARGET', name: 'Target Laboratory', country: 'India',
      admin_unit_id: 'IND:2:10', admin_path: 'IND/1/10', site_group: 'Human health'
    }))
    expect(save).not.toHaveBeenCalled()
    expect(onChanged).toHaveBeenCalledTimes(1)
  })

  /**
   * The form asks for what is on the letterhead and nothing else.
   *
   * It used to carry one dropdown per administrative level — "State / UT" then "District"
   * in India — directly above an address block that asked for the state a second time. Two
   * controls for one fact is how a laboratory ends up filed under one state and addressed
   * in another, and neither is a question a clerk with an envelope can answer.
   */
  it('asks for the address only, not for the administrative hierarchy', async () => {
    render(view())
    fireEvent.click(screen.getByRole('button', { name: /add laboratory/i }))
    const dialog = screen.getByRole('dialog', { name: 'Add laboratory' })
    await waitFor(() => expect(within(dialog).getByLabelText(/pin/i)).toBeInTheDocument())
    expect(within(dialog).queryByLabelText('State / UT')).not.toBeInTheDocument()
    expect(within(dialog).queryByLabelText('District')).not.toBeInTheDocument()
    // Nor the address's own administrative-area field: it is resolved from the postal code.
    expect(within(dialog).queryByLabelText(/^state/i)).not.toBeInTheDocument()
    expect(within(dialog).queryByLabelText(/LGD/)).not.toBeInTheDocument()
  })

  it('stores the ISO code for the country the operator picks by name', async () => {
    render(view())
    fireEvent.click(screen.getByRole('button', { name: /add laboratory/i }))
    const dialog = screen.getByRole('dialog', { name: 'Add laboratory' })
    const country = await within(dialog).findByRole('combobox', { name: /^country$/i })
    fireEvent.change(country, { target: { value: 'Nepal' } })
    fireEvent.click(await within(dialog).findByRole('option', { name: /Nepal/ }))
    // The name is what was read; the alpha-3 is what a regional roll-up can group on.
    await waitFor(() => expect(within(dialog).getByLabelText(/ISO country code/i)).toHaveValue('NPL'))
  })

  /**
   * A national programme runs under one country profile, but the laboratories it registers
   * can be anywhere. Every geographic lookup on this screen used to be asked of the
   * deployment's country, so choosing the United States and typing a ZIP code asked India's
   * directory for a six-digit PIN — and was told, correctly and uselessly, that the code was
   * "not in the bundled directory for IND".
   */
  it('asks the chosen country\'s directory, not the deployment\'s', async () => {
    render(view())
    fireEvent.click(screen.getByRole('button', { name: /add laboratory/i }))
    const dialog = screen.getByRole('dialog', { name: 'Add laboratory' })
    const country = await within(dialog).findByRole('combobox', { name: /^Country/i })
    fireEvent.change(country, { target: { value: 'United States' } })
    fireEvent.click(await within(dialog).findByRole('option', { name: /United States/ }))

    // The address pack is re-fetched for the new country…
    await waitFor(() => expect(window.amrit.addressFormat).toHaveBeenCalledWith('USA'))
    // …and so is the postal lookup, with the ZIP the operator actually typed.
    fireEvent.change(within(dialog).getByLabelText(/^(zip|postal|pin)/i), { target: { value: '14850' } })
    await waitFor(() => expect(window.amrit.geo.postalCode).toHaveBeenCalledWith('USA', '14850', expect.anything()), { timeout: 2000 })
  })

  it('keeps a directory suburb printable without storing a field the country does not use', async () => {
    vi.mocked(window.amrit.geo.postalCode).mockResolvedValueOnce({
      available: true,
      point: { latitude: 9.9658, longitude: 76.2421, precision: 'postal_area', source: 'geonames-postal' },
      candidates: [{
        locality: 'Kochi', admin_area: 'Kerala', dependent_locality: 'Fort Kochi', postal_code: '682011',
        latitude: 9.9658, longitude: 76.2421, precision: 'postal_area', source: 'geonames-postal'
      }],
      postalCodeUnknown: false,
      countryHasNoPostalDirectory: false
    })
    render(view())
    fireEvent.click(screen.getByRole('button', { name: /add laboratory/i }))
    const dialog = screen.getByRole('dialog', { name: 'Add laboratory' })

    fireEvent.change(await within(dialog).findByRole('textbox', { name: /^street address/i }), { target: { value: '12 Hospital Road' } })
    fireEvent.change(within(dialog).getByLabelText(/pin/i), { target: { value: '682011' } })
    const suggestion = await within(dialog).findByRole('button', { name: /Kochi.*Fort Kochi.*Kerala/i }, { timeout: 2000 })
    fireEvent.click(suggestion)

    await waitFor(() => expect(within(dialog).getByRole('textbox', { name: /^street address/i })).toHaveValue('12 Hospital Road\nFort Kochi'))
    expect(within(dialog).queryByText(/Suburb is not part of an address/i)).not.toBeInTheDocument()
  })

  it('automatically repairs an existing hidden suburb by moving it to the street address', async () => {
    const legacy: Laboratory = {
      ...source,
      address: { ...source.address!, dependent_locality: 'Fort Kochi' }
    }
    render(
      <ToastProvider>
        <LaboratoriesPage laboratories={[legacy]} currentLab={legacy} countryProfile={indiaProfile} onChanged={onChanged} />
      </ToastProvider>
    )
    fireEvent.click(screen.getByRole('button', { name: /edit/i }))
    const dialog = screen.getByRole('dialog', { name: 'Edit laboratory' })

    await waitFor(() => expect(within(dialog).getByRole('textbox', { name: /^street address/i })).toHaveValue('12 Hospital Road\nFort Kochi'))
    expect(within(dialog).queryByText(/Suburb is not part of an address/i)).not.toBeInTheDocument()
  })

  it('loads the selected country reporting hierarchy instead of reusing the deployment country', async () => {
    const reportingUnits = vi.mocked(window.amrit.geo.reportingUnits)
    render(view())
    fireEvent.click(screen.getByRole('button', { name: /add laboratory/i }))
    const dialog = screen.getByRole('dialog', { name: 'Add laboratory' })
    const country = await within(dialog).findByRole('combobox', { name: /^Country/i })
    fireEvent.change(country, { target: { value: 'United States' } })
    fireEvent.click(await within(dialog).findByRole('option', { name: /United States/ }))

    await waitFor(() => expect(reportingUnits).toHaveBeenCalledWith('USA'))
  })

  /**
   * Clearing the country used to undo itself: the box emptied, a fallback refilled it from
   * the deployment profile, and the operator watched their own deletion reverse.
   */
  it('lets the country be cleared and leaves it cleared', async () => {
    render(view())
    fireEvent.click(screen.getByRole('button', { name: /edit/i }))
    const dialog = screen.getByRole('dialog', { name: 'Edit laboratory' })
    const country = await within(dialog).findByRole('combobox', { name: /^Country/i })
    expect(country).toHaveValue('India')

    fireEvent.click(within(dialog).getByRole('button', { name: /Clear Country/i }))
    await waitFor(() => expect(country).toHaveValue(''))
    // Still empty a tick later — nothing repopulates it behind the operator's back.
    await new Promise((done) => setTimeout(done, 50))
    expect(country).toHaveValue('')
    expect(within(dialog).getByLabelText(/ISO country code/i)).toHaveValue('')
  })

  it('refuses to save a laboratory with no country', async () => {
    render(view())
    fireEvent.click(screen.getByRole('button', { name: /edit/i }))
    const dialog = screen.getByRole('dialog', { name: 'Edit laboratory' })
    await within(dialog).findByRole('combobox', { name: /^Country/i })
    fireEvent.click(within(dialog).getByRole('button', { name: /Clear Country/i }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save laboratory' }))
    // Two things object, which is correct: the toast, and the address validator that also
    // needs a country to check the postal code against.
    expect(await screen.findByText('Country is required')).toBeInTheDocument()
    expect(save).not.toHaveBeenCalled()
  })

  it('derives the reporting unit from the address and says which one it chose', async () => {
    render(view())
    fireEvent.click(screen.getByRole('button', { name: /edit/i }))
    const dialog = screen.getByRole('dialog', { name: 'Edit laboratory' })
    // The source laboratory's address names Ernakulam, which is a level-2 unit in the tree.
    await waitFor(() => expect(within(dialog).getByText(/Reports under Ernakulam/)).toBeInTheDocument())
  })

  it('renders the address form from the country pack, using that country\'s own field names', async () => {
    render(view())
    fireEvent.click(screen.getByRole('button', { name: /add laboratory/i }))
    const dialog = screen.getByRole('dialog', { name: 'Add laboratory' })
    // India calls its postal code a PIN and its level-1 area a state; both come from the
    // pack, not from this application.
    await waitFor(() => expect(within(dialog).getByLabelText(/pin/i)).toBeInTheDocument())
    expect(within(dialog).getByLabelText(/^city/i)).toBeInTheDocument()
    // Nothing asks for a field India's address format does not place.
    expect(within(dialog).queryByLabelText(/sorting code/i)).not.toBeInTheDocument()
    expect(within(dialog).queryByLabelText(/suburb/i)).not.toBeInTheDocument()
  })

  it('asks no administrative levels under another country either', async () => {
    render(
      <ToastProvider>
        <LaboratoriesPage laboratories={[source]} currentLab={source} countryProfile={testlandProfile} onChanged={onChanged} />
      </ToastProvider>
    )
    fireEvent.click(screen.getByRole('button', { name: /add laboratory/i }))
    const dialog = screen.getByRole('dialog', { name: 'Add laboratory' })
    await waitFor(() => expect(within(dialog).getByLabelText(/^Laboratory code/)).toBeInTheDocument())
    // A three-level country used to render three selects here. It now renders none, and
    // nothing India-specific survives under another profile either.
    for (const label of ['\u0645\u062d\u0627\u0641\u0638\u0629', '\u0642\u0636\u0627\u0621', '\u0646\u0627\u062d\u064a\u0629', 'State / UT', 'District']) {
      expect(within(dialog).queryByLabelText(label)).not.toBeInTheDocument()
    }
  })
})
