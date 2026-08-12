# Pipez

Browser-based designer for domestic building services. Draw rooms across as many storeys as
the building has, connect them, place fixtures, mark where the services enter and leave — and
the app computes the pipe and cable runs for you: cold water, hot water, gravity drainage,
electrical circuits and underfloor heating, complete with the vertical stacks between floors,
sized from the standards, drawn in 2D and 3D, and totalled into a bill of materials.

Everything runs in the browser. There is no server and no account; projects are files.

```bash
git clone git@github.com:robert-stanciu/pipez.git
cd pipez
npm ci             # or `npm install`

npm run dev        # http://localhost:5173
npm test           # engine golden cases
npm run typecheck  # vue-tsc
npm run build      # typecheck + production build
npm run preview    # serve the built dist/
```

`node_modules/` and `dist/` are not tracked — `npm ci` restores the first from
`package-lock.json`, and `npm run build` produces the second. There is nothing else to set
up: no environment variables, no services, no database.

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

**Mark** the service points — water entry, waste outlet, consumer unit, heating manifold. Every
network starts at one of them. Water comes into a building once, so placing the entry again
moves it; drainage, boards and manifolds can have several, so placing those again adds one. A
manifold is what turns underfloor heating on: place one and its storey is heated, in the rooms
it can reach.

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

**Drainage has two layout strategies**, chosen in Project settings:

- **Right angles** — every run parallel to a wall. The conventional layout, easiest to support
  and to find again later. Routes on the Hanan grid.
- **Any bearing** — a horizontal run may head straight for the point where it drops, at
  whatever angle that happens to be. This needs no special fitting: the pipe never turns
  while horizontal, so the bearing is simply which way the straight run points, and the only
  fittings involved are the 45° pairs taking it off the vertical and back onto it. Straight
  edges between mutually visible points are overlaid on the grid, so the tree still has the
  grid to branch on — a visibility graph alone has too few places to join, and pushes the
  solver into a star of separate runs that uses *more* pipe than the L-shaped routes it
  replaced.

A diagonal is charged for the pair of bends it needs at each end, so it is taken only where
the length saved beats the fittings. On the sample house every fixture already sits along a
wall and both strategies agree; give the same room a fixture in the far corner and the
diagonal run is 7.3 m with 2 bends against 10.1 m with 4.

Only drainage is affected. Supply and cabling stay rectilinear, which is what they are in a
real building.

**Branches join in the direction of flow.** A square tee on a drain is wrong for the same
reason a square elbow is: the incoming flow hits the far wall of the main run, throws the
stream back on itself and drops its solids at the junction. Every branch therefore enters
through a 45° oblique tee, angled downstream.

The geometry is forced once you insist on that. A branch cannot enter the *same* point at
45°, so the junction slides a little way downstream along the main run while the branch stops
the same distance short, and the diagonal between them lands at 45° to both — a 45° bend
followed by a 45° tee, which is the detail on the drawing. Where the main run turns *and*
collects a branch at once, it keeps its corner and a short piece carries it down to the new
junction, so the corner is swept and the branch still enters obliquely.

**Turns sharper than 45° are built from two 45° bends.** A 90° elbow in a soil pipe stalls
solids in its sharp inside and cannot be rodded through, so the schedules pair two 45s with a
short leg between them. That is a fact about the pipe, not a drawing convention — the run
really does cut the corner — so the model carries it: after routing, every such corner is
chamfered into two equal halves, and the fittings are read back off the finished geometry.
What the schedule counts is therefore what the drawing shows, and drainage never orders a
bend sharper than 45°. In plan an elbow is a tick across the run, so you see two at a cut
corner; in 3D it is the arc the pipe actually sweeps through, tangent to both legs.

Angles are reported as the part you would order. Graded pipe is never level, so two legs that
are square in plan meet at about 89°, and a swept half of that computes as 44.4° — both are
snapped to the catalogue (15/30/45 for drainage, 45/90 for pressurised pipe and cable), and
anything under 5° is a joint in a straight run rather than a fitting.

