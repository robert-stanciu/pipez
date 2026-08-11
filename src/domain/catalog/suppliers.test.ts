/**
 * What the shopping list has to get right.
 *
 * Two failures matter more than anything else here. The first is a BOM line that nobody
 * translated: it reaches the merchant as English, searches for nothing, and the user does not
 * find out until they click. The second is a malformed link, which is the same failure with a
 * worse error message. Both are asserted structurally rather than against fixed strings, so
 * that adding a fitting to the router breaks this suite loudly instead of quietly.
 */

import { describe, expect, it } from 'vitest'

import { sampleProject } from '../project.ts'
import { solve } from '../routing/index.ts'
import { searchLinks, shoppingList, shoppingListText, SUPPLIERS, TRADES } from './suppliers.ts'

const project = sampleProject()
const result = solve(project)
const items = shoppingList(project, result)

describe('shopping list', () => {
  it('produces something to buy for a house that has been routed', () => {
    expect(result.bom.length).toBeGreaterThan(0)
    expect(items.length).toBeGreaterThan(0)
  })

  it('covers all three trades', () => {
    const trades = new Set(items.map((item) => item.trade))
    for (const trade of TRADES) expect(trades).toContain(trade)
  })

  it('translates every BOM line — nothing falls through as raw English', () => {
    // The fallback in `partFor` copies the English item text into `romanian` verbatim, so a
    // row whose two descriptions are identical is a line the mapping missed.
    const untranslated = items.filter((item) => item.romanian === item.description)
    expect(untranslated.map((item) => item.description)).toEqual([])
  })

  it('gives every row Romanian search terms free of diacritics', () => {
    for (const item of items) {
      expect(item.terms.length).toBeGreaterThan(0)
      // Search boxes cope with ASCII everywhere; they do not all cope with ă, â, î, ș and ț.
      expect(item.terms).not.toMatch(/[ăâîșşțţĂÂÎȘŞȚŢ]/)
    }
  })

  it('names the parts in the diameters Romania actually stocks', () => {
    const drainage = items.filter((item) => item.trade === 'drainage' && item.unit === 'm')
    expect(drainage.length).toBeGreaterThan(0)
    // DN100 on the drawing is Ø110 on the rack, and a list that asks for 100 gets a blank look.
    for (const item of drainage) {
      const size = /(\d+)$/.exec(item.terms)
      expect(size).not.toBeNull()
      expect([32, 40, 50, 75, 110, 125]).toContain(Number(size![1]))
    }

    const supply = items.filter((item) => item.trade === 'water' && item.unit === 'm')
    expect(supply.length).toBeGreaterThan(0)
    for (const item of supply) {
      const size = /(\d+)$/.exec(item.terms)
      expect(size).not.toBeNull()
      // The whole PP-R ladder, plus 16 for the composite pipe: a rising main feeding a house
      // is a Ø40 or a Ø50, not something that stops at the size of a basin tail.
      expect([16, 20, 25, 32, 40, 50, 63]).toContain(Number(size![1]))
    }
  })

  it('quantities are positive and at least what the drawing needs', () => {
    for (const item of items) {
      expect(item.required).toBeGreaterThan(0)
      expect(item.quantity).toBeGreaterThan(0)
      expect(item.quantity).toBeGreaterThanOrEqual(item.required)
      expect(Number.isFinite(item.quantity)).toBe(true)
    }
  })

  it('says so in the row whenever more is ordered than the drawing needs', () => {
    for (const item of items) {
      if (item.quantity > item.required) expect(item.note).not.toBeNull()
    }
  })

  it('buys pipe in whole bars', () => {
    // Pipe is the case the allowance exists for: you cannot buy 6.25 m of anything.
    const pipe = items.filter((item) => item.unit === 'm' && item.trade !== 'electrical')
    expect(pipe.length).toBeGreaterThan(0)
    for (const item of pipe) {
      const bar = item.trade === 'drainage' ? 3 : 4
      expect(item.quantity % bar).toBe(0)
      expect(item.quantity).toBeGreaterThanOrEqual(item.required)
    }
  })

  it('merges the runs and the stack of the same pipe into one row', () => {
    // `Waste pipe DN100` and `Soil stack DN100` are the same product off the same rack;
    // ordering them on two lines orders them twice.
    const ids = items.map((item) => item.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('orders the parts of the consumer unit that the BOM never mentions', () => {
    expect(result.panels.length).toBeGreaterThan(0)
    const terms = items.map((item) => item.terms)
    expect(terms.some((t) => t.startsWith('tablou electric'))).toBe(true)
    expect(terms.some((t) => t.startsWith('intrerupator general'))).toBe(true)
    expect(terms.some((t) => t.startsWith('intrerupator diferential'))).toBe(true)
    expect(terms.some((t) => t.startsWith('pieptene conexiune'))).toBe(true)
    expect(terms.some((t) => t.startsWith('sina DIN'))).toBe(true)
    expect(terms.some((t) => t.startsWith('regleta nul'))).toBe(true)
    expect(terms.some((t) => t.startsWith('capac orb'))).toBe(true)

    // One RCCB per group the board was designed with, not one per circuit.
    const groups = result.panels.reduce((total, panel) => total + panel.rcdGroups.length, 0)
    const rccb = items
      .filter((item) => item.terms.startsWith('intrerupator diferential'))
      .reduce((total, item) => total + item.quantity, 0)
    expect(rccb).toBe(groups)
  })

  it('keeps the breakers the BOM already scheduled', () => {
    const mcbs = items.filter((item) => item.terms.startsWith('siguranta automata'))
    const scheduled = result.bom
      .filter((line) => line.item.startsWith('MCB '))
      .reduce((total, line) => total + line.quantity, 0)
    expect(mcbs.reduce((total, item) => total + item.quantity, 0)).toBe(scheduled)
  })

  it('is deterministic', () => {
    // The same project solved twice must shop the same, ids and all — the 3D scene and the
    // golden tests lean on that upstream, and a list that reshuffles itself on every re-solve
    // cannot be checked off on site.
    expect(shoppingList(project, solve(project))).toEqual(items)
  })

  it('has nothing to buy for an empty result', () => {
    const empty = shoppingList(project, {
      ...result,
      bom: [],
      panels: [],
      circuits: [],
    })
    expect(empty).toEqual([])
  })
})

describe('supplier links', () => {
  it('gives every row a link to every merchant', () => {
    for (const item of items) {
      const links = searchLinks(item)
      expect(links).toHaveLength(SUPPLIERS.length)
      expect(new Set(links.map((link) => link.supplier)).size).toBe(SUPPLIERS.length)
    }
  })

  it('every link is a valid absolute https URL on the merchant we meant', () => {
    const hosts: Record<string, string> = {
      dedeman: 'www.dedeman.ro',
      'leroy-merlin': 'www.leroymerlin.ro',
      hornbach: 'www.hornbach.ro',
      'brico-depot': 'www.bricodepot.ro',
      romstal: 'www.romstal.ro',
    }
    for (const item of items) {
      for (const link of searchLinks(item)) {
        const url = new URL(link.url)
        expect(url.protocol).toBe('https:')
        expect(url.host).toBe(hosts[link.supplier])
      }
    }
  })

  it('carries the search terms through the URL, encoded', () => {
    // A space, a comma and an ampersand are the three characters that break a hand-built
    // query string, so the terms are pushed through with all of them present.
    const item = { ...items[0], terms: 'teava PPR fibra 25 & cot, 45' }
    for (const link of searchLinks(item)) {
      const url = new URL(link.url)
      // Nothing raw survives into the URL text…
      expect(link.url).not.toContain(' ')
      expect(link.url).not.toContain(',')
      // …but decoding gets the words back, whether they travelled as a query or as a path.
      const carried = url.searchParams.get('q') ?? url.searchParams.get('sn.q')
      const decoded = carried ?? decodeURIComponent(url.pathname.split('/').pop() ?? '')
      expect(decoded).toBe(item.terms)
    }
  })

  it('never links to a guessed product page', () => {
    // The whole honesty of the feature: a search always resolves, a made-up SKU 404s.
    for (const item of items) {
      for (const link of searchLinks(item)) {
        expect(link.url.toLowerCase()).toMatch(/search|\/s\//)
      }
    }
  })
})

describe('plain text', () => {
  it('lists every row under a trade heading', () => {
    const text = shoppingListText(items, project.name)
    expect(text).toContain(project.name)
    expect(text).toContain('CANALIZARE')
    expect(text).toContain('INSTALAȚII SANITARE')
    expect(text).toContain('ELECTRICE')
    for (const item of items) expect(text).toContain(item.romanian)
  })

  it('is empty-ish rather than broken when there is nothing to buy', () => {
    expect(shoppingListText([], 'Untitled')).toBe('Untitled — listă de materiale')
  })
})
