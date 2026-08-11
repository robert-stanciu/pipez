# Pipez

Browser-based designer for domestic building services. Draw rooms across as many storeys as
the building has, connect them, place fixtures, mark where the services enter and leave — and
the app computes the pipe and cable runs for you: cold water, hot water, gravity drainage and
electrical circuits, complete with the vertical stacks between floors, sized from the
standards, drawn in 2D and 3D, and totalled into a bill of materials.

Everything runs in the browser. There is no server and no account; projects are files.

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # engine golden cases
npm run build      # typecheck + production build
```

## How it works

**Draw** a room with the Room tool, or drag an existing one. Drag a wall to push it; select a
wall and type an exact length. Rooms snap to each other so that two neighbours end up sharing
one wall rather than two that nearly touch — which is what lets a run cross between them.

**Stack storeys** from the panel on the left. The plan edits one storey at a time and draws
the one below as a faint underlay, because snapping a wall onto the wall beneath it is what
gives a soil stack or a riser somewhere to run — the router will not punch through a slab
anywhere else. Storey elevations are derived by stacking heights and slabs, so changing one
storey's height moves everything above it.

**Place** fixtures from the left rail. Wall-mounted things anchor to the nearest wall and slide
along it, so they follow when the wall moves. Each fixture carries typed connection ports and
its load figures; those are what the solver actually connects.

**Mark** the three service points — water entry, waste outlet, consumer unit. Every network is
a tree rooted at one of them.

The solve then runs automatically, in a worker, debounced behind your edits.

## The routing engine

`src/domain/` is pure TypeScript with no Vue, no DOM and no three.js, so the whole solver is
testable headlessly and runs unmodified inside a Web Worker.

**The graph is a Hanan grid, not a voxel field.** Lines are drawn only through coordinates
that matter — fixture ports, service points, wall faces, standard install heights — and
clipped to where a run is actually allowed to be. That is a few thousand nodes instead of six
figures, and an optimal rectilinear route is still guaranteed to exist on it.

**Search charges for bends.** The search state is (node, direction-of-arrival), so changing
axis has a cost. Without that, a staircase of tiny jogs is exactly as cheap as a straight run
and you get a route no installer would ever build.

**Branches bundle.** Connecting N fixtures to one source is a Steiner tree problem; we grow the
tree terminal by terminal, furthest first, with a heavy discount on edges the tree already
occupies. New branches therefore prefer to join an existing trunk instead of fanning out.

**Drainage is designed in plan, then given levels.** Falls are applied by walking out from the
outlet — `z = outlet + storey rise + slope × horizontal run` — which is how drainage is
actually designed, and it keeps each storey's search two-dimensional. The two terms separate
cleanly because storey rises telescope along any path, so every floor gets the same headroom
budget under its own slab and only flat run buys fall; dropping down a stack is free. Where
the design fall will not fit under the floor, the solver eases it towards the minimum before
giving up, and only reports failure when even the minimum will not work. It will not draw a
pipe that runs uphill.

**Stacks are not placed — they emerge.** A run may only cross a slab inside a wall that exists
on *both* storeys, and each crossing is charged steeply. Combined with the reuse discount,
that pulls every upstairs branch onto one shaft: a soil stack, a rising main, a cable riser.
Sizing follows: a vertical drainage run is sized by the stack tables rather than the branch
ones, and appears on the schedule as a soil stack rather than as more waste pipe. If the
storeys have no wall in common the solver says so, by name, instead of inventing a hole.

**Cables are constrained by where, not just how far.** Horizontal runs follow wall centrelines
inside the DIN 18015-3 installation zones, plus the ceiling plane for light points. A cable
buried outside those zones is a real hazard, so it is not an option the search is offered.

### Standards

Swappable, in `src/domain/standards/`:

| Concern | Basis |
|---|---|
| Drainage: discharge units, `Qww = K·√ΣDU`, diameters, falls, unvented limits | EN 12056-2, System I |
| Supply: loading units, diameters, hot dead-leg limit | EN 806-3 |
| Circuits, cable sizing, installation zones | HD 60364 (RO I7), DIN 18015-3 |

Sizes accumulate towards the root and never reduce downstream. Anything the solver cannot
make work becomes a located warning in the Checks panel rather than a plausible-looking
drawing — click one to select the fixture it refers to.

## Files

Save and open `.pipez` files (JSON, validated on load against a versioned schema). Work
autosaves to IndexedDB, so a reload costs nothing. Export the routed model to glTF, or the
bill of materials, circuit schedule and warnings to CSV.

The format is at **schema 2**. A schema-1 file — written before storeys existed — still opens:
the migration puts everything it contains on a new ground floor, which is by definition where
it was.

## Layout

```
src/
├─ domain/          pure TS: model, geometry, catalogue, standards, routing
│  └─ routing/      graph · search · steiner · waste · supply · electrical · fittings
├─ workers/         the solver, off the main thread
├─ stores/          pinia: project (with undo) · selection · view · plan · routing
├─ three/           the one place mm/z-up becomes m/y-up
├─ components/      plan2d (SVG) · view3d (TresJS) · panels · ui
└─ io/              .pipez files · autosave · glTF · CSV
```

## Verifying it end to end

`npm test` covers the engine: falls run downhill at a legal slope, diameters step up where
loads accumulate and never reduce towards the outlet, shared trunks are actually shared, a
detached room reports as unreachable, an impossible fall is reported rather than drawn, the
fall is eased when that is enough to fit, circuits split at their limits, a doorway blocks
cable runs through it, and the whole solve is deterministic.

For storeys specifically: an upstairs fixture drains down a stack that is vertical, downward
and a storey tall; both upstairs fixtures share **one** shaft rather than punching a hole
each; a WC upstairs forces the stack to DN100; branches stay under their own storey's floor;
supply and cabling each get their own riser; a misaligned upper storey is reported as
unreachable with the reason; and a stack is billed as a soil stack.

By hand, `npm run dev` opens on a sample two-storey house. Switch storeys in the left panel
and watch the plan change while the 3D view keeps the whole building; note the ⊗ symbols where
a stack passes through the floor. Drag the kitchen sink along its wall and watch the totals
re-solve; place a fixture upstairs and watch the stack resize; add a storey, draw a room on
it, and undo; tick "Only this storey (3D)" to isolate a floor; save, reload, and confirm the
autosave restores.

The sample deliberately ships with live warnings — two basins past the EN 12056 unvented run
limit for DN40, and a hot dead leg over the EN 806 limit — so the validation is visible rather
than theoretical.

## Notes

- `typescript` is pinned to 5.9 because `vue-tsc` 3.3 cannot yet drive the TypeScript 7 native
  compiler. Everything else is current.
- Vue's compiler options come from `@tresjs/core/template-compiler-options` rather than a
  hand-rolled `tag.startsWith('Tres')`, which would also swallow `<TresCanvas>` itself and
  leave the scene with no context provider.
- A storey's rooms may each have their own ceiling height, but wall thickness is uniform per
  room — per-wall thickness would need mitre handling that a domestic plan never calls for.
- Stacks are emergent, not placed. If you need one in a specific shaft, put a wall there on
  both storeys; the router will find it, because it is the only place it may cross.
