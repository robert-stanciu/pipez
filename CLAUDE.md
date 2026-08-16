# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev                       # vite dev server on :5173, opens a sample two-storey house
npm test                          # vitest, engine golden cases (node environment)
npm run test:watch
npm test -- -t "swept corners"    # one describe block or test by name
npm test -- src/three/scene.test.ts
npm run typecheck                 # vue-tsc --noEmit
npm run build                     # typecheck + production build
npm run preview                   # serve dist/
```

There is no linter or formatter configured, and no environment variables, services or
accounts — the app is entirely client-side and projects are files.

`README.md` is the substantive design document: it explains *why* the engine works the way it
does (Hanan grid, bend costs, Steiner bundling, emergent stacks, 45° drainage geometry,
standards) and what the test suite proves. Read it before changing the router.

## Units and coordinate boundaries

The domain works in **millimetres**, **z up**, radians, and slopes as plain ratios
(`0.02` = 2%). There are exactly three places where that changes, and no others should be
added:

- `src/three/scene.ts` — mm/z-up → metres/y-up for three.js and the glTF exporter (`toScene`,
  `S = 0.001`). Both the 3D viewport and the exporter go through it so their geometry cannot
  diverge.
- `src/components/plan2d/svg.ts` and `sx`/`sy` in `src/stores/plan.ts` — plan y is north, SVG
  y grows down; one negation applied at the boundary.

## Architecture

### `src/domain/` is pure and must stay that way

No Vue, no DOM, no three.js anywhere under `src/domain/`. That is a hard constraint, not a
preference: the same code runs unmodified inside a Web Worker and is tested headlessly with
vitest's `node` environment. Importing a store or a Vue ref into the domain breaks both.

### The solve pipeline

`solve(project)` in `src/domain/routing/index.ts` is the single entry point. It resolves plan
geometry once (`levelShapes`) and shares it across five independent solvers — `routeWaste`,
`routeSupply` for cold and hot, `routeElectrical`, `routeHeating` — then totals everything with
`buildBom`. Adding or changing a service means touching that function, the `SystemKind` union in
`domain/types.ts`, and its `SYSTEM_LABEL` / `SYSTEM_COLOR` entries (the colours are shared by
the 2D overlay and the 3D meshes so the two views read as one drawing). Several `Record<SystemKind, …>`
tables elsewhere are exhaustive and will fail `typecheck` until they gain the new member —
that is deliberate.

**The solve must remain deterministic.** Ids come from `makeIdFactory` counters, iteration
order is fixed, and nothing consults `Date.now()` or a random source. Determinism is what
makes the golden tests meaningful and stops the 3D scene from rebuilding on every re-solve.

### Router internals

- `graph.ts` — nodes quantised to the millimetre; edges carry both a true physical length and
  a weighted cost, so a route can be discouraged (slab penetration, awkward layer) without
  lying about material quantities. Directions are packed sign triples (0–26, `DIR_NONE = 27`)
  rather than axes, because the diagonal drainage strategy must distinguish north-east from
  north and a 45° turn must not look free.
- `search.ts` — search state is `(node, direction-of-arrival)`. Dropping that dimension makes
  a staircase of jogs as cheap as a straight run.
- `layers.ts` — two graph shapes cover everything: a clipped Hanan **plane grid** (drainage
  under the floor, supply in the ceiling void) and a 1-D **wall graph** following centrelines
  at installation-zone height (cables). Builders write into a caller-supplied graph so layers
  can be stitched into one search space. `MAX_GRID_NODES` coarsens rather than blowing up.
- `steiner.ts` — terminals added furthest-first with a heavy discount on already-occupied
  edges, which is what makes branches bundle onto trunks and stacks emerge instead of being
  placed.
- `bends.ts` / `fittings.ts` — post-processing, and **the order matters**: route → sweep
  corners and junctions → `mergeCollinear` → `deriveFittings`. Fittings are read back off the
  finished geometry, so the schedule always describes what the drawing shows; bend bodies are
  not billed a second time as pipe.
- `loops.ts` / `heating.ts` — the one solver that is **not** a tree. A heating loop is a single
  unbroken length of pipe with no joint anywhere in the screed, so it is never bundled, never
  merged with a neighbour and never given fittings — `deriveFittings` is deliberately not
  called on it. `loops.ts` is pure covering geometry (line field, serpentine, perimeter return)
  and touches no graph at all; `heating.ts` uses the graph only for the leaders and the
  primary. If you change the pattern, the invariants to keep are in `heating.test.ts`: one
  chain, two ends, no branch, nothing crossing anything, no diagonal longer than a swept
  corner, no step under 25 mm — a shorter one draws as a riser in the plan — and the pitch
  graded tighter against the walls than through the middle.
- `placement.ts` — where to stand a manifold, which is a choice rather than a route: it scores
  wall positions on the leader pipe to every room plus the primary back to the heat source and
  is driven from the inspector, not from `solve`. It reads the model and returns a position;
  it does not mutate anything.

### The plant room

`src/domain/plant.ts` designs the heat pump plant from a **finished** solve — `designPlant(project,
result)` — rather than from inside it. It is post-processing, like `boardLayout.ts` is for the
board: it needs the manifold duties and the laid pipe, so it cannot run as a sixth solver, and
it produces a description rather than geometry. Pure, deterministic, no Vue. `standards/heatpump.ts`
holds the rules it reads (EN 12828 expansion and safety, defrost volume, cylinder coil area,
Legionella, glycol); keep new rules there rather than inlining constants in `plant.ts`.

The system water content is measured off `result` — every heating segment at its own bore, coil
and leaders at the UFH pipe's bore and the primary at the supply material's. That number drives
the buffer, the vessel and the glycol order, so if you change how heating segments are emitted,
check `plant.test.ts` still balances.

`src/components/plant/` draws it three ways, and they answer different questions. `PlantElevation`
is the wall the heat source is fixed to, to scale, and is what the room is set out from — every
component with a `mount` is packed along it by `setOut` in the domain, so "does it fit" is a
real check and not a guess. `PlantSchematic` and `WaterSchematic` are the two circuits, and
their topology is fixed because a heat pump plant's topology is fixed; only the number of
manifolds varies, one row each. The schematics are not to scale and neither is the plan — do not
try to reconcile them.

A component that occupies space carries `mount` (size and height off the floor) and gets a
balloon number; one that is a fitting on a pipe does not. Sizes come from the catalogue tables
in `standards/heatpump.ts` — they are trade sizes, close enough to set a room out from and
marked as such.

The circulation loop is driven by `RoutingWarning.code === 'hot-dead-leg'` from the supply
solver rather than by parsing its message. If you need something else in the app to react to a
finding, give that finding a code too.

Anything the solver cannot make work becomes a located `RoutingWarning` rather than a
plausible-looking drawing. Preserve that: never fall back to inventing geometry.

### Stores (`src/stores/`)

- `project.ts` — the single source of truth both views render from. Undo is snapshot-based:
  call `checkpoint()` *before* mutating, once per user-visible gesture (a drag checkpoints on
  pointer-down, not on every move).
- `routing.ts` — owns the worker. Projects are sent as `JSON.parse(JSON.stringify(...))`
  because Vue's reactive proxies are not structured-cloneable; a `generation` counter stops a
  slow solve from overwriting a newer one; the previous result stays on screen while a new one
  computes; and there is a main-thread fallback when `new Worker` throws (older browsers,
  tests). `watchProject()` is called once from `App.vue` and debounces re-solves.
- `plan.ts` — camera, snapping, and the drag state machine, which lives in the store because
  the shapes that start a drag are separate components.
- `view.ts` — active tool, system visibility, active storey (`null` resolves to ground floor in
  the plan store), and which workspace fills the middle of the screen.

### Derived fields that must be recomputed

Some values are stored rather than computed on demand because the router and geometry helpers
read them constantly. They can go stale:

- `Level.elevation` and `Room.floorZ` — call `relevel(project)` after any change to a storey's
  height, slab thickness or order.
- `Room.walls` is index-aligned with `Room.outline` edges; regenerate with `makeWalls` when the
  vertex count changes.
- `Room.heating` is optional and every field but `enabled` is nullable — a room that says
  nothing is heated on the project's terms. Read it through `heatingOf(project, room)` rather
  than reaching into it, so there is one definition of what a blank field means.

### Persistence

Changing the model means changing three things together: the type in `domain/types.ts`, the
zod schema in `io/projectFile.ts`, and — if old files would no longer load — `SCHEMA_VERSION`
in `domain/project.ts` (currently 2) plus its migration. Files are validated on load rather
than trusted. Work autosaves to IndexedDB from `App.vue`, debounced.

### Standards

`src/domain/standards/` is deliberately swappable: EN 12056-2 (drainage), EN 806-3 (supply),
EN 1264-2/-4 (underfloor heating), EN 12828 / EN 1717 (the sealed heat pump plant), and
HD 60364 / RO I7 with DIN 18015-3 (electrical). Sizes accumulate towards the root and never
reduce downstream. Keep new rules in these modules rather than inlining constants in the
routers.

Heating is sized the other way round from everything else: the binding constraint is the
**surface temperature** people stand on, not the load. `en1264.ts` keeps the three
calculations apart — what the floor may give at its limit, what this build-up does give, and
what the water has to do to carry it — and reuses `pressureLossKpa` from `en806.ts` for the
loop resistance.

## TypeScript notes

- `allowImportingTsExtensions` is on: **internal imports include the `.ts` extension**
  (`import { solve } from './index.ts'`). Match the surrounding files.
- `noUnusedLocals` and `noUnusedParameters` are enabled, so `typecheck` fails on dead bindings.
- `typescript` is pinned to 5.9 because `vue-tsc` 3.3 cannot drive the TypeScript 7 native
  compiler yet.
- Vue's compiler options come from `@tresjs/core/template-compiler-options` in
  `vite.config.ts`; a hand-rolled `tag.startsWith('Tres')` would also swallow `<TresCanvas>`
  and leave the scene with no context provider.
- The `@` → `src` alias exists, but the codebase overwhelmingly uses relative paths.

## Testing

`src/domain/routing/routing.test.ts` is the engine suite and asserts *invariants* rather than
exact geometry — every run drains to the outlet (checked by flooding outwards from the outlet,
not by counting loose ends), diameters never reduce towards the root, trunks are genuinely
shared, no drainage turn is sharper than 45°, unreachable fixtures are reported by name, and
the solve is deterministic. Add cases in that style; a test pinned to coordinates will break
on any legitimate improvement to the router.

`src/three/scene.test.ts` checks bend geometry — that a torus starts exactly where the pipe
stops being straight and ends where it resumes — because a mis-oriented bend still looks like
a bend from most angles.

The sample project is the real house on `A02.Plan parter` / `A03.Plan etaj` — a P+1E, 15.20 ×
8.95 m, with the upper storey set back onto gridlines 3–6. It is deliberately a *hard* case:
the two bathrooms are not stacked, so the upstairs soil stack has to find a wall that exists
on both storeys, and the kitchen is 17 m of branch from the outlet. Do not simplify it to make
the engine's life easier.

It carries a heating manifold on each storey, in the hall. Everything is heated except the
three outdoor slabs and the plant room; the two bathrooms are set to 24 °C at a 100 mm pitch,
which is the only place the sample overrides the project's heating defaults.

The plant room (`C.T.`) takes the west end of the north wing, on the facade, and the
ground-floor bathroom sits in the middle of that wing where the plant room used to be. That is
not cosmetic: an air-to-water monobloc needs an external wall for the line set and the
condensate, and a floor drain for the safety valve — `plant.test.ts` asserts the sample has
both, so moving the water heater into an internal room will fail it.

It ships with live warnings on purpose (branches past the EN 12056 unvented limits, hot dead
legs over the EN 806 limit, a heating loop-length spread the flow meters would struggle with),
so validation is visible in the UI. Do not "fix" the sample to silence them. Warnings are fine;
`error` severity is not — the sample must stay solvable.

Two tests are coupled to the sample's contents rather than to invariants and will need
updating if a room is renamed: `routing.test.ts` looks up `Bucătărie` and the first-floor
`Baie`, and `panel.test.ts` enumerates the electrical fixture types. `plant.test.ts` is coupled
to the sample having a water heater and a floor drain in a room on the facade.
