---
name: rearchify
description: Refresh existing Archify diagram HTML with the Rearchify fork's renderer so architecture diagrams gain the offline layout editor. Use for /rearchify requests or requests to upgrade an existing diagram to editable HTML, preserving its source and layout.
license: MIT
---

# Refresh existing Archify HTML

Accept `<source.json or existing.html> [output.html]` after `/rearchify`.

This companion uses the `archify` skill installed alongside it from
`safwyls/rearchify`. Locate that skill, first checking the sibling `archify`
directory, then the agent's installed skill locations if necessary. Require
both `bin/archify.mjs` and `references/rearchify.md` in that installation; an
upstream installation without the refresh workflow is not sufficient. If the
fork is missing, explain that both `archify` and `rearchify` must be installed
from `safwyls/rearchify` for the same agent and scope. Do not silently use an
upstream CLI or install packages as part of refreshing a diagram.

Read only that installation's `references/rearchify.md` and follow its refresh
workflow. Run its `deliver` command with the existing typed JSON. Preserve the
source and authored layout, back up existing HTML before replacement, and stop
on validation failure without automatic repair or redesign loops. If an HTML
input has no available source JSON, ask for it rather than reconstructing SVG.

Architecture HTML gains **Edit layout**; other diagram types do not. Report the
delivery result and output path. Browser/perceptual checks are not implied by
delivery. This is an agent entry point, not an additional CLI subcommand.
