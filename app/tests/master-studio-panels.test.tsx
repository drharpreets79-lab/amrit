import type React from 'react'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ToastProvider } from '../src/renderer/components/Toast'
import { indiaProfile } from './helpers/profile'
import { MasterStudioPage } from '../src/renderer/pages/MasterStudioPage'
import type { AMRITApi } from '../src/shared/api'
import type { Laboratory, MasterDefinition, MasterKind, Row } from '../src/shared/types'

const lab: Laboratory = { code: 'HARP', name: 'Harpreet' }

/** Mirrors the `panels` master definition served by the database layer. */
const panelDefinition: MasterDefinition = {
  kind: 'panels', title: 'AST panels', purpose: 'Code-first organism/specimen panels.',
  table: 'lab_panels', key: 'id', labScoped: true, autoKey: true,
  columns: [
    { key: 'id', label: 'ID', type: 'number' },
    { key: 'panel_name', label: 'Panel name', type: 'text', required: true },
    { key: 'description', label: 'Description', type: 'textarea' },
    { key: 'priority', label: 'Priority', type: 'number' },
    { key: 'no_routine_ast', label: 'No routine AST', type: 'boolean' },
    { key: 'active', label: 'Active', type: 'boolean' },
    { key: 'organisms', label: 'Organisms', type: 'multiselect', optionSource: 'organisms' },
    { key: 'specimens', label: 'Specimens', type: 'multiselect', optionSource: 'samples' },
    { key: 'antibiotics', label: 'Antibiotics', type: 'panelAntibiotics', optionSource: 'antibiotics' },
    {
      key: 'guidance', label: 'Testing guidance', type: 'objectList', itemLabel: 'guidance note',
      fields: [
        { key: 'notes', label: 'Guidance note', type: 'textarea' },
        { key: 'requirement_type', label: 'Applies to', type: 'select', options: [{ value: 'surrogate_selection', label: 'Surrogate selection' }, { value: 'general', label: 'General note' }] },
        { key: 'source_clause', label: 'Source clause', type: 'textarea', readonly: true }
      ]
    },
    { key: 'metadata_json', label: 'Metadata', type: 'keyValue' }
  ]
}

const existingPanel: Row = {
  id: 81, panel_name: 'Escherichia coli — Urine AST', priority: 1, active: true, no_routine_ast: false,
  organisms: [{ code: 'ECO', name: 'Escherichia coli' }],
  specimens: [{ code: 'URINE', name: 'Urine' }],
  antibiotics: [
    { code: 'AMP', name: 'Ampicillin', sort_order: 10, requirement_type: 'core', option_group: '' },
    { code: 'FOS', name: 'Fosfomycin', sort_order: 20, requirement_type: 'conditional', option_group: '' }
  ],
  guidance: [{ notes: 'A validated urinary cephalosporin is permitted.', requirement_type: 'surrogate_selection', sort_order: 30, source_clause: 'cefazolin or an oral cephalosporin surrogate' }],
  metadata_json: { iso2: 'IN', who_region: 'SEARO' }
}

const catalogues: Partial<Record<MasterKind, Row[]>> = {
  panels: [existingPanel],
  antibiotics: [
    { code: 'AMP', name: 'Ampicillin', class_name: 'Penicillins' },
    { code: 'FOS', name: 'Fosfomycin', class_name: 'Phosphonics' },
    { code: 'MEM', name: 'Meropenem', class_name: 'Carbapenems' }
  ],
  organisms: [{ code: 'ECO', organism_name: 'Escherichia coli' }, { code: 'KPN', organism_name: 'Klebsiella pneumoniae' }],
  samples: [{ code: 'URINE', name: 'Urine' }, { code: 'BLOOD', name: 'Blood' }]
}

