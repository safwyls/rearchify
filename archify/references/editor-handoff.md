# Local editing handoff

For a local architecture handoff, after successful delivery and browser/visual
review, start the background editing service:

```bash
node bin/archify.mjs edit start architecture "<input.json>" "<output.html>"
```

Pass the same explicit `--quality` and `--repo-root` options used for delivery.
Return the command's live editor URL alongside the standalone HTML and source
paths. This is the default local architecture handoff, including `/rearchify`;
it lets the user edit and save back through delivery. Repeated starts reuse a
matching live service. Do not start it for other diagram types, CI/static-only
requests, or environments without a persistent local process. If startup fails,
still return the delivered files, report that direct saving is unavailable, and
give the start command. Do not claim the service is running without a successful
result. The service continues until explicitly stopped or the host exits; closing
the tab does not stop it. To manage it later:

```bash
node bin/archify.mjs edit status "<output.html>"
node bin/archify.mjs edit stop "<output.html>"
```

The low-level `deliver` command stays deterministic and does not spawn services.
For later use from a project with the CLI on PATH, `archify edit` discovers local
architecture diagrams and opens the editor, offering a chooser when needed.
