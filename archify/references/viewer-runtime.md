# Viewer Runtime reference

Read this only when the user asks for a reader-facing capability. Ordinary generation does not require implementing or re-documenting these features; they are already in the generated HTML.

## Exploration

### Architecture layout editing

New architecture HTML includes an offline **Edit layout** dialog. Drag nodes to
move them; turn off **Snap to 10px grid** for free placement. Drag empty canvas to
pan, scroll to zoom, and use **Fit** to see the whole diagram. Right-click a node
and choose **Relabel**, or double-click it. Arrow keys on the canvas move
the selected node by 1px (Shift: 10px). Undo/redo keeps the last 50 transactions;
Ctrl/Cmd+Z and Ctrl/Cmd+Shift+Z work outside text inputs.

Select a path on the canvas to reveal its corner
handles. Drag a segment perpendicular to its direction to move that part of the
route; drag a circular corner handle to reshape adjoining segments. Endpoints
stay attached to their nodes, and endpoint-segment drags create elbows when needed.
Right-click a path segment for **Add jog**, **Remove jog segment**, **Relabel**,
**Auto route**, **Auto label**, and **Snap labels to path**. Removing an interior
segment joins its corners and simplifies the resulting detour while keeping
endpoints attached. Bringing adjacent corner handles within 10 screen pixels
also merges them; dragging away before release restores the original shape.
Dragging a segment within 10 screen pixels of a neighboring parallel segment
on the same path aligns them and removes the intervening jog. Hold Alt to
bypass this merge, or drag away before release to restore the jog.
Select a path and drag either blue square endpoint handle to reposition its
attachment along the connected node's perimeter; dragging around a corner
changes sides. Attachments follow node moves and are saved as `fromSide` /
`toSide` plus `fromOffset` / `toOffset` fractions (0–1 from top or left).
Auto route clears these attachment pins along with manual bends.
Corner and endpoint drag previews collapse overlapping out-and-back legs,
including partial backtracks, while preserving the pinned endpoint directions.

Right-click empty canvas and choose **Draw boundary**, then drag its rectangle.
Select an existing boundary by its border or title; drag either to move the
frame, or drag its corner handles to resize it. Its context menu supports
relabeling, switching between region and security-group, and deletion.
Escape cancels a boundary drag. All edits support undo/redo and saved HTML/JSON.
Drawn or manually adjusted boundaries use `rect: [x, y, width, height]` and
update `wraps` to the fully enclosed nodes. These frames stay fixed; untouched
boundaries continue to size automatically around their members.

**Apply & close** updates only the currently open page; it does not overwrite
files. It reloads the page and restores a tab-local draft before the reader
initializes, preserving edit history and the local save revision. Browser
session storage is required for Apply; downloads remain available if storage
is blocked. The temporary transfer is consumed on that reload.

**Download HTML** saves a standalone editable copy, including
the edited spec and history, which can be reopened later. **Save JSON** downloads
the edited source for regeneration and full CLI delivery checks. The edited
diagram notice describes validation status independently of whether a copy was
saved; browser layout checks do not replace the full delivery workflow.

For direct overwrite from the main view, start the local save service:

With the CLI installed on your command path, run `archify edit` from a project.
It discovers architecture JSON, uses delivery receipts/session metadata to find
existing HTML, and opens the editor in your browser. Multiple diagrams get a
numbered terminal chooser. Use `archify edit path/to/diagram.json` (or its HTML)
to select directly, or add `--no-open` to print the URL without opening a browser.
Without a terminal, ambiguous discovery prints the choices and asks for a path.
Dependency and hidden folders are skipped. For explicit paths or validation options:

```bash
node archify/bin/archify.mjs edit start architecture path/to/source.json path/to/diagram.html --quality showcase
```

