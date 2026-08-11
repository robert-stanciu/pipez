/** Bill of materials and circuit schedule as CSV. */

import { SYSTEM_LABEL } from '../domain/types.ts'
import type { Project, RoutingResult } from '../domain/types.ts'
import { download } from './projectFile.ts'

/** Quote a field only when it needs it, so the output stays readable in a text editor. */
const cell = (value: string | number): string => {
  const text = String(value)
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

const toCsv = (rows: Array<Array<string | number>>): string =>
  rows.map((row) => row.map(cell).join(',')).join('\n')

export function bomCsv(project: Project, result: RoutingResult): string {
  const rows: Array<Array<string | number>> = [
    ['Project', project.name],
    ['Generated', new Date().toISOString()],
    [],
    ['System', 'Item', 'Quantity', 'Unit'],
  ]
  for (const line of result.bom) {
    rows.push([SYSTEM_LABEL[line.system], line.item, line.quantity, line.unit])
  }

  if (result.circuits.length > 0) {
    rows.push([], ['Circuit', 'Type', 'Breaker (A)', 'Cable (mm²)', 'Outlets', 'Load (W)', 'RCD'])
    for (const circuit of result.circuits) {
      rows.push([
        circuit.name,
        circuit.kind,
        circuit.breakerAmps,
        circuit.cableMm2,
        circuit.fixtureIds.length,
        circuit.totalWatts,
        circuit.rcdProtected ? 'yes' : 'no',
      ])
    }
  }

  if (result.warnings.length > 0) {
    rows.push([], ['Severity', 'System', 'Message'])
    for (const warning of result.warnings) {
      rows.push([warning.severity, SYSTEM_LABEL[warning.system], warning.message])
    }
  }

  return toCsv(rows)
}

export function downloadBom(project: Project, result: RoutingResult): void {
  const name = project.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'project'
  download(`${name}-bom.csv`, bomCsv(project, result), 'text/csv;charset=utf-8')
}
