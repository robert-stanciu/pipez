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

  const panel = result.panel
  if (panel) {
    rows.push(
      [],
      ['Supply', panel.supply === 'three-phase' ? '400 V 3~ + N' : '230 V 1~'],
      ['Main switch (A)', panel.mainBreakerAmps],
      ['Maximum demand per line (A)', panel.maximumDemand.toFixed(1)],
      ['Line balance (A apart)', panel.imbalanceAmps.toFixed(1)],
      ['Enclosure (modules)', `${panel.modulesUsed} of ${panel.enclosureModules}`],
    )
    for (const phase of ['L1', 'L2', 'L3'] as const) {
      if (panel.supply === 'single-phase' && phase !== 'L1') continue
      rows.push([`Load on ${phase} (A)`, panel.phaseLoad[phase].toFixed(1)])
    }
  }

  if (result.circuits.length > 0) {
    rows.push(
      [],
      [
        'Way',
        'Circuit',
        'Type',
        'Line',
        'Poles',
        'MCB (A)',
        'RCD',
        'Cores',
        'Cable (mm²)',
        'Length (m)',
        'Load (W)',
        'Design (A)',
        'Volt drop (%)',
        'Outlets',
      ],
    )
    const ways = panel ? panel.ways.map((way) => way.circuit) : result.circuits
    ways.forEach((circuit, index) => {
      rows.push([
        index + 1,
        circuit.name,
        circuit.kind,
        circuit.poles === 3 ? 'L1+L2+L3' : (circuit.phases[0] ?? '—'),
        circuit.poles,
        circuit.breakerAmps,
        circuit.rcdProtected ? `#${circuit.rcdGroup + 1}` : 'none',
        circuit.cores,
        circuit.cableMm2,
        (circuit.routeLength / 1000).toFixed(1),
        circuit.totalWatts,
        circuit.designCurrent.toFixed(1),
        circuit.voltDropPercent.toFixed(2),
        circuit.fixtureIds.length,
      ])
    })
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