The command returns JSON with a localhost URL and starts a hidden background
process. Repeating it with the same paths and validation settings reuses the
service. Local architecture skill handoffs run it after delivery by default.
Session metadata lives beside the output in `<output.html>.editor-session.json`;
it is local process state, not part of the portable artifact. Do not distribute it.
Validation options persist separately in `<output.html>.editor-settings.json` so
discovery and restart retain the same quality and repository root after stopping.
Keep this local settings file private too. A page request rejects HTML whose
embedded source no longer matches the JSON; redeliver external edits first.
Missing source/artifact files return a recoverable error without stopping the service.
Use `archify edit status <output.html>` and `archify edit stop <output.html>`
(or `node bin/archify.mjs ...` from the skill directory) to inspect or stop it.
Stop refuses while a delivery is in progress; retry after it finishes.
Closing a tab does not stop the process. For a foreground service with Ctrl+C,
omit `start`: `archify edit architecture <input.json> <output.html>`.

Open the printed localhost URL. Edit, choose
**Apply & close**, then **Save & deliver** in the main toolbar. This button appears
only for an edited draft with a successful service heartbeat. Liveness is checked
every five seconds with a two-second timeout; standalone HTML and delivered
diagrams hide it. Editor toolbar buttons show brief pressed feedback on activation.
The service runs
the normal `deliver` command against a staged specification. Only after delivery
passes does it replace the source JSON and HTML and write an adjacent
`.delivery.json` receipt with their hashes. It then reloads the verified diagram.
Failed validation leaves the original files intact. A changed source or HTML
rejects a stale save; download the draft before reloading to resolve the conflict.
File-write failure rolls back committed files, retaining recovery backups if
rollback itself fails. These deterministic delivery checks do not include
automated browser evidence or perceptual visual review.

The service binds to loopback by default, exposes one configured file pair, and uses
a per-session token plus same-origin requests. Standalone downloads omit the
live save session and continue to support offline editing. Restart the start
command to edit and save later. Direct `deliver` calls never start a service.
Moving a node into or out of a fixed frame updates its membership too. CLI
validation rejects fixed frames whose `wraps` disagree with the enclosed nodes.
Explicit rectangles never expand to fit a label; shorten the label or resize
the frame when layout checks report insufficient title space.
**Auto route** removes manual bends and side constraints; **Auto label** restores
automatic label placement.

Label snapping is enabled by default. Drag the label's center within 12 screen
pixels of one of its own path segments to snap onto it; the target segment is
highlighted during the drag. Turn **Snap labels to path** off in the context menu
or hold Alt while dragging for free placement. Snapped labels follow segment moves,
including inserted endpoint elbows. This option persists in saved HTML. Free labels
remain independent. Right-click a label for the same path actions.

Keyboard users can Tab to a node/path/label and press Shift+F10 or the Menu key.
Use arrows, Home/End, and Enter in the menu; Escape dismisses the menu or relabel
panel without closing the editor. Global undo/redo, grid snapping, Fit, Check,
Save JSON, Download HTML, Apply, and Cancel remain in the top toolbar.
All of these changes participate in undo/redo and JSON/HTML downloads.

**Apply & close** updates the reader and resets its transient navigation state.
**Cancel** (or Escape) discards that editing session. **Save JSON** downloads the
source specification; **Download HTML** saves a standalone editable draft with
its history. Downloads do not overwrite the original files. Changed grid nodes
get explicit `pos` coordinates, so subsequent CLI renders preserve placement.

Automatic routes, relationship labels, wrapping boundaries, and implicit viewBox
bounds are recalculated by the shared architecture renderer. Manual routes are
saved as `via` points and endpoint sides. Free labels use `labelAt`; snapped labels
use `labelSegment` plus relative offsets. Moving a connected node adjusts adjoining bends to keep the route
orthogonal; interior bends and independent label positions otherwise stay fixed.
Explicit viewBox constraints remain in force. **Check layout** reports the
renderer diagnostics; reposition or undo when an edit introduces collisions.
The editor permits draft saves with diagnostics. It does
not add/remove nodes or edges, resize nodes, or edit other diagram types.

Browser checks cover renderer layout constraints, not all delivery acceptance
checks. Revalidate saved JSON before treating an edited diagram as checked:

