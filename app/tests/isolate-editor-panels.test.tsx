import type React from 'react'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { IsolateEditor, type EditorMasters } from '../src/renderer/components/IsolateEditor'
import { ToastProvider } from '../src/renderer/components/Toast'
import type { AMRITApi } from '../src/shared/api'
import type { CountryAddressFormat } from '../src/shared/address'
import type { IsolateRecord, Row } from '../src/shared/types'

/** India's entry from the bundled pack, trimmed to what the residence form reads. */
const addressFormatFixture: CountryAddressFormat = {
  alpha2: 'IN',
  format: '%N%n%O%n%A%n%C %Z%n%S',
  latin_format: null,
  fields: ['recipient', 'organization', 'address_lines', 'locality', 'admin_area', 'postal_code'],
  required: ['address_lines', 'locality', 'admin_area', 'postal_code'],
  uppercase: ['locality'],
  labels: { admin_area: 'state', locality: 'city', dependent_locality: 'suburb', postal_code: 'pin' },
  postal_code_pattern: '\\d{6}',
  postal_code_examples: ['110034', '110001'],
  postal_code_prefix: null,
  language: 'en',
  languages: ['en', 'hi'],
  postal_authority_url: null,
  admin_area_iso_codes: []
}

const PANEL: Row = {
  id: 81,
  panel_name: 'Escherichia coli — Urine AST',
  description: 'Urine – uncomplicated lower UTI.',
  organisms: [{ code: 'ECO', name: 'Escherichia coli' }],
  specimens: [{ code: 'URINE', name: 'Urine' }],
  antibiotics: [
    { code: 'AMP', name: 'Ampicillin', sort_order: 10, requirement_type: 'core', option_group: '' },
    { code: 'CZO', name: 'Cefazolin', sort_order: 20, requirement_type: 'one_of', option_group: 'urinary:choice:02' },
    { code: 'FOS', name: 'Fosfomycin', sort_order: 30, requirement_type: 'conditional', option_group: '' },
    { code: 'GEN', name: 'Gentamicin', sort_order: 40, requirement_type: 'synergy', option_group: '' }
  ],
  genomic_markers: [
    { code: 'BLANDM', name: 'blaNDM (New Delhi metallo-β-lactamase)', requirement_type: 'core', sort_order: 10 },
    { code: 'MCR', name: 'mcr-1 to mcr-10', requirement_type: 'optional', sort_order: 20 }
  ]
}

const masters: EditorMasters = {
  antibiotics: [
    { code: 'AMP', name: 'Ampicillin', class_name: 'Penicillins' },
    { code: 'CZO', name: 'Cefazolin', class_name: 'Cephalosporins' },
    { code: 'FOS', name: 'Fosfomycin', class_name: 'Phosphonics' },
    { code: 'GEN', name: 'Gentamicin', class_name: 'Aminoglycosides' },
    { code: 'MEM', name: 'Meropenem', class_name: 'Carbapenems' }
  ],
  organisms: [{ code: 'ECO', organism_name: 'Escherichia coli' }],
  samples: [{ code: 'URINE', name: 'Urine' }],
  locations: [], domains: [], hospitals: [], dataFields: [],
  codeValues: [
    { code_set: 'diagnosis', code: 'N39.0', description: 'Urinary tract infection, site not specified', display_label: 'N39.0 — Urinary tract infection, site not specified', metadata_json: '{"system":"http://hl7.org/fhir/sid/icd-10","system_label":"ICD-10"}' },
    { code_set: 'diagnosis', code: 'A41', description: 'Other sepsis', display_label: 'A41 — Other sepsis', metadata_json: '{"system":"http://hl7.org/fhir/sid/icd-10","system_label":"ICD-10"}' },
    { code_set: 'sex_category', code: 'f', description: 'Female', display_label: 'f - Female' },
    { code_set: 'sex_category', code: 'm', description: 'Male', display_label: 'm - Male' }
  ],
  genomicMarkers: [
    { code: 'BLANDM', name: 'blaNDM (New Delhi metallo-β-lactamase)', mechanism_class: 'Carbapenemase', marker_type: 'gene', default_method: 'PCR' },
    { code: 'BLAOXA48', name: 'blaOXA-48-like', mechanism_class: 'Carbapenemase', marker_type: 'gene', default_method: 'PCR' },
    { code: 'MCR', name: 'mcr-1 to mcr-10', mechanism_class: 'Colistin resistance', marker_type: 'gene', default_method: 'PCR' }
  ]
}

