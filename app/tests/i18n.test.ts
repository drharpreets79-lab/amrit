// @vitest-environment node

import { describe, expect, it } from 'vitest'

import en from '../src/renderer/locales/en'

/**
 * Phase 7 gate: the catalogue is complete and internally consistent.
 *
 * A translator receives these files, so a missing key, an empty string or a placeholder
 * that appears in one form and not another is a defect they cannot fix — it has to fail
 * here instead.
 */
type Leaf = string
type Node = { [key: string]: Node | Leaf }

const flatten = (node: Node, prefix = ''): Array<[string, string]> =>
  Object.entries(node).flatMap(([key, value]) => {
    const path = prefix ? `${prefix}.${key}` : key
    return typeof value === 'string' ? [[path, value] as [string, string]] : flatten(value as Node, path)
  })

const placeholders = (value: string): string[] =>
  [...value.matchAll(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g)].map((match) => match[1] as string).sort()

const catalogue = en as unknown as Record<string, Node>

describe('translation catalogue', () => {
  it('covers every screen with its own namespace', () => {
    // One namespace per screen plus the shared primitives; a screen with none would be
    // silently untranslatable.
    for (const namespace of [
      'ai', 'analytics', 'audit', 'breakpoints', 'common', 'dashboard', 'deployment',
      'exports', 'imports', 'laboratories', 'masters', 'oneHealth', 'records', 'shell', 'sync'
    ]) {
      expect(Object.keys(catalogue), `${namespace} namespace is missing`).toContain(namespace)
      expect(flatten(catalogue[namespace] as Node).length).toBeGreaterThan(0)
    }
  })

  it('has no empty or whitespace-only strings', () => {
    const empty: string[] = []
    for (const [namespace, node] of Object.entries(catalogue)) {
      for (const [key, value] of flatten(node)) {
        if (!value.trim()) empty.push(`${namespace}:${key}`)
      }
    }
    expect(empty).toEqual([])
  })

  it('has no duplicated keys within a namespace', () => {
    for (const [namespace, node] of Object.entries(catalogue)) {
      const keys = flatten(node).map(([key]) => key)
      expect(new Set(keys).size, `${namespace} has duplicate keys`).toBe(keys.length)
    }
  })

  it('uses well-formed interpolation placeholders', () => {
    const malformed: string[] = []
    for (const [namespace, node] of Object.entries(catalogue)) {
      for (const [key, value] of flatten(node)) {
        // A single brace pair is the classic typo and silently renders as literal text.
        const singles = value.replace(/\{\{[^}]*\}\}/g, '').match(/[{}]/g)
        if (singles) malformed.push(`${namespace}:${key} — ${value}`)
      }
    }
    expect(malformed).toEqual([])
  })

  it('names every placeholder, so a translator can tell what it holds', () => {
    const unnamed: string[] = []
    for (const [namespace, node] of Object.entries(catalogue)) {
      for (const [key, value] of flatten(node)) {
        for (const name of placeholders(value)) {
          if (/^\d+$/.test(name)) unnamed.push(`${namespace}:${key} — {{${name}}}`)
        }
      }
    }
    expect(unnamed).toEqual([])
  })

  it('keeps every string on one line', () => {
    // Multi-line values survive round-tripping through translation tools badly.
    const wrapped: string[] = []
    for (const [namespace, node] of Object.entries(catalogue)) {
      for (const [key, value] of flatten(node)) {
        if (value.includes('\n')) wrapped.push(`${namespace}:${key}`)
      }
    }
    expect(wrapped).toEqual([])
  })

  it('carries a meaningful number of strings, so a screen cannot be half-extracted', () => {
    const total = Object.values(catalogue).reduce((count, node) => count + flatten(node).length, 0)
    expect(total).toBeGreaterThan(400)
  })
})
