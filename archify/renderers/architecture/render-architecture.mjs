import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDiagramWithBrandMarks, writeDiagram } from '../shared/cli.mjs';
import { brandMarkFor } from '../shared/brand-rendering.mjs';
import { createArchitectureScene } from './architecture-scene.mjs';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const layoutJsonMode = process.argv.includes('--layout-json');
const cliArgs = process.argv.filter((arg) => arg !== '--layout-json');
const { diagram: arch, template, outPath, sourceEvidence } = await loadDiagramWithBrandMarks({
  rendererDir: __dirname,
  diagramType: 'architecture',
  defaultExample: 'web-app.architecture.json',
  argv: cliArgs,
});

const scene = createArchitectureScene(arch);
scene.validate();
if (layoutJsonMode) {
  console.log(JSON.stringify(scene.report(), null, 2));
} else {
  writeDiagram({ outPath, template, diagramType: 'architecture', meta: arch.meta,
    svg: scene.renderSvg(), cards: arch.cards, sourceEvidence,
    editorData: { spec: arch, brands: Object.fromEntries(arch.components.filter(c => brandMarkFor(c)).map(c => [c.id, brandMarkFor(c)])) }
  });
}