describe('IsolateEditor panel-driven AST entry', () => {
  const match = vi.fn<(context: Record<string, unknown>) => Promise<Row[]>>()
  const onSave = vi.fn<() => Promise<void>>()

  beforeEach(() => {
    vi.clearAllMocks()
    match.mockResolvedValue([PANEL])
    onSave.mockResolvedValue()
    const api = {
      panels: { match },
      records: { duplicate: vi.fn(async () => null) },
      // The residence form asks the main process for the country's address rules.
      addressFormat: vi.fn(async () => addressFormatFixture)
    } as unknown as AMRITApi
    Object.defineProperty(window, 'amrit', { configurable: true, value: api })
  })

  function view(): React.JSX.Element {
    return <ToastProvider><IsolateEditor labCode="HARP" countryCode="IND" masters={masters} defaultMethod="Gradient strip" defaultGuideline="EUCAST" onSave={onSave} onCancel={vi.fn()} /></ToastProvider>
  }

  // Every coded field is a searchable combobox: an input the operator types into to filter,
  // which stores the code and displays the catalogue's wording. Typing text that is exactly a
  // catalogue code commits it, which is what these tests use to choose a value.
  const combo = (name: string): HTMLInputElement => screen.getByRole('combobox', { name: new RegExp(`^${name}`) }) as HTMLInputElement
  const chooseContext = async (): Promise<void> => {
    fireEvent.change(combo('Specimen type'), { target: { value: 'URINE' } })
    fireEvent.change(combo('Organism'), { target: { value: 'ECO' } })
    await waitFor(() => expect(match).toHaveBeenCalled())
  }

  it('sends only defined context to the panel matcher', async () => {
    render(view())
    await chooseContext()
    const context = match.mock.calls.at(-1)?.[0] ?? {}
    expect(context).toMatchObject({ labCode: 'HARP', organismCode: 'ECO', specimenCode: 'URINE' })
    expect(Object.values(context).every((value) => value !== undefined && value !== '')).toBe(true)
    expect('locationType' in context).toBe(false)
    expect('domain' in context).toBe(false)
  })

  it('pre-loads only essential panel members and offers the optional ones as add-ons', async () => {
    render(view())
    await chooseContext()
    await screen.findByLabelText('AMP measurement')

    expect(screen.getByLabelText('AMP measurement')).toBeInTheDocument()
    expect(screen.getByLabelText('CZO measurement')).toBeInTheDocument()
    expect(screen.queryByLabelText('FOS measurement')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('GEN measurement')).not.toBeInTheDocument()

    const optional = screen.getByText('Optional antibiotics in this panel').parentElement as HTMLElement
    fireEvent.click(within(optional).getByRole('button', { name: /Fosfomycin/ }))
    expect(await screen.findByLabelText('FOS measurement')).toBeInTheDocument()
    expect(screen.queryByLabelText('GEN measurement')).not.toBeInTheDocument()
  })

  it('defaults new results to the laboratory test method and applies a method change to every row', async () => {
    render(view())
    await chooseContext()
    await screen.findByLabelText('AMP measurement')

    // The laboratory default reaches the row selects and the measurement placeholder. The
    // dropdown shows the catalogue's wording; what it stores is the code, asserted on save.
    expect(screen.getByLabelText('AMP measurement')).toHaveAttribute('placeholder', 'MIC mg/L')
    expect(combo('Test method')).toHaveValue('E-test / gradient strip (MIC, mg/L)')

    fireEvent.change(screen.getByRole('textbox', { name: /^Specimen number/ }), { target: { value: 'S-1' } })
    fireEvent.change(screen.getByLabelText('AMP measurement'), { target: { value: '0.5' } })
    fireEvent.change(combo('Test method'), { target: { value: 'Disk diffusion' } })
    await waitFor(() => expect(screen.getByLabelText('AMP measurement')).toHaveAttribute('placeholder', 'Zone mm'))

    fireEvent.click(screen.getByRole('button', { name: /Save draft/i }))
    await waitFor(() => expect(onSave).toHaveBeenCalled())
    const saved = (onSave.mock.calls[0] as unknown as [IsolateRecord])[0]
    expect(saved.ast_method).toBe('Disk diffusion')
    expect(saved.antibiotic_results?.AMP).toMatchObject({ method: 'Disk diffusion', guideline: 'EUCAST' })
  })

  it('keeps essential members when the picker adds an antibiotic outside the panel', async () => {
    render(view())
    await chooseContext()
    await screen.findByLabelText('AMP measurement')

    fireEvent.click(screen.getByRole('button', { name: /Add antibiotics/i }))
    const dialog = screen.getByRole('dialog', { name: 'Add antibiotics to this record' })
    // Essential members are managed by the panel and are not offered for removal here.
    expect(within(dialog).queryByRole('button', { name: /^Ampicillin/ })).not.toBeInTheDocument()
    fireEvent.click(within(dialog).getByRole('button', { name: /^Meropenem/ }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Apply selection' }))

    expect(await screen.findByLabelText('MEM measurement')).toBeInTheDocument()
    expect(screen.getByLabelText('AMP measurement')).toBeInTheDocument()
  })

  it('surfaces a panel-matching failure instead of silently showing no panel', async () => {
    match.mockRejectedValue(new Error("Error invoking remote method 'panels:match': locationType: Invalid input"))
    render(view())
    await chooseContext()
    expect(await screen.findByText(/locationType: Invalid input/)).toBeInTheDocument()
  })

  /**
   * Diagnosis was a free-text box beside a free-text "diagnosis code", which is unanalysable
   * by construction: "UTI", "uti" and "urinary tract infection" are three strings and one
   * syndrome. It is now a catalogue selection, and multiple because one isolate genuinely
   * carries more than one — a urinary source and a sepsis.
   */
  it('records diagnosis as codes from the catalogue, with the code system', async () => {
    render(view())
    await chooseContext()
    fireEvent.change(screen.getByRole('textbox', { name: /^Specimen number/ }), { target: { value: 'S-9' } })

    const search = screen.getByLabelText(/Search diagnosis/i)
    fireEvent.change(search, { target: { value: 'urinary' } })
    fireEvent.click(await screen.findByRole('button', { name: /Urinary tract infection/ }))
    fireEvent.change(search, { target: { value: 'A41' } })
    fireEvent.keyDown(search, { key: 'Enter' })

    fireEvent.click(screen.getByRole('button', { name: /Save draft/i }))
    await waitFor(() => expect(onSave).toHaveBeenCalled())
    const saved = (onSave.mock.calls[0] as unknown as [IsolateRecord])[0]
    expect(saved.diagnosis_code).toBe('N39.0, A41')
    // The text is regenerated from the catalogue, so a code and its label cannot disagree.
    expect(saved.diagnosis).toContain('Urinary tract infection')
    expect(saved.diagnosis_system).toBe('http://hl7.org/fhir/sid/icd-10')
  })

  it('offers sex from the configured catalogue rather than three hard-coded letters', async () => {
    render(view())
    // The seeded set carries the veterinary categories a One Health deployment needs.
    const sex = await screen.findByRole('combobox', { name: /^Sex/ })
    fireEvent.focus(sex)
    expect(await screen.findByRole('option', { name: /Female/ })).toBeInTheDocument()
  })

  it('flags an age that contradicts the date of birth instead of storing both', async () => {
    render(view())
    fireEvent.change(screen.getByLabelText('Date of birth'), { target: { value: '1990-01-01' } })
    fireEvent.change(screen.getByLabelText('Age in years'), { target: { value: '4' } })
    expect(await screen.findByText(/Age and date of birth disagree/i)).toBeInTheDocument()
  })

  it('refuses an admission date later than the specimen it produced', async () => {
    render(view())
    fireEvent.change(screen.getByLabelText(/^Specimen date/), { target: { value: '2026-03-01' } })
    fireEvent.change(screen.getByLabelText('Admission date'), { target: { value: '2026-03-05' } })
    expect(await screen.findByText(/Admission cannot be after the specimen/i)).toBeInTheDocument()
  })

  /**
   * A panel that prescribes a carbapenemase PCR alongside its disks used to describe itself
   * purely in antibiotics, so the marker arrived unannounced further down the form — and an
   * optional one was never noticed at all.
   */
  it('counts the panel\'s genomic markers in its summary and pre-loads the essential ones', async () => {
    render(view())
    await chooseContext()
    await screen.findByLabelText('AMP measurement')

    expect(screen.getByRole('combobox', { name: /Matched AST panel/ })).toBeInTheDocument()
    expect(screen.getByText(/2 genomic markers/)).toBeInTheDocument()
    // Essential markers are in the record; the optional one is offered rather than assumed.
    expect(screen.getByLabelText('BLANDM result')).toBeInTheDocument()
    expect(screen.queryByLabelText('MCR result')).not.toBeInTheDocument()
    const optional = screen.getByText('Optional markers in this panel').parentElement as HTMLElement
    fireEvent.click(within(optional).getByRole('button', { name: /mcr-1/ }))
    expect(await screen.findByLabelText('MCR result')).toBeInTheDocument()
  })

  /**
   * The gap this closes: a clerk could record a patient's ward but not their postal code,
   * the one sub-city geography almost every country has. The form is built from the
   * country's own rules, so the field is called what the country calls it.
   */
  it('offers the residence fields this country uses, under this country\'s names', async () => {
    render(view())
    // The pack's token is `pin`; the catalogue turns it into the words a form should use.
    // Asserting the token here is what let "pin" ship as a visible field label.
    expect(await screen.findByLabelText(/^PIN code/)).toBeInTheDocument()
    expect(screen.getByLabelText(/^City/)).toBeInTheDocument()
    expect(screen.getByLabelText(/^State/)).toBeInTheDocument()
    // A street line is not offered at all: patient addresses stop at the town.
    expect(screen.queryByLabelText(/street|address line/i)).not.toBeInTheDocument()
  })

  it('shows the country\'s example code, and refuses one that does not fit the pattern', async () => {
    render(view())
    const postal = await screen.findByLabelText(/^PIN code/)
    // Two examples, comma separated. The pack used to return them as one glued string.
    expect(screen.getByText(/For example 110034, 110001/)).toBeInTheDocument()
    fireEvent.change(postal, { target: { value: 'NOT-A-PIN' } })
    expect(await screen.findByText(/does not match the format used in this country/)).toBeInTheDocument()
    fireEvent.change(postal, { target: { value: '682011' } })
    await waitFor(() => expect(screen.queryByText(/does not match the format/)).not.toBeInTheDocument())
  })
})
