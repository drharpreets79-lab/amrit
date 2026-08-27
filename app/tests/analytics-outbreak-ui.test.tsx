import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { AnalyticsPage } from '../src/renderer/pages/AnalyticsPage'
import type { AMRITApi } from '../src/shared/api'
import type { AnalysisResult, Laboratory } from '../src/shared/types'

const lab = { code: 'LAB', name: 'Outbreak Lab' } as Laboratory
const empty: AnalysisResult = {
  total: 0, resistant: 0, intermediate: 0, susceptible: 0, resistancePercent: 0,
  byOrganism: [], bySpecimen: [], byMonth: [], byAntibiotic: [], dataQuality: [],
  cohort: { sourceCount: 0, includedCount: 0, repeatIsolatesExcluded: 0, truncated: false,
    deduplicateMode: 'allIsolates', selectedOrganisms: [], selectedSpecimenTypes: [] }
}

describe('Analytics outbreak controls', () => {
  const run = vi.fn(async () => empty)

  beforeEach(() => {
    vi.clearAllMocks()
    const api = {
      masters: { list: vi.fn(async () => []) },
      analysis: { run, macros: vi.fn(async () => []), saveMacro: vi.fn(), deleteMacro: vi.fn() }
    } as unknown as AMRITApi
    Object.defineProperty(window, 'amrit', { configurable: true, value: api })
  })

  it('makes method, safety gate and accepted scan parameters visible', async () => {
    render(<AnalyticsPage currentLab={lab} />)
    await waitFor(() => expect(run).toHaveBeenCalled())
    fireEvent.change(screen.getByLabelText('Analysis mode'), { target: { value: 'clusterWatch' } })
    expect(screen.getByText('Signal is not a confirmed outbreak')).toBeInTheDocument()
    expect(screen.getByLabelText('Analysis type')).toHaveValue('prospective')
    expect(screen.getByLabelText('Historical baseline days')).toHaveValue(365)
    expect(screen.getByLabelText('Maximum cluster days')).toHaveValue(60)
    expect(screen.getByLabelText('Monte Carlo replications')).toHaveValue('999')
  })
})
