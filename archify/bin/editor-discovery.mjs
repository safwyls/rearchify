import fs from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { commandSession } from './editor-session.mjs';
import { openEditorUrl } from './open-artifact.mjs';

export function discoverDiagrams(directory) {
  const root = fs.realpathSync(directory), documents = new Map(), pairs = new Map();
  const inside = file => { const relative = path.relative(root, file); return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative); };
  const walk = folder => {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      if (entry.isSymbolicLink() || entry.name.startsWith('.') || ['node_modules', 'vendor', 'coverage'].includes(entry.name)) continue;
      const file = path.join(folder, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile() && entry.name.endsWith('.json') && fs.statSync(file).size <= 5 * 1024 * 1024) {
        try { documents.set(file, JSON.parse(fs.readFileSync(file, 'utf8'))); } catch {}
      }
    }
  };
  walk(root);
  const sources = new Map([...documents].filter(([, value]) => value?.diagram_type === 'architecture' && Array.isArray(value.components)));
  const add = (input, output, options = {}) => {
    if (!inside(output) || !output.endsWith('.html')) return;
    const key = input + '\0' + output;
    pairs.set(key, { input, output, title: sources.get(input).meta?.title || path.basename(input), ...pairs.get(key), ...options });
  };
  for (const [file, value] of documents) {
    if (!value || typeof value.input !== 'string' || typeof value.output !== 'string') continue;
    const editorMetadata = file.endsWith('.editor-session.json') || file.endsWith('.editor-settings.json');
    if (!(value.ok && value.command === 'deliver' && value.type === 'architecture') && !editorMetadata) continue;
    const input = path.resolve(root, value.input), output = path.resolve(root, value.output);
    if (sources.has(input) && fs.existsSync(output) && !fs.lstatSync(output).isSymbolicLink()) {
      const options = editorMetadata ? { quality: value.quality, repoRoot: value.repoRoot } : { quality: value.validation?.compositionProfile };
      const previous = pairs.get(input + '\0' + output);
      add(input, output, editorMetadata ? options : { ...options, ...previous });
    }
  }
  for (const [input, spec] of sources) {
    if ([...pairs.values()].some(pair => pair.input === input)) continue;
    const meta = typeof spec.meta?.output === 'string' ? spec.meta.output : '';
    const candidates = [...new Set([meta && path.resolve(path.dirname(input), meta), meta && path.resolve(root, meta), input.replace(/\.json$/, '.html')].filter(Boolean))];
    // Only associate existing HTML if it contains an architecture editor payload.
    const existing = candidates.filter(file => {
      if (!inside(file) || !fs.existsSync(file) || !fs.lstatSync(file).isFile()) return false;
      try {
        const payload = fs.readFileSync(file, 'utf8').match(/<script[^>]*id="archify-editor-data"[^>]*>([\s\S]*?)<\/script>/);
        return payload && JSON.stringify(JSON.parse(payload[1]).spec) === JSON.stringify(spec);
      } catch { return false; }
    });
    if (existing.length) existing.forEach(output => add(input, output));
    else {
      const output = input.replace(/\.json$/, '.html');
      if (!fs.existsSync(output)) add(input, output);
    }
  }
  return [...pairs.values()].sort((a, b) => a.input.localeCompare(b.input) || a.output.localeCompare(b.output));
}

export async function commandDiscover(args) {
  const positional = args.filter(arg => arg !== '--no-open');
  if (positional.length > 1 || positional[0]?.startsWith('-')) throw new Error('Usage: archify edit [source.json or output.html] [--no-open]');
  let choices = discoverDiagrams(process.cwd());
  if (positional[0]) {
    const selected = path.resolve(positional[0]);
    choices = choices.filter(item => item.input === selected || item.output === selected);
  }
  if (!choices.length) throw new Error('No architecture diagrams found in this project. Use archify edit start architecture <source.json> <output.html> for explicit paths.');
  let chosen = choices[0];
  if (choices.length > 1) {
    const listing = choices.map((item, index) => `${index + 1}. ${item.title}: ${path.relative(process.cwd(), item.input)} -> ${path.relative(process.cwd(), item.output)}`).join('\n');
    if (!process.stdin.isTTY) throw new Error(`Choose a diagram by running archify edit <output.html> (or the source JSON for a new output):\n${listing}`);
    console.log(listing);
    const prompt = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const answer = (await prompt.question('Diagram number (Enter to cancel): ')).trim();
      if (!answer) return;
      const index = Number(answer) - 1;
      if (!Number.isInteger(index) || !choices[index]) throw new Error('Invalid diagram number.');
      chosen = choices[index];
    } finally { prompt.close(); }
  }
  const options = [...(chosen.quality ? ['--quality', chosen.quality] : []), ...(chosen.repoRoot ? ['--repo-root', chosen.repoRoot] : [])];
  const session = await commandSession(['start', 'architecture', chosen.input, chosen.output, ...options], { quiet: true });
  console.log(`Editor: ${session.url}\nSource: ${session.input}\nStop: archify edit stop "${path.relative(process.cwd(), session.output)}"`);
  if (!args.includes('--no-open')) {
    const opened = openEditorUrl(session.url);
    if (opened.status !== 'opened') console.error('Could not open a browser. Open the editor URL above.');
  }
}