```bash
node bin/archify.mjs validate architecture architecture-edited.json --quality showcase --json
node bin/archify.mjs deliver architecture architecture-edited.json architecture-final.html --quality showcase --json
```

Embedded brand artwork remains available offline while editing. Normal CLI
delivery still checks pinned remote brand references through its existing path.

### Reader controls

- Diagram Guide lists current actions and shortcuts.
- Reading Depth starts at READ at the default 100% scale, reveals FULL detail at 175%, and falls back to MAP only below 100%. Focus, story, route, and semantic interactions reveal their exact facts at any scale.
- Semantic Lens summarizes selected node/relationship kinds without changing authored geometry.
- Intent Trace previews a fine-pointer or keyboard target before committed focus.
- Node Finder searches labels and stable IDs.
- Semantic Passport opens on focus, shows authored upstream/downstream facts, supports a copyable deep link, has an explicit close action, closes on true outside activation and Escape, and never enters canonical export.
- Semantic Radar mirrors the visible viewport and authored graph without becoming a second source of truth.
- Direct Relationship Pin makes a unique compiled relationship operable while preserving the authored line and stable relationship identity. It must fail closed on conflicting source/target/label/ID metadata.
- Route Probe resolves exactly two endpoints over authored directed relationships. It never infers a route from geometry.

## Guided views and story

`meta.views` may define at most five curated chapters using stable node IDs. The Named Chapter Rail, Chapter Delta Preview, Story Beat Navigator, Story Follow Camera, Story Director Strip, Story Horizon, and Shareable Story Moment links all derive from that one authored array; none owns parallel topology or layout.

Story transitions classify only the exact relationship between adjacent authored stops: forward, reverse, multiple, or grouped/no direct link. Never infer a transitive edge, verb, causality, or runtime behavior from proximity, kinds, or story order. Playback is reader-started, bounded, stale-safe, and motion-governed.

## Motion and presentation

`meta.animation: "trace"` enables a finite reader-controlled Live/Still trace. Static is the default. Still, reduced motion, page hiding, print, and canonical export preserve complete static meaning. Presentation Stage changes viewer chrome and framing, never authored geometry. This is not a mobile product feature; narrow layouts get containment only.

## Canonical exports

The export menu can copy/download full-diagram PNG, download JPEG/WebP, download a dual-theme SVG, and record a trace-enabled WebM. Viewer state—Guide, Lens, finder, focus, route, story, camera, radar, presentation, motion ownership, and temporary overlays—must be removed from canonical export.

### Share Card

The optional 1200×630 Share Card PNG is for README, release, social, or launch previews. It uses the current theme and visual preset, contains the complete canonical diagram without cropping, and never claims validation. Copy Share Card reuses the same canonical PNG when clipboard image writes are supported.

### Route Share Card

After a real directed Route Probe resolves, the reader may use **Export → Route Share Card**. It reuses the exact ordered route snapshot and the shared Share Card seam: `format=share-card`, `variant=route`. The isolated clone may use only static `data-share-route-*` decoration. It is download-only, fails closed for stale/unreachable/conflicting routes, and never becomes the canonical artifact.

### Reach Share Card

After a non-empty authored reachability query, the reader may use **Export → Reach Share Card**. It consumes the already resolved upstream/downstream node and edge set without rerunning traversal: `format=share-card`, `variant=reach`. The isolated clone may use only static `data-share-reach-*` decoration. It is download-only. Call it authored reachability—not impact, blast radius, breakage, or runtime causality.

## Truth boundary

Viewer exports are communication assets. They do not replace the checked HTML, the deterministic delivery receipt, or a real visual review. Do not add a hosted service, storage surface, dependency, schema branch, or mobile product surface for these viewer-only capabilities.

For explicitly requested remote access, see [hostname binding and SSH forwarding](remote-editor.md). Non-loopback binding requires TLS unless the user explicitly requests `--allow-insecure-http`; exact browser-origin checks apply in both modes.
