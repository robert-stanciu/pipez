/** Bill of materials and circuit schedule as CSV. */

import { SYSTEM_LABEL } from '../domain/types.ts'
import type { Project, RoutingResult } from '../domain/types.ts'
import { download, slug } from './projectFile.ts'

/**
 * Semicolons, and numbers with a comma for a decimal mark.
 *
 * A comma-delimited file with dot decimals is only "the" CSV format in a locale that uses a
 * dot for decimals. Romanian — like most of continental Europe — writes 12,5 and therefore
 * takes `;` as its list separator, so Excel opens a comma-delimited file with the whole
 * schedule stacked in column A and every length silently mangled. Writing the file the way
 * the reader expects is the only version of this that opens correctly by double-clicking,
 * and the `sep=` hint some tools use is a Microsoft extension the rest ignore.
 */
const DELIMITER = ';'

/**
 * Quote a field only when it needs it, so the output stays readable in a text editor.
 *
 * With a semicolon between the fields a comma inside one is harmless, which is what lets the
 * decimal mark be a comma at all: only the delimiter, a quote and a newline force quoting.
 * The swap catches a value already rounded to a string as well as a raw number, so a length
 * printed as `12.4` upstream still lands in the file as `12,4`.
 */
const cell = (value: string | number): string => {
  const raw = String(value)
  const text = /^-?\d+\.\d+$/.test(raw) ? raw.replace('.', ',') : raw
  return /[";\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

const toCsv = (rows: Array<Array<string | number>>): string =>
  rows.map((row) => row.map(cell).join(DELIMITER)).join('\n')

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

  for (const panel of result.panels) {
    rows.push([], [`Board — ${panel.name}${panel.isMain ? ' (main)' : ''}`])
    rows.push(
      ['Supply', panel.supply === 'three-phase' ? '400 V 3~ + N' : '230 V 1~'],
      ['Main switch (A)', panel.mainBreakerAmps],
      ['Maximum demand per line (A)', panel.maximumDemand.toFixed(1)],
      ['Line balance (A apart)', panel.imbalanceAmps.toFixed(1)],
      ['Enclosure (modules)', `${panel.modulesUsed} of ${panel.enclosureModules}`],
    )
    if (!panel.isMain && panel.submainMm2) {
      rows.push(['Submain', `${panel.submainMm2} mm² over ${(panel.submainLength / 1000).toFixed(1)} m`])
    }
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
    const ways = result.panels.flatMap((panel) => panel.ways.map((way) => way.circuit))
    const scheduled = ways.length > 0 ? ways : result.circuits
    scheduled.forEach((circuit, index) => {
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

  for (const manifold of result.manifolds) {
    rows.push([], [`Manifold — ${manifold.name}`])
    rows.push(
      ['Flow / return (°C)', `${manifold.flowTempC} / ${manifold.returnTempC}`],
      ['Loops', `${manifold.loops} of ${manifold.ports} ports`],
      ['Output (W)', Math.round(manifold.outputW)],
      ['Flow rate (kg/h)', Math.round(manifold.flowKgH)],
      ['Pump head (kPa)', manifold.pumpHeadKpa.toFixed(1)],
      [
        'Primary',
        `Ø${manifold.primarySize} over ${(manifold.primaryLength / 1000).toFixed(1)} m`,
      ],
    )

    // The loop schedule proper: this is the sheet the flow meters are set from, so the
    // columns are the ones a commissioning engineer reads across.
    rows.push([
      'Port',
      'Room',
      'Length (m)',
      'Area (m²)',
      'Pitch (mm)',
      'Covering',
      'Room (°C)',
      'Output (W/m²)',
      'Surface (°C)',
      'Limit (°C)',
      'Flow (kg/h)',
      'Velocity (m/s)',
      'Δp (kPa)',
    ])
    for (const loop of result.loops.filter((l) => l.manifoldId === manifold.id)) {
      rows.push([
        loop.port,
        loop.partOf > 0 ? `${loop.roomName} (${loop.partOf})` : loop.roomName,
        (loop.length / 1000).toFixed(1),
        loop.area.toFixed(1),
        loop.spacing,
        loop.covering,
        loop.roomTempC,
        Math.round(loop.fluxW),
        loop.surfaceTempC.toFixed(1),
        loop.surfaceLimitC,
        Math.round(loop.flowKgH),
        loop.velocity.toFixed(2),
        loop.pressureDropKpa.toFixed(1),
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
  download(`${slug(project.name)}-bom.csv`, bomCsv(project, result), 'text/csv;charset=utf-8')
}
