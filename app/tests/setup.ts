import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'

// Vitest runs without injected globals, so Testing Library's own auto-cleanup never
// registers; without this, rendered trees accumulate across tests in the same file.
afterEach(cleanup)
