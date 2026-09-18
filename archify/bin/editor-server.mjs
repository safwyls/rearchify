import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';
import { resolveOutputPath, pathsAlias } from '../renderers/shared/output-path.mjs';

const run = promisify(execFile);
const cli = fileURLToPath(new URL('./archify.mjs', import.meta.url));
const hash = value => createHash('sha256').update(value).digest('hex');
const read = file => fs.existsSync(file) ? fs.readFileSync(file) : null;
const json = value => JSON.stringify(value).replaceAll('<', '\\u003c');

export function savedEditorSettings(input, output) {
  const file = `${fs.existsSync(output) ? fs.realpathSync(output) : path.resolve(output)}.editor-settings.json`;
  if (pathsAlias(file, input)) throw new Error('Editor settings must not overwrite the source.');
  if (!fs.existsSync(file)) return {};
  const settings = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (settings.input !== fs.realpathSync(input)) return {};
  if (settings.quality !== undefined && !['standard', 'showcase'].includes(settings.quality)) throw new Error('Invalid saved editor quality.');
  if (settings.repoRoot !== undefined && typeof settings.repoRoot !== 'string') throw new Error('Invalid saved repository root.');
  return { quality: settings.quality, repoRoot: settings.repoRoot };
}

// One loopback session owns exactly one source/artifact pair. No client-supplied
// filenames, shell commands, filesystem browsing, or cross-origin access.
export async function startEditorServer({ input, output, quality, repoRoot }) {
  input = fs.realpathSync(input);
  if (path.extname(input).toLowerCase() !== '.json') throw new Error('Editor source must be a JSON file.');
  output = resolveOutputPath({ requestedOutput: output, defaultOutput: 'architecture.html', inputPaths: [input] }).outputPath;
  if (fs.existsSync(output)) output = fs.realpathSync(output);
  const saved = savedEditorSettings(input, output);
  quality ??= saved.quality;
  repoRoot ??= saved.repoRoot;
  if (repoRoot) repoRoot = fs.realpathSync(repoRoot);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const receiptPath = output.replace(/\.html$/i, '.delivery.json');
  if (pathsAlias(receiptPath, input) || fs.existsSync(receiptPath) && fs.lstatSync(receiptPath).isSymbolicLink()) throw new Error('Delivery receipt must have a distinct regular-file target.');
  const flags = ['--json', ...(quality ? ['--quality', quality] : []), ...(repoRoot ? ['--repo-root', path.resolve(repoRoot)] : [])];
  async function deliver(source, target) {
    try {
      const result = await run(process.execPath, [cli, 'deliver', 'architecture', source, target, ...flags], { windowsHide: true, maxBuffer: 8 * 1024 * 1024, timeout: 120000 });
      const receipt = JSON.parse(result.stdout);
      if (!receipt.ok) throw new Error(result.stdout);
      return receipt;
    } catch (error) {
      let diagnostics;
      try { diagnostics = JSON.parse(error.stdout); } catch {}
      const failure = new Error(diagnostics?.error || error.stderr || error.message);
      failure.diagnostics = diagnostics;
      throw failure;
    }
  }
  if (!fs.existsSync(output)) await deliver(input, output);
  const revision = () => hash(Buffer.concat([read(input) || Buffer.alloc(0), Buffer.from('\0'), read(output) || Buffer.alloc(0)]));
  const token = randomBytes(32).toString('hex');
  let origin, busy = false;
  const route = `/${token}/`;
  const server = http.createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Referrer-Policy', 'no-referrer');
    const reply = (status, value) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(value)); };
    if (request.headers.host !== new URL(origin).host) return reply(403, { error: 'Invalid host.' });
    if (request.method === 'GET' && request.url === route) {
      try {
        const source = fs.readFileSync(input), artifact = fs.readFileSync(output);
        const html = artifact.toString('utf8');
        const payload = html.match(/<script[^>]*id="archify-editor-data"[^>]*>([\s\S]*?)<\/script>/);
        if (!payload || !isDeepStrictEqual(JSON.parse(payload[1]).spec, JSON.parse(source))) {
          return reply(409, { error: 'HTML does not match its source JSON. Run deliver on the current source before reopening the editor.' });
        }
        const session = { token, revision: hash(Buffer.concat([source, Buffer.from('\0'), artifact])), saveUrl: `${route}save`, heartbeatUrl: `${route}heartbeat`, input, output };
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        response.end(html.replace('</body>', `<script type="application/json" id="archify-save-session">${json(session)}</script></body>`));
      } catch (error) { return reply(503, { error: `Editor files are unavailable: ${error.message}` }); }
      return;
    }
    if (request.method === 'GET' && request.url === `${route}heartbeat`) {
      if (request.headers['x-archify-token'] !== token || request.headers.origin && request.headers.origin !== origin) return reply(403, { error: 'Invalid save session.' });
      return reply(200, { ok: true });
    }
    if (request.method === 'POST' && request.url === `${route}stop`) {
      if (request.headers['x-archify-token'] !== token || request.headers.origin && request.headers.origin !== origin) return reply(403, { error: 'Invalid save session.' });
      if (busy) return reply(409, { error: 'Delivery is running. Retry stop after it finishes.' });
      reply(200, { ok: true });
      server.close();
      server.closeIdleConnections?.();
      return;
    }
    if (request.method !== 'POST' || request.url !== `${route}save`) return reply(404, { error: 'Not found.' });
    if (request.headers.origin !== origin || request.headers['x-archify-token'] !== token || request.headers['content-type'] !== 'application/json') return reply(403, { error: 'Invalid save session.' });
    if (busy) return reply(409, { error: 'A delivery is already running.' });
    busy = true;
    let sourceCandidate, directory;
    let preserveRecovery = false;
    try {
      const chunks = []; let bytes = 0;
      for await (const chunk of request) {
        bytes += chunk.length;
        if (bytes > 5 * 1024 * 1024) { reply(413, { error: 'Diagram exceeds 5 MB.' }); return; }
        chunks.push(chunk);
      }
      const submitted = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (submitted.revision !== revision()) return reply(409, { error: 'The source or HTML changed on disk. Save a download of your edits, then reload before retrying.' });
      const beforeRevision = submitted.revision;
      sourceCandidate = path.join(path.dirname(input), `.archify-editor-${randomBytes(12).toString('hex')}.json`);
      fs.writeFileSync(sourceCandidate, JSON.stringify(submitted.spec, null, 2) + '\n', { flag: 'wx' });
      directory = fs.mkdtempSync(path.join(path.dirname(output), '.archify-editor-'));
      const candidate = path.join(directory, 'diagram.html');
      const receipt = await deliver(sourceCandidate, candidate);
      if (revision() !== beforeRevision) return reply(409, { error: 'Files changed while delivery was running. No edits were saved; download your draft and reload.' });
      receipt.input = input; receipt.output = output;
      const receiptCandidate = path.join(directory, 'receipt.json');
      fs.writeFileSync(receiptCandidate, JSON.stringify(receipt, null, 2) + '\n');
      const targets = [input, output, receiptPath];
      const backups = targets.map((target, index) => {
        const bytes = read(target);
        const backup = path.join(directory, `backup-${index}`);
        if (bytes !== null) fs.writeFileSync(backup, bytes);
        return { target, backup, existed: bytes !== null };
      });
      let committed = 0;
      try {
        for (const [index, staged] of [sourceCandidate, candidate, receiptCandidate].entries()) {
          fs.renameSync(staged, targets[index]); committed++;
        }
      } catch (error) {
        for (const item of backups.slice(0, committed).reverse()) {
          try { if (item.existed) fs.copyFileSync(item.backup, item.target); else fs.unlinkSync(item.target); }
          catch { preserveRecovery = true; }
        }
        if (preserveRecovery) {
          fs.writeFileSync(path.join(directory, 'recovery.json'), JSON.stringify(backups, null, 2));
          throw new Error(`Save failed and rollback needs attention. Backups: ${directory}`);
        }
        throw error;
      }
      reply(200, { ok: true, revision: revision(), receipt });
    } catch (error) {
      reply(422, { error: error.message, diagnostics: error.diagnostics });
    } finally {
      if (sourceCandidate && fs.existsSync(sourceCandidate)) fs.unlinkSync(sourceCandidate);
      if (directory && !preserveRecovery) fs.rmSync(directory, { recursive: true, force: true });
      busy = false;
    }
  });
  // Durable settings are separate from ephemeral process state and survive stop.
  const settingsPath = `${output}.editor-settings.json`;
  if (fs.existsSync(settingsPath) && fs.lstatSync(settingsPath).isSymbolicLink()) throw new Error('Editor settings must be a regular file.');
  fs.writeFileSync(settingsPath, JSON.stringify({ input, output, quality, repoRoot }, null, 2) + '\n', { mode: 0o600 });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${server.address().port}`;
  return { server, url: origin + route, input, output };
}

export async function commandEdit(args) {
  if (!args.length || args[0] === '--no-open' || !['start', 'stop', 'status', 'architecture'].includes(args[0])) {
    return (await import('./editor-discovery.mjs')).commandDiscover(args);
  }
  if (['start', 'stop', 'status'].includes(args[0])) {
    return (await import('./editor-session.mjs')).commandSession(args);
  }
  const [type, input, output, ...options] = args;
  if (type !== 'architecture' || !input || !output) throw new Error('Usage: archify edit architecture <input.json> <output.html> [--quality standard|showcase] [--repo-root path]');
  const settings = { input, output };
  for (let i = 0; i < options.length; i += 2) {
    if (!['--quality', '--repo-root'].includes(options[i]) || !options[i + 1]) throw new Error('Unknown or incomplete edit option.');
    settings[options[i] === '--quality' ? 'quality' : 'repoRoot'] = options[i + 1];
  }
  if (settings.quality && !['standard', 'showcase'].includes(settings.quality)) throw new Error('Quality must be standard or showcase.');
  const session = await startEditorServer(settings);
  console.log(`Local editor: ${session.url}\nSource: ${session.input}\nOutput: ${session.output}\nKeep this process running while editing. Ctrl+C stops the save service.`);
}
