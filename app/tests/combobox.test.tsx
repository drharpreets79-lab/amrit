import type React from 'react'
import { useState } from 'react'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { Combobox, CustomSelect, DateInput, type MultiOption } from '../src/renderer/components/ui'

/**
 * Every coded field in the application is this control. The catalogues behind it run to
 * thousands of entries — 2,380 organisms, 399 antimicrobials, 252 countries — so what is
 * pinned here is that a person can find an entry by typing part of it, and that what gets
 * stored is the standard code rather than the words on screen.
 */

const ORGANISMS: MultiOption[] = [
  { value: 'ECO', label: 'Escherichia coli', hint: 'Enterobacterales' },
  { value: 'SAU', label: 'Staphylococcus aureus', hint: 'Staphylococcus' },
  { value: 'KPN', label: 'Klebsiella pneumoniae', hint: 'Enterobacterales' },
  { value: 'PAE', label: 'Pseudomonas aeruginosa', hint: 'Pseudomonas' }
]

function Harness({ initial = '', allowCustom = false, onValue }: {
  initial?: string
  allowCustom?: boolean
  onValue?: (value: string) => void
}): React.JSX.Element {
  const [value, setValue] = useState(initial)
  const Control = allowCustom ? CustomSelect : Combobox
  return <>
    <Control label="Organism" name="organism" value={value} options={ORGANISMS}
      onChange={(next: string) => { setValue(next); onValue?.(next) }} />
    <output data-testid="stored">{value}</output>
  </>
}

const open = (): HTMLElement => {
  const input = screen.getByRole('combobox', { name: /^Organism/ })
  fireEvent.focus(input)
  return input
}

describe('Combobox', () => {
  it('filters the list as the operator types, on label and on code alike', () => {
    render(<Harness />)
    const input = open()
    expect(within(screen.getByRole('listbox')).getAllByRole('option')).toHaveLength(4)

    fireEvent.change(input, { target: { value: 'pneumo' } })
    expect(within(screen.getByRole('listbox')).getAllByRole('option').map((item) => item.textContent))
      .toEqual([expect.stringContaining('Klebsiella pneumoniae')])

    // A laboratory that works in codes should not have to remember the catalogue's spelling.
    fireEvent.change(input, { target: { value: 'PAE' } })
    expect(screen.getByTestId('stored')).toHaveTextContent('PAE')
  })

  it('also matches on the secondary text, so a genus finds its species', () => {
    render(<Harness />)
    fireEvent.change(open(), { target: { value: 'enterobacterales' } })
    expect(within(screen.getByRole('listbox')).getAllByRole('option')).toHaveLength(2)
  })

  it('stores the code and shows the label', () => {
    const onValue = vi.fn()
    render(<Harness onValue={onValue} />)
    fireEvent.change(open(), { target: { value: 'coli' } })
    fireEvent.click(screen.getByRole('option', { name: /Escherichia coli/ }))
    expect(onValue).toHaveBeenCalledWith('ECO')
    expect(screen.getByRole('combobox', { name: /^Organism/ })).toHaveValue('Escherichia coli')
    expect(screen.getByTestId('stored')).toHaveTextContent('ECO')
  })

  it('takes the highlighted entry on Enter and moves with the arrow keys', () => {
    render(<Harness />)
    const input = open()
    fireEvent.change(input, { target: { value: 'o' } })
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(screen.getByTestId('stored').textContent).toBeTruthy()
  })

  /**
   * The failure this prevents is silent data loss: a half-typed search that reverts on blur
   * is a nuisance, but a half-typed search *committed* on blur writes "Escher" into a coded
   * organism column and nothing downstream can tell it from a real code.
   */
  it('reverts an unfinished search on blur rather than storing it', () => {
    render(<Harness initial="ECO" />)
    const input = open()
    fireEvent.change(input, { target: { value: 'Escher' } })
    fireEvent.blur(input)
    expect(screen.getByTestId('stored')).toHaveTextContent('ECO')
    expect(input).toHaveValue('Escherichia coli')
  })

  it('keeps a value the catalogue no longer lists visible instead of blanking it', () => {
    // Catalogues are versioned; a deactivated code outlives the records referencing it.
    render(<Harness initial="RETIRED_CODE" />)
    expect(screen.getByRole('combobox', { name: /^Organism/ })).toHaveValue('RETIRED_CODE')
  })

  it('clears to empty when the operator dismisses the selection', () => {
    render(<Harness initial="ECO" />)
    fireEvent.click(screen.getByRole('button', { name: /Clear Organism/i }))
    expect(screen.getByTestId('stored')).toHaveTextContent('')
  })

  it('refuses text outside the catalogue unless the field allows it', () => {
    render(<Harness />)
    const input = open()
    fireEvent.change(input, { target: { value: 'Not a catalogued organism' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(screen.getByTestId('stored')).toHaveTextContent('')
  })

  it('keeps free text verbatim where the field is a CustomSelect', () => {
    // A laboratory must be able to record a value its coded list has not caught up with.
    render(<Harness allowCustom />)
    const input = open()
    fireEvent.change(input, { target: { value: 'Locally isolated sp.' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(screen.getByTestId('stored')).toHaveTextContent('Locally isolated sp.')
  })
})

describe('DateInput', () => {
  it('emits ISO dates and offers a calendar button', () => {
    const onChange = vi.fn()
    render(<DateInput label="Date of birth" name="dob" value="" onChange={onChange} max="2026-08-13" />)
    // The calendar button's own label names the field too, so match the input exactly.
    const field = screen.getByLabelText('Date of birth')
    expect(field).toHaveAttribute('type', 'date')
    expect(field).toHaveAttribute('max', '2026-08-13')
    fireEvent.change(field, { target: { value: '1984-02-29' } })
    expect(onChange).toHaveBeenCalledWith('1984-02-29')
    expect(screen.getByRole('button', { name: /Open the calendar/i })).toBeInTheDocument()
  })

  it('does not throw where the platform has no picker', () => {
    render(<DateInput label="Specimen date" name="specimen" value="2026-01-02" onChange={vi.fn()} />)
    expect(() => fireEvent.click(screen.getByRole('button', { name: /Open the calendar/i }))).not.toThrow()
  })
})