describe('MasterStudioPage AST panel editing', () => {
  const save = vi.fn<(kind: MasterKind, row: Row, labCode?: string) => Promise<Row>>()
  const onChanged = vi.fn<() => Promise<void>>()

  beforeEach(() => {
    vi.clearAllMocks()
    save.mockImplementation(async (_kind, row) => row)
    onChanged.mockResolvedValue()
    const api = {
      masters: {
        list: vi.fn(async (kind: MasterKind) => catalogues[kind] ?? []),
        save, delete: vi.fn(), toggle: vi.fn()
      }
    } as unknown as AMRITApi
    Object.defineProperty(window, 'amrit', { configurable: true, value: api })
  })

  function view(): React.JSX.Element {
    return <ToastProvider><MasterStudioPage countryProfile={indiaProfile} definitions={[panelDefinition]} currentLab={lab} onChanged={onChanged} /></ToastProvider>
  }

  const openEditor = async (): Promise<HTMLElement> => {
    render(view())
    fireEvent.click(await screen.findByRole('button', { name: /^Edit/ }))
    return screen.getByRole('dialog', { name: /AST panels/ })
  }
  /** The editor is sectioned, so a field is only in the DOM while its section is open. */
  const section = (dialog: HTMLElement, label: string): void => {
    fireEvent.click(within(dialog).getByRole('button', { name: new RegExp(`^${label}`) }))
  }

  it('gives each membership its own section instead of one long form', async () => {
    const dialog = await openEditor()
    await waitFor(() => expect(within(dialog).getByLabelText(/^Panel name/)).toBeInTheDocument())

    // The rail advertises what each section holds before it is opened.
    expect(within(dialog).getByRole('button', { name: /^Organisms 1 selected/ })).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: /^Antibiotics 2 selected/ })).toBeInTheDocument()
    // Only the open section is mounted, so the form stays short.
    expect(within(dialog).queryByRole('button', { name: 'Remove Escherichia coli' })).not.toBeInTheDocument()

    section(dialog, 'Organisms')
    expect(within(dialog).getByRole('button', { name: 'Remove Escherichia coli' })).toBeInTheDocument()
    section(dialog, 'Specimens')
    expect(within(dialog).getByRole('button', { name: 'Remove Urine' })).toBeInTheDocument()
    section(dialog, 'Antibiotics')
    expect(within(dialog).getByRole('button', { name: 'Remove Ampicillin' })).toBeInTheDocument()
    expect(within(dialog).getByText('1 essential')).toBeInTheDocument()
    expect(within(dialog).getByText('1 optional')).toBeInTheDocument()
  })

  it('saves structured members with their requirement type after a multi-select change', async () => {
    const dialog = await openEditor()
    section(dialog, 'Organisms')
    await waitFor(() => expect(within(dialog).getByRole('button', { name: /^Klebsiella pneumoniae/ })).toBeInTheDocument())

    fireEvent.click(within(dialog).getByRole('button', { name: /^Klebsiella pneumoniae/ }))
    section(dialog, 'Antibiotics')
    fireEvent.click(within(dialog).getByRole('button', { name: /^Meropenem/ }))
    fireEvent.change(within(dialog).getByLabelText('MEM requirement type'), { target: { value: 'optional' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save entry' }))

    await waitFor(() => expect(save).toHaveBeenCalledTimes(1))
    const [kind, row, labCode] = save.mock.calls[0]!
    expect(kind).toBe('panels')
    expect(labCode).toBe('HARP')
    expect(row.organisms).toEqual([{ code: 'ECO', name: 'Escherichia coli' }, { code: 'KPN', name: 'Klebsiella pneumoniae' }])
    expect(row.antibiotics).toEqual([
      expect.objectContaining({ code: 'AMP', requirement_type: 'core', sort_order: 10 }),
      expect.objectContaining({ code: 'FOS', requirement_type: 'conditional', sort_order: 20 }),
      expect.objectContaining({ code: 'MEM', requirement_type: 'optional', sort_order: 30 })
    ])
  })

  it('shows no raw JSON anywhere in the panel editor', async () => {
    const dialog = await openEditor()
    await waitFor(() => expect(within(dialog).getByLabelText(/^Panel name/)).toBeInTheDocument())

    for (const label of ['Details', 'Organisms', 'Specimens', 'Antibiotics', 'Testing guidance', 'Metadata']) {
      section(dialog, label)
      for (const node of Array.from(dialog.querySelectorAll('textarea'))) {
        expect(node.value.trim().startsWith('[') || node.value.trim().startsWith('{')).toBe(false)
      }
      expect(dialog.querySelectorAll('pre')).toHaveLength(0)
    }

    // Guidance and metadata are labelled fields, not blobs.
    section(dialog, 'Testing guidance')
    expect(within(dialog).getByLabelText('Guidance note')).toHaveValue('A validated urinary cephalosporin is permitted.')
    expect(within(dialog).getByLabelText('Applies to')).toHaveValue('surrogate_selection')
    expect(within(dialog).getByLabelText('Source clause')).toBeDisabled()
    section(dialog, 'Metadata')
    expect(within(dialog).getAllByLabelText('Property').map((node) => (node as HTMLInputElement).value)).toEqual(['iso2', 'who_region'])
    expect(within(dialog).getAllByLabelText('Value').map((node) => (node as HTMLInputElement).value)).toEqual(['IN', 'SEARO'])
  })

  it('saves edited guidance and metadata as structured values', async () => {
    const dialog = await openEditor()
    section(dialog, 'Testing guidance')
    await waitFor(() => expect(within(dialog).getByLabelText('Guidance note')).toBeInTheDocument())

    fireEvent.change(within(dialog).getByLabelText('Guidance note'), { target: { value: 'Report nitrofurantoin for lower UTI only.' } })
    fireEvent.change(within(dialog).getByLabelText('Applies to'), { target: { value: 'general' } })
    section(dialog, 'Metadata')
    fireEvent.change(within(dialog).getAllByLabelText('Value')[1]!, { target: { value: 'EMRO' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save entry' }))

    await waitFor(() => expect(save).toHaveBeenCalledTimes(1))
    const row = save.mock.calls[0]![1]
    expect(row.guidance).toEqual([expect.objectContaining({
      notes: 'Report nitrofurantoin for lower UTI only.',
      requirement_type: 'general',
      // Provenance outside the declared fields survives the edit.
      source_clause: 'cefazolin or an oral cephalosporin surrogate',
      sort_order: 30
    })])
    expect(row.metadata_json).toEqual({ iso2: 'IN', who_region: 'EMRO' })
  })

  it('duplicates an existing panel as the starting point for a new one', async () => {
    render(view())
    fireEvent.click(await screen.findByRole('button', { name: /^Duplicate/ }))
    const dialog = screen.getByRole('dialog', { name: /Add AST panels/ })

    expect(within(dialog).getByLabelText(/^Panel name/)).toHaveValue('Escherichia coli — Urine AST (copy)')
    section(dialog, 'Antibiotics')
    expect(within(dialog).getByRole('button', { name: 'Remove Ampicillin' })).toBeInTheDocument()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save entry' }))

    await waitFor(() => expect(save).toHaveBeenCalledTimes(1))
    const row = save.mock.calls[0]![1]
    // A copy must not carry the source row's database key.
    expect(row.id).toBeUndefined()
    expect(row.antibiotics).toHaveLength(2)
  })

  it('hides the database-assigned key and pre-fills the next priority', async () => {
    render(view())
    const add = await screen.findByRole('button', { name: /^Add AST panel/ })
    await waitFor(() => expect(add).toBeEnabled())
    fireEvent.click(add)
    const dialog = screen.getByRole('dialog', { name: /Add AST panels/ })

    expect(within(dialog).queryByLabelText('ID')).not.toBeInTheDocument()
    expect(within(dialog).getByLabelText('Priority')).toHaveValue(2)
    expect(within(dialog).getByRole('button', { name: 'Save & add another' })).toBeInTheDocument()
  })

  it('adds pasted antibiotic codes in one step and names the ones it cannot resolve', async () => {
    const dialog = await openEditor()
    section(dialog, 'Antibiotics')
    await waitFor(() => expect(within(dialog).getByLabelText('Search antibiotics')).toBeInTheDocument())

    fireEvent.change(within(dialog).getByLabelText('Search antibiotics'), { target: { value: 'MEM, ZZZ' } })
    fireEvent.keyDown(within(dialog).getByLabelText('Search antibiotics'), { key: 'Enter' })

    expect(within(dialog).getByRole('button', { name: 'Remove Meropenem' })).toBeInTheDocument()
    expect(within(dialog).getByText(/Not in the catalogue: ZZZ/)).toBeInTheDocument()
  })

  it('warns when another active panel already covers the same organism and specimen', async () => {
    render(view())
    const add = await screen.findByRole('button', { name: /^Add AST panel/ })
    await waitFor(() => expect(add).toBeEnabled())
    fireEvent.click(add)
    const dialog = screen.getByRole('dialog', { name: /Add AST panels/ })
    section(dialog, 'Organisms')
    await waitFor(() => expect(within(dialog).getByRole('button', { name: /^Escherichia coli/ })).toBeInTheDocument())

    fireEvent.click(within(dialog).getByRole('button', { name: /^Escherichia coli/ }))
    section(dialog, 'Specimens')
    fireEvent.click(within(dialog).getByRole('button', { name: /^Urine/ }))

    expect(await within(dialog).findByText(/Escherichia coli — Urine AST/)).toBeInTheDocument()
    expect(within(dialog).getByText(/1 existing entry covers this combination/)).toBeInTheDocument()
  })

  it('removes a member through its chip', async () => {
    const dialog = await openEditor()
    section(dialog, 'Antibiotics')
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Remove Fosfomycin' })).toBeInTheDocument())

    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove Fosfomycin' }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save entry' }))

    await waitFor(() => expect(save).toHaveBeenCalledTimes(1))
    expect(save.mock.calls[0]![1].antibiotics).toEqual([expect.objectContaining({ code: 'AMP', requirement_type: 'core' })])
  })
})
