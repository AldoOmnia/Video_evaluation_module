# Camera support generator

`/fixture/` — takes a point-cloud scan of a station in which a vision camera
sits where it has to stay, and generates a permanent support for it that
replaces the temporary arm it was scanned on. The camera pose is an input and
is never moved by anything on the page.

## What the user does

1. **Scan** — open a `.ply` (ASCII or binary, with or without colour). It is
   read in the browser and not uploaded. Y-up scans are turned Z-up. Which way
   is up cannot always be read from a file: a Gaussian splat keeps the axes of
   the cameras it was trained from (Y pointing down), so a splat whose
   vertical axis is Y is turned over on opening, and the page says what it
   did. **Flip upside down** corrects a wrong guess; the camera pose, anchors
   and arm corrections turn with the scan.
2. **Camera pose** — click the camera, click what it looks at, adjust with the
   move/rotate handles until the model sits on the scanned one, then **Lock**.
   *Auto-locate* sends three renders of the scan to the vision model and
   proposes a pose; it is a suggestion to check, never applied as locked.
3. **Temporary arm** — found by flooding out from the camera through connected
   scan points and stopping at support surfaces. Tinted in the view, left out
   of the obstacle map. Two brushes correct it.
4. **Anchor points** — click up to four surfaces the support may bolt to. Each
   gets a plane fit; a surface that is not flat says so. **Ring on a round
   face** is the other kind of anchor: click anywhere on a flat round face — a
   flange, the rim of a bore — and the whole face is measured (centre, axis,
   inner and outer edge). The support then stands on a ring lying on that
   face, with its legs landing on the ring under the camera.
5. **Structure** — *Camera held by* chooses what grips the camera (below);
   sliders reshape the support live. The assistant sets them from a typed
   request.
6. **Export** — OBJ (mesh, mm) or STEP (solid, AP242, mm) for Siemens NX.

**Variations**, at the top of the right-hand column, are different designs for
the same locked camera: a plate against a sleeve, a ring against bolted feet.
*New variation from this one* leaves the design on screen as it is and
continues on a copy. Each keeps its own anchors, holder, material and slider
values; the scan, camera pose, target and arm are shared. Click a name to
show that one, type in the name on screen to rename it, × twice to remove it.
Up to twelve. Exports are named after the variation on screen.

## What is saved

The scan is never stored. What was decided about it is: camera model and pose,
target, arm corrections, and every variation's anchors and slider values, a
few hundred numbers.
The page writes them half a second after any change to `localStorage` and to
`PUT /api/fixture/setup`, keyed by the scan's file name and point count, and
says under the scan when and where it saved. Opening the same file again, in
any browser, brings the setup back; **Start over** deletes both copies.

**A named link** keeps a setup under a name. *Save as link* writes it and
opens `/fixture/<name>` — `Comer cognex camera 2800` is
`/fixture/comer-cognex-camera-2800`. The scan file is not in the link: the
page names the file to open, and once that file is open the pose, the anchors
and every variation come from the link. Later changes update the link, so
anyone with the address sees them. Renaming does not change the address. A
name that is already used is refused rather than overwritten. **Delete link**
removes it; the setup saved against the scan file stays. On a link, **Start
over** is not offered, because opening the link would bring the setup back.