**Appliances connect from below or from behind.** Set the default in Project settings and
override it per appliance in the inspector:

- **From below** — water and waste drop through the floor beneath the appliance. Pipes in the
  plinth, or buried in the screed.
- **From behind** — they run horizontally into the wall behind it and turn vertical *inside
  the wall*. What wall-hung sanitaryware and a back-to-wall WC need, and what you use when
  the slab must not be broken into.

The visible difference is where the verticals are: under the appliance, or on the wall
centreline. On the sample house, back entry moves all eight drops onto walls and adds a metre
of pipe for the tails.

Which wall an appliance backs onto is yours to set. The **Mounting** control in the inspector
offers free-standing or any wall of the room; switching keeps the appliance where it is and
facing the way it faces, and only changes how it is held. It also decides how dragging
behaves — anchored to a wall, it slides along that wall; free-standing, it moves anywhere.

The catalogue's mount is only a default for placement, so an appliance you have not said
anything about is checked geometrically: is its back against a wall? Without that, back entry
would silently do nothing for the shower, washing machine, dishwasher and tumble dryer — the
appliances that most often need it, and the ones the editor places free-standing. An explicit
mounting always wins over the nearest wall, and something genuinely clear of every wall falls
back to below and says so.

It brings a check with it, too: a DN100 WC will not hide inside a 100 mm wall, so the app
says so and tells you what would fix it.

Cables are not affected: a socket is always fed from behind.

**Drainage may leave the building in more than one place.** A house whose bathroom is at one
end and whose kitchen is at the other does not run one pipe the length of it to keep the
drainage in one piece — each side goes out through the nearest wall. Every outlet you place
becomes a root, and which fixture uses which is answered by the router rather than asked of
you: the outlets hang off one costless virtual root, each branch grows to whichever is
cheapest to reach, and the tree falls apart into one real network per outlet. The design can
only improve for being offered another way out, and the plan shows the networks as the
separate pieces they are.

**Every drain is vented.** A discharging stack drags air behind it, and with nowhere for that
air to come from it is pulled through the nearest trap instead — which empties the seal and
lets the drain into the room. So the highest point of each network gets an air admittance
valve: it lets air in and shuts against anything trying to leave, equalising the pressure
without taking a vent through the roof. It is sized to the pipe it sits on, and it is placed
on the finished drawing rather than on the routed tree, because sweeping corners moves points
about and a stub hung off a point that later moved would attach to nothing. In plan it is a
ring with the air arrow running into it; in 3D, the squat cap it is.

**Stacks are not placed — they emerge.** A run may only cross a slab inside a wall that exists
on *both* storeys, and each crossing is charged steeply. Combined with the reuse discount,
that pulls every upstairs branch onto one shaft: a soil stack, a rising main, a cable riser.
Sizing follows: a vertical drainage run is sized by the stack tables rather than the branch
ones, and appears on the schedule as a soil stack rather than as more waste pipe. If the
storeys have no wall in common the solver says so, by name, instead of inventing a hole.

**Three-phase supply and the consumer unit.** A 400 V three-phase supply (the system older
drawings call 380/220 V) is the default; single-phase is a setting. Most circuits stay at
230 V off one line, and the point of the other two is that the load can be spread across
them — and that a fixed appliance can be taken across all three. On the sample house, putting
the 7 kW cooker on three phases takes it from **30.4 A on one line to 10.1 A on three**, its
volt drop from 0.50% to 0.08%, and the installation's maximum demand from 39.2 A to 20.3 A —
the difference between needing a 40 A incomer and fitting inside a 25 A one.

Circuits are dealt across the lines longest-first onto the quietest line: a greedy heuristic
rather than an optimum, but close enough on the couple of dozen circuits a building has. An
imbalance is reported in **amps, not percent** — two small circuits can sit 100% apart and
mean nothing, while the same percentage on a heavy supply is tens of amps down the neutral.

