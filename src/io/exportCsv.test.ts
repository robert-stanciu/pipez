/**
 * The schedule as it lands in a Romanian Excel.
 *
 * An export nobody can open is worse than no export, and "opens" here means double-clicking
 * the file in the locale the app is written for: semicolons between the fields, commas inside
 * the numbers, and a filename the person who saved it recognises.
 */

import { describe, expect, test } from 'vitest'

import { createProject } from '../domain/project.ts'
import { EMPTY_RESULT } from '../domain/types.ts'
import type { RoutingResult } from '../domain/types.ts'
import { bomCsv } from './exportCsv.ts'
import { slug } from './projectFile.ts'

const result = (over: Partial<RoutingResult> = {}): RoutingResult => ({ ...EMPTY_RESULT, ...over })

const lines = (csv: string): string[] => csv.split('\n')

describe('delimiter and decimals', () => {
  test('fields are separated by semicolons, not commas', () => {
    const csv = bomCsv(createProject('Casa'), result())
    expect(lines(csv)[0]).toBe('Project;Casa')
    expect(lines(csv)[3]).toBe('System;Item;Quantity;Unit')
  })

  test('a quantity is written with the decimal comma', () => {
    const csv = bomCsv(
      createProject('Casa'),
      result({ bom: [{ system: 'cold', item: 'Cold water pipe Ø20 PPR', unit: 'm', quantity: 12.4 }] }),
    )
    expect(csv).toContain('Cold water;Cold water pipe Ø20 PPR;12,4;m')
  })

  test('a whole number stays whole, and a rounded string is converted too', () => {
    const csv = bomCsv(
      createProject('Casa'),
      result({
        bom: [
          { system: 'waste', item: 'Bend 45° DN100', unit: 'pc', quantity: 6 },
          { system: 'cold', item: 'Tee Ø25 PPR', unit: 'pc', quantity: 1.5 },
        ],
      }),
    )
    expect(csv).toContain(';6;pc')
    expect(csv).toContain(';1,5;pc')
  })

  test('a field carrying the delimiter is quoted; a field carrying a comma need not be', () => {
    const withSemicolon = bomCsv(createProject('Casa; anexă'), result())
    expect(lines(withSemicolon)[0]).toBe('Project;"Casa; anexă"')

    const withComma = bomCsv(createProject('Casa, etaj 1'), result())
    expect(lines(withComma)[0]).toBe('Project;Casa, etaj 1')
  })

  test('a warning message keeps its own commas without being split', () => {
    const csv = bomCsv(
      createProject('Casa'),
      result({
        warnings: [
          {
            id: 'w1',
            severity: 'warning',
            system: 'hot',
            message: 'Chiuvetă has 3,4 litres standing, past the limit',
          },
        ],
      }),
    )
    const row = lines(csv).find((line) => line.startsWith('warning;'))
    expect(row).toBe('warning;Hot water;Chiuvetă has 3,4 litres standing, past the limit')
  })
})

describe('filenames', () => {
  test('diacritics fold to their base letters instead of being deleted', () => {
    expect(slug('Casă Popescu')).toBe('casa-popescu')
    expect(slug('Locuință în Iași, Str. Ștefan')).toBe('locuinta-in-iasi-str-stefan')
    // The cedilla spellings still in circulation fold the same way as the comma-below ones.
    expect(slug('Şoseaua Ţăndărei')).toBe(slug('Șoseaua Țăndărei'))
  })

  test('a name with nothing usable in it still produces a filename', () => {
    expect(slug('   ')).toBe('project')
    expect(slug('...')).toBe('project')
  })
})
