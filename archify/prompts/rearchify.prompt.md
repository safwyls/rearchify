---
description: Refresh existing Archify HTML with the Rearchify renderer and architecture editor.
agent: agent
argument-hint: <source.json or existing.html> [output.html]
---

Use the installed Archify skill from the safwyls/rearchify fork and follow its
`/rearchify` refresh workflow for the paths supplied by the user. In the fork
repository, the skill is at `archify/SKILL.md`; in other workspaces, locate the
installed skill. If only the upstream version is available, explain that the
fork is required instead of claiming its output has an editor.

Rerun `deliver` on the existing typed JSON using the fork's CLI. Preserve source
and layout, retain a backup before replacing HTML, and stop on failed delivery
without automatic repair iterations. Architecture diagrams gain **Edit layout**;
other diagram types do not. If an HTML input has no available source JSON, ask
for the source rather than reverse-engineering the generated HTML.