**A board per storey, if you want one.** Place a second consumer unit and it becomes a
sub-board: the main board is the one on the lowest storey, where the supply arrives, and each
of the others is fed from it by a submain sized for the load behind it. Circuits are then
assigned to whichever board is cheaper to reach and never span two — a circuit belongs to one
board or it is not a circuit — so the upstairs cabling stops climbing back down to the ground
floor and the runs, and their volt drops, get shorter.

**Cable is sized on the run, not just the breaker.** A 2.5 mm² circuit protected at 16 A is
perfectly safe and still unusable at forty metres, because the far end sags below what the
appliance will start on. Sizing happens after routing, when the length is known, against the
3% (lighting) and 5% (everything else) limits, and the result is written back onto the runs so
the plan, the 3D view and the board all say the same thing. A socket circuit is assessed at
its breaker rating rather than its connected load — nobody knows what will be plugged in later.

**The board gets its own view.** Wiring and board layout answer different questions: on the
plan you want to know where a cable runs; on the board, what is on which way, behind which
device, on which line, and whether the incomer can carry it. So the panel replaces the plan
and 3D rather than sharing with them.

It is drawn as the board itself, to scale — the enclosure, top-hat DIN rails at the 17.5 mm
module pitch, twelve modules to a row, and gear with the proportions of the real thing: body,
toggle, label window and printed marking, so a breaker reads `C16` and a residual current
device reads `40 A / 30 mA` with its test button. A three-pole breaker is three ganged
modules, the free modules carry blanking plates, the comb busbar and the loop wiring behind
the gear are drawn, and the neutral and earth bars run along the bottom in the HD 308 core
colours. Where there is more than one board, a selector names each one, marks which is the
main and which storey it sits on, and the schedule below follows the selection. Hovering a
device highlights its row, and hovering a row highlights the device.

A three-phase board uses four-pole devices. A two-pole one switches a single line and the
neutral, so everything behind it would have to be on that same line, which would tie the
residual-current grouping to the phase balancing and let each constrain the other.

**Cables are constrained by where, not just how far.** Horizontal runs follow wall centrelines
inside the DIN 18015-3 installation zones, plus the ceiling plane for light points. A cable
buried outside those zones is a real hazard, so it is not an option the search is offered.

Which of the two permitted bands the distribution uses is a setting, the same kind of choice
as the drainage layout: **along the ceiling**, which suits a slab you would rather not chase
and gives the shortest runs to the lights, or **under the floor**, in the screed, which gives
the shortest runs to the sockets. The drops to each point stay inside the vertical zones
either way.

**Underfloor heating is laid, not routed.** Every other system is a tree that has to reach
somewhere. A heating loop has nowhere to get to: it is one unbroken length of pipe off a coil
that leaves the manifold, covers a floor evenly, and comes back — with no joint anywhere in
the screed, because a joint in a screed is a leak you cannot reach. So the heating solver
does not use the Steiner tree at all. It uses the graph for two things only: the **leaders**
between a manifold and a room, and the **primary** flow and return between the heat source and
each manifold.

Place a manifold and the storey it stands on is heated. Every room on that storey goes to its
nearest manifold — a room can be pointed at a particular one, or taken off heating entirely,
in its inspector — and the loops are drawn from where the manifold lands. Move it and they are
re-drawn: the leaders are pipe off the same coil, so a manifold in the middle of the plan buys
floor area at the far end of it.

The pattern is a **serpentine with a perimeter return**. The pipe leaves the manifold side of
the room, meanders across the interior at the design pitch, and comes home round the outside.
That gets three things at once: both ends finish at the same corner, so the flow and return
leave together instead of one of them crossing the coil to get out; the perimeter leg puts a
second run along the external wall, where the losses are; and nothing crosses anything. A
counterflow (bifilar) meander — the obvious alternative, and thermally the better one — cannot
manage the last of those: its end turns interleave, and on a plan they intersect however they
are drawn. A room too large for one loop is cut into bands across its long axis, each band
grown past its share so the two coils meet at the design pitch rather than leaving a cold
strip down the middle of the floor.

