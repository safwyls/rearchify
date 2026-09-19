## `/rearchify`: refresh an existing diagram

Treat `/rearchify <source.json or existing.html> [output.html]` as a request to
rerun delivery with this fork's installed renderer. This refresh path takes
precedence over the fresh-authoring and visual-polish loops below. It adds the
current **Edit layout** functionality to architecture HTML without reauthoring
the diagram. Other diagram types can be redelivered but do not gain the editor.

1. Locate the existing typed JSON, preferring the user's latest saved JSON over
   an older source. For an HTML input, look for its original JSON or delivery
   receipt beside it or in the current task. Legacy HTML may not contain the
   source; if it cannot be found, ask for the JSON rather than reconstructing it
   from SVG. If several sources plausibly match, ask which one to use.
2. Determine the diagram type from the source. Preserve its contents, IDs,
   geometry, language, schema version, and quality profile. Use this fork's
   `bin/archify.mjs`, not an upstream installation. Resolve input/output paths
   before running from the skill directory. Use the requested output, otherwise
   the supplied HTML path, or a sibling `.html` for JSON input. Before replacing
   existing HTML, retain a backup at a new, unused sibling path.
3. Run once (shown for architecture):

   ```bash
   node bin/archify.mjs deliver architecture "<source.json>" "<output.html>" --json
   ```

   Preserve any explicit quality override and repository root from the original
   delivery when known; otherwise let the source's quality profile/default apply.
   Do not force `showcase` for a refresh. On failure, report the diagnostics and
   stop; do not change the diagram, lower validation requirements, or start a
   layout-repair loop unless the user requests repairs.
4. On success for a local architecture diagram, run
   `node bin/archify.mjs edit start architecture "<source.json>" "<output.html>"`
   with the same delivery options. For explicitly requested hostname access or
   SSH forwarding, read `references/remote-editor.md` and pass the network options. Return its live editor URL, the standalone
   output and receipt, and `node bin/archify.mjs edit stop "<output.html>"`.
   Follow the local-service fallback rules in `references/editor-handoff.md` for static-only or
   unsupported environments. Users choose **Edit layout**, **Apply & close**,
   then **Save & deliver** to persist changes. Report browser/perceptual
   checks as not run unless actually performed. Additional visual review is
   optional for this refresh, not a trigger for redesign. Subsequent browser
   edits remain drafts until the saved JSON passes delivery again.

This is an agent instruction, not a new CLI subcommand. Install both `archify`
and the companion `rearchify` skill from `safwyls/rearchify` for the same agent
and scope. Copilot exposes the companion as `/rearchify` automatically.
The bundled `prompts/rearchify.prompt.md` remains an optional fallback for
clients supporting prompt files but not skill slash commands. Use one entry
point to avoid duplicate command names. In other clients, invoke Archify and
include `/rearchify` with the source path in the request.