Server copies are files under `backend/.fixture-setups/` (gitignored: they are
a client's station coordinates). On a host without a persistent disk they last
until the next deploy; the browser's copy remains.

The server counts revisions. Every write names the revision it started from,
and one based on an older revision is refused (409): a tab left open while the
setup was changed in another cannot overwrite the newer work. That page says
so and offers **Load the newer version**; until then its changes stay in that
page only.

A setup saved before holders and variations existed opens as one variation on
a plate with no cable room — the design as it was drawn — and is not rewritten
until something is changed.

## The camera

The two Cognex entries in `shared/data/fixture-params.json` are taken from the
*In-Sight 2800 Reference Manual*: the Multi Torch (p. 19) as a 69 × 66 mm light
head in front of a 42.4 × 23.6 mm body, the Mini 6.2 mm (p. 16) as the body
alone. Both bolt through four M3 holes, 37.0 mm across and 21.1 mm along, in
the bottom plate 11.1 mm below the optical axis; the threads are 4 mm deep. The
support's plate is placed on that pattern, the support stays out of both
solids, and the fields for body, holes and face are locked for these models.
Lens options carry the diagonal field of view from the manual's
working-distance tables. *Custom* is a plain box with the plate centred on the
chosen face.

### What holds it

| Holder | What is built |
| --- | --- |
| Plate | A flat plate on the bolt pattern. The four M3 screws carry everything. |
| Cradle, open top | The plate grown into a floor and two side walls round the body. The camera drops in from above. |
| Sleeve, camera slides in | Floor, walls and roof: a tube open at both ends. The body goes in connectors first until the front of the camera meets it. The default for a new design. |

A cradle or sleeve is the plate grown round the camera, so the mounting face,
the four screws and the camera's position are the same in all three. The floor
touches the camera's bottom plate; sides and roof stand 0.3 mm off the body.
Walls are 0.6 × *Plate / floor* thickness, between 3 and 8 mm. *Grip length*
(40–80 mm, centred on the bolt pattern) is how much of the body is wrapped; it
is cut short at the camera's `grip_mm` range so the holder never reaches the
connectors or covers the lights. On the Multi Torch that leaves the last 21 mm
of the body, with both M12 connectors, outside the holder.

The walls take the camera's weight and any knock sideways; **along its own
axis the camera is held by the four screws**, in every style. There is no lip
in front (it would cover the lights) and none behind (it would cover the
connectors). A camera pointing steeply down hangs on those screws.

*Cable room* keeps a box straight behind the connectors empty: struts are
routed round it and anything that reaches into it is cut away. Cognex asks for
150 mm of straight cable before the first bend (the default); it is drawn
dashed in the view. At 0 nothing is kept, and the page says so.

Cradle and sleeve need a camera with a drawn body; for *Custom* the control is
off and says why.

## How a structure is made

All of it is in `eval-lab/public/assets/fixture/core/`, plain ES modules with
no dependencies, so the same code runs in the page's worker and in Node tests.

| Step | File | What it does |
| --- | --- | --- |
| Layout | `skeleton.js` | A trunk from the camera's mounting face to a branch point, legs to each anchor, optional cross ties. Routed away from the scan (distance field, `field.js`), out of the camera's view cone and clear of the camera body. On a ring anchor the legs land on the ring's mid radius, side by side under the camera, *base spread* apart. |
| Sizing | `frame.js` | 3D beam finite-element model, solid round sections. Three 1 g load cases. Strut radii are scaled until the camera's worst deflection meets the rigidity target; thickness follows the bending moment. |
| Solid | `generate.js` | Round cones per strut, the plate, cradle or sleeve (`deriveHolder`), foot pads, bolt holes and tool-access channels — or, on a ring anchor, the flat ring in place of pads — as one implicit solid with smooth blends. The camera's pocket and the cable room are cut out last. |
| Mesh | `surface.js` | Surface nets, 4 mm cells while dragging, 2 mm when the slider stops, 1 mm for export. Closed, single body, manifold. |

The rigidity slider is the deflection target: `2 mm × 10^(−rigidity/50)`.

### Round faces

`fitRing` in `scan.js` finds the face under a click in four steps: the planes
that collect the most scan points round the click (so a narrow rim is not
tilted by the wall below it); the scan material in each plane connected to the
click, on a 6 mm grid; the circle that the outline of that material follows
furthest round; and from that circle's centre, where the face starts and stops
in every direction, placed to about 2 mm from the points themselves. Parts
lying on the face and neighbours at the same height are outvoted by the
directions that agree. A face that is not round is refused with the reason.

The ring is centred on the face. *Ring width* is a share of the face's own
width (100 covers it edge to edge), *ring thickness* its height. The beam
model treats the ring as clamped to the face all the way round.

## The AI parts, exactly

- **Assistant** (`POST /api/fixture/assist`, Claude). Proposes slider values,
  a material and a holder. The page measures every proposal with the solver before it
  is applied; one that misses a limit stated in the request goes back with its
  measured result, up to two times. The before/after numbers under the reply
  come from the solver, not from the model.
- **Auto-locate** (`POST /api/fixture/locate`, Gemini vision). Receives
  rendered views, not the scan. Points at the camera and its target in each;
  the page keeps what at least two views agree on.
- **Arm removal and the structure itself are not language-model output.** The
  arm is found geometrically; the structure is a deterministic solver. The same
  inputs always give the same part.

## Exports

- **OBJ** — the blended form exactly as drawn, 1 mm cells, millimetres. NX
  opens it as a convergent (facet) body.
- **STEP** — built by OpenCascade (`replicad`) in `backend/workers/fixture-step.mjs`:
  one smooth loft per strut, joined at shared nodes, with the plate, pads or
  ring and every bolt hole as exact faces. The soft blends between struts are
  **not** in the STEP, so its volume is a few percent under the mesh. 5–45 s.
  The kernel's joins do not always fail loudly, so each one is checked by
  volume, retried with the part nudged by hundredths of a millimetre, and a
  lofted strut that still will not join is rebuilt from straight segments. A
  file with a part or a cut missing, or in more than one piece, is refused
  rather than sent. Cuts are made one at a time: the tools overlap (the pocket
  lies inside the camera's keep-out) and a cut by all of them at once left
  loose bodies behind.
  The kernel needs about 500 MB while it builds, so `/api/fixture/capabilities`
  reports STEP unavailable on a host with less than 900 MB (Render's starter
  plan is 512 MB). `FIXTURE_STEP=on|off` overrides.

## Limits to know before cutting metal

- Deflection, tilt and first mode come from a **beam model**. They are sizing
  estimates. Run the exported solid through NX Nastran (or equivalent) before
  it is made.
- A ring base has **no fixing holes**. How it is held to the face — which of
  the part's own bolts, how many, at what angle — is on the part's drawing,
  not in the scan. Add them in NX. The sizing assumes the ring is held all the
  way round; three or four bolts are not that.
- A ring's diameters are measured from the scan, to a few millimetres on a
  clean face. Check them against the drawing before the ring is cut.
- Sections are **solid**. A long reach from one anchor gets heavy (several kg
  in aluminium at 1.4 m). Hollow sections are not implemented.
- Camera weights are Cognex's: 141 g (6.2 mm lens), 169 g (16 mm lens), 290 g
  (Multi Torch). A right-angle configuration adds 50 g: type the total in.
- The camera body is two boxes from the manual's outline drawing. A cradle's
  or sleeve's pocket is that outline plus 0.3 mm: 43.0 × 23.9 mm for the
  2800. The real housing has ribs, steps and a narrower neck that the drawing
  does not dimension, and where the connectors begin (`grip_mm`) was scaled
  from the drawing to about a millimetre. **Check the pocket against Cognex's
  CAD model of the camera before the part is made.**
- A sleeve printed in one piece needs its 0.3 mm fit checked on the printer
  it will be made on.
- A phone LiDAR scan resolves a 110 mm camera as a blob. The pose is as good
  as the user's alignment of the model to the scan; nothing here measures it
  to better than the scan's own accuracy.
- The page is English only; the assistant answers in the platform language.

## Checks

```
node tools/test-fixture.mjs                       # core: solver, mesher, scan handling, exports
npm run dev                                       # then, in another terminal:
node tools/check-fixture-page.mjs                 # the page in a real browser
node tools/check-fixture-page.mjs --step --ai     # also STEP and the AI endpoints (spends tokens)
```