**The floor is sized by how warm it is allowed to get.** EN 1264-2 caps the mean surface
temperature at 29 °C in a living space, 33 °C in a bathroom; at 29 °C over a 20 °C room that
is about 100 W/m², whatever is buried in it. What a particular floor gives is worked out from
the resistance of its build-up — the screed over the pipe, the covering on top, the surface
film, and the spreading the pitch imposes — driven by the logarithmic mean water-to-room
excess the standard defines, not the arithmetic mean of the two ends. Pitch enters as a
spreading resistance rather than a table of factors, which is the same physics the factors
were fitted to; it is also why doubling the pitch does not halve the output, it mostly just
makes the floor stripy. The covering is the biggest lever there is: the same pipe at the same
temperature gives a bit under half as much under carpet as under tile.

Every loop is then checked on the water side and on the schedule: velocity inside the band
that carries air along to the manifold, pressure inside what a manifold circulator can be
relied on for, length inside what the pipe allows — **leaders included, because they come off
the same coil** — and the loops on one manifold close enough in length that its flow meters
can balance them. EN 1264-4's execution rules are checked too: 45 mm of screed over the crown
of the pipe, the insulation resistance the storey underneath asks for, and a movement joint
around any heated field over 40 m² or 8 m on a side.

The manifold schedule sits in the Checks column, one block per manifold, and is also written
to the CSV: port, room, length, area, pitch, output, surface temperature against its limit,
flow, velocity and pressure drop — the sheet the flow meters are actually set from.

**What to buy, and where.** The bill of materials is what the design *needs*; the shopping
list is what you would actually order. It renames every line into the words a Romanian
merchant's catalogue uses, converts the standards' nominal bores into the sizes on the shelf
(DN100 drainage is Ø110 PVC; DN15 supply is Ø20 PPR), rounds pipe up to whole bars and says
so in the row rather than inflating the number quietly, and derives the board parts the
routing never counts — enclosure, main switch, one RCCB per device group, busbar comb, DIN
rail, terminal bars, blanking plates, and the submain for a sub-board. Each row carries a
search link to Dedeman, Hornbach, Leroy Merlin, Brico Dépôt and Romstal, built from the
Romanian search terms shown beside it. They are searches, not deep product links: a search
resolves, and an invented SKU does not.

### Standards

Swappable, in `src/domain/standards/`:

| Concern | Basis |
|---|---|
| Drainage: discharge units, `Qww = K·√ΣDU`, diameters, falls, unvented limits | EN 12056-2, System I |
| Supply: loading units, diameters, hot dead-leg limit | EN 806-3 |
| Underfloor heating: surface temperature limits, output, loop hydraulics, screed and insulation | EN 1264-2 / -4 |
| Circuits, cable sizing, volt drop, diversity, installation zones | HD 60364 (RO I7), DIN 18015-3 |

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
├─ domain/          pure TS: model, geometry, catalogue (fixtures · suppliers), standards, routing
│  └─ routing/      graph · search · steiner · waste · supply · electrical · heating · loops
│                   · bends · fittings
├─ workers/         the solver, off the main thread
├─ stores/          pinia: project (with undo) · selection · view · plan · routing
├─ three/           the one place mm/z-up becomes m/y-up
├─ components/      plan2d (SVG) · view3d (TresJS) · panel (the board) · shopping · panels · ui
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

For connection entry: back entry puts the drops on the wall centreline and below entry puts
them under the appliance; the tail into the wall shows up as extra pipe; a per-fixture
override beats the project default both ways; free-standing appliances get back entry too,
not only wall-hung ones; an appliance with no wall behind it falls back and says so while
staying connected; a wall too thin to hide the pipe is reported; and cabling comes out
identical either way.

