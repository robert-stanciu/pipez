/**
 * glTF export.
 *
 * The scene is rebuilt here from the domain model rather than lifted out of the live
 * viewport, so what gets exported does not depend on which layers happen to be toggled on.
 */

import { BoxGeometry, CylinderGeometry, Mesh, MeshStandardMaterial, Scene } from 'three'

import { SYSTEM_COLOR, type Project, type RoutingResult, type SystemKind } from '../domain/types.ts'
import { fixtureBox, segmentPlacement, segmentRadius, wallBoxes } from '../three/scene.ts'
import { download } from './projectFile.ts'

const UNIT_CYLINDER = new CylinderGeometry(1, 1, 1, 12)
const UNIT_BOX = new BoxGeometry(1, 1, 1)

export function buildExportScene(project: Project, result: RoutingResult): Scene {
  const scene = new Scene()
  scene.name = project.name

  const wallMaterial = new MeshStandardMaterial({ color: '#cbd5e1', roughness: 0.9 })
  const fixtureMaterial = new MeshStandardMaterial({ color: '#94a3b8', roughness: 0.6 })
  const pipeMaterials = new Map<SystemKind, MeshStandardMaterial>()
  const pipeMaterial = (system: SystemKind) => {
    const existing = pipeMaterials.get(system)
    if (existing) return existing
    const created = new MeshStandardMaterial({ color: SYSTEM_COLOR[system], metalness: 0.2 })
    pipeMaterials.set(system, created)
    return created
  }

  for (const room of project.rooms) {
    const openings = project.openings.filter((o) => o.roomId === room.id)
    for (const box of wallBoxes(room, openings)) {
      const mesh = new Mesh(UNIT_BOX, wallMaterial)
      mesh.name = `${room.name} wall`
      mesh.position.copy(box.position)
      mesh.rotation.copy(box.rotation)
      mesh.scale.copy(box.scale)
      scene.add(mesh)
    }
  }

  for (const fixture of project.fixtures) {
    const box = fixtureBox(project, fixture)
    if (!box) continue
    const mesh = new Mesh(UNIT_BOX, fixtureMaterial)
    mesh.name = fixture.name
    mesh.position.copy(box.position)
    mesh.rotation.copy(box.rotation)
    mesh.scale.copy(box.scale)
    scene.add(mesh)
  }

  for (const network of result.networks) {
    for (const segment of network.segments) {
      const placement = segmentPlacement(segment.a, segment.b)
      if (placement.length <= 0) continue
      const radius = segmentRadius(segment)
      const mesh = new Mesh(UNIT_CYLINDER, pipeMaterial(network.system))
      mesh.name = `${network.system} ${segment.size}`
      mesh.position.copy(placement.position)
      mesh.rotation.copy(placement.rotation)
      mesh.scale.set(radius, placement.length, radius)
      scene.add(mesh)
    }
  }

  return scene
}

export async function downloadGltf(project: Project, result: RoutingResult): Promise<void> {
  // Pulled in on demand: the exporter is a sizeable chunk that most sessions never touch.
  const { GLTFExporter } = await import('three/examples/jsm/exporters/GLTFExporter.js')
  const scene = buildExportScene(project, result)
  const exporter = new GLTFExporter()
  const gltf = await exporter.parseAsync(scene, { binary: false })
  const name = project.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'project'
  download(`${name}.gltf`, JSON.stringify(gltf), 'model/gltf+json')
}