For mounting: choosing a wall moves the connection onto *that* wall and no other; an explicit
choice beats whichever wall happens to be nearest; and a wall-hung fixture set free-standing
stops using the wall.

`src/domain/electrical/panel.test.ts` covers the board: spreading the load lowers what each
line carries; a cooker on three phases draws a third of the current and drops a third as much;
a long run is uprated past what the breaker alone would need, and the cable chosen actually
satisfies the limit it was chosen for; the cable in the schedule is the cable that was drawn;
ways do not overlap on the rail and fit the enclosure; a three-phase board uses four-pole
devices and nothing sits behind a device that could not switch it; lighting is dealt round
different devices so one fault cannot take every light out; and the design is deterministic.

For corners, junctions and strategies: no turn sharper than 45° survives anywhere in the
drainage; every branch joins the run it feeds at 45° in the direction of flow; the schedule
orders oblique tees and never square ones; **every run still drains to the outlet**, checked
by flooding the network outwards from the outlet rather than by counting loose ends — splice
two runs together and drop the outlet and the counts still balance while the drainage goes
nowhere; every 45° leg has a real fitting at both ends; a joint in a graded straight run is
not mistaken for a fitting; bends are billed as bends and their bodies are not billed a second time as pipe;
the rectilinear strategy keeps every run on an axis; the any-bearing one produces runs at
angles that are neither axis-aligned nor 45°; going diagonally is shorter where it should be
and is declined where it would not pay; and switching strategy leaves supply and cabling
alone.

`src/domain/routing/heating.test.ts` covers the coils. The properties that matter are the ones
you cannot see in a screenshot: a coil is **one unbroken chain** with exactly two ends and
nothing that branches — a tee in a screed is not a thing — and **nothing in it crosses anything
else in it**, which is the invariant that rules the counterflow meander out. Beyond that: the
pipe keeps its clearance from every wall; a WC or a bath takes floor out of the coil rather
than being laid under; a room too big for one loop is split, and the parts come out at the
same pitch rather than paying for the split with a bare strip between them; bands cover the
room between them and no more; a room with nothing left to lay in is reported rather than
skipped; every heated room reaches a manifold on its own storey; ports are numbered without
gaps; the manifold totals what is ported on it and its pump covers the worst loop; a loop is
measured with its leaders; the coil ordered adds up to the coil drawn; and no floor goes over
its surface temperature limit without a warning saying so.

The EN 1264 arithmetic is checked on its own terms too — that the limiting flux over a living
room comes out at the familiar ~100 W/m², that surface temperature and output stay two
readings of the same number, that the log mean is used rather than the arithmetic one, that
carpet costs over half the output, and that opening the pitch out costs far less than
proportionally.

`src/three/scene.test.ts` checks the bend geometry itself — that the torus drawn at a corner
starts exactly where the pipe stops being straight and ends exactly where it resumes, for
turns in plan, at 45°, and from a vertical drop into a horizontal branch. A mis-oriented
bend still looks like a bend from most angles, so it is not something to check by eye.

By hand, `npm run dev` opens on a sample two-storey house. Switch storeys in the left panel
and watch the plan change while the 3D view keeps the whole building; note the ⊗ symbols where
a stack passes through the floor. Drag the kitchen sink along its wall and watch the totals
re-solve; place a fixture upstairs and watch the stack resize; add a storey, draw a room on
it, and undo; tick "Only this storey (3D)" to isolate a floor; save, reload, and confirm the
autosave restores.

Tick off every system but the heating and orbit the 3D view down: the floors go see-through
with the walls, which is the only way to look at anything buried in one, and the coils read
storey by storey. Drag a manifold across the hall and watch every loop on that floor re-draw
around it.

The sample deliberately ships with live warnings — two basins past the EN 12056 unvented run
limit for DN40, a hot dead leg over the EN 806 limit, and a spread of heating loop lengths on
each manifold that its flow meters would struggle to balance — so the validation is visible
rather than theoretical.

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
