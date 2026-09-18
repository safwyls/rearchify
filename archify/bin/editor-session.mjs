import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startEditorServer, savedEditorSettings } from './editor-server.mjs';
import { pathsAlias } from '../renderers/shared/output-path.mjs';

const self = fileURLToPath(import.meta.url);
const statePath = output => (fs.existsSync(output) ? fs.realpathSync(output) : path.resolve(output)) + '.editor-session.json';
const read = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
async function request(state, action, method = 'GET') {
  // Session files are data, never permission to contact an arbitrary host.
  const url = new URL(state.url);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !/^\/[a-f0-9]{64}\/$/.test(url.pathname)) throw new Error('Invalid local editor session URL.');
  const token = url.pathname.split('/')[1];
  return fetch(new URL(action, url), { method, headers: { 'X-Archify-Token': token }, signal: AbortSignal.timeout(2000), redirect: 'error' });
}
async function alive(state) {
  if (!state?.url) return false;
  try { const response = await request(state, 'heartbeat'); return response.ok && (await response.json()).ok === true; } catch { return false; }
}

export async function commandSession(args, { quiet = false } = {}) {
  const [action, ...rest] = args;
  if (action === 'stop' || action === 'status') {
    if (rest.length !== 1) throw new Error(`Usage: archify edit ${action} <output.html>`);
    const file = statePath(rest[0]), state = read(file);
    if (!await alive(state)) {
      console.log(JSON.stringify({ running: false, output: path.resolve(rest[0]) }));
      return;
    }
    if (action === 'stop') {
      const response = await request(state, 'stop', 'POST');
      if (!response.ok) throw new Error((await response.json()).error);
      // The server owns removal of its session file, so a later start cannot
      // accidentally have its new metadata deleted by this command.
      console.log(JSON.stringify({ running: false, output: state.output }));
    } else console.log(JSON.stringify({ ...state, running: true }));
    return;
  }
  const [type, input, output, ...options] = rest;
  if (type !== 'architecture' || !input || !output) throw new Error('Usage: archify edit start architecture <input.json> <output.html> [--quality standard|showcase] [--repo-root path]');
  const settings = { ...savedEditorSettings(input, output), input: fs.realpathSync(input), output: path.resolve(output) };
  for (let i = 0; i < options.length; i += 2) {
    if (!['--quality', '--repo-root'].includes(options[i]) || !options[i + 1]) throw new Error('Unknown or incomplete edit option.');
    settings[options[i] === '--quality' ? 'quality' : 'repoRoot'] = options[i + 1];
  }
  if (settings.quality && !['standard', 'showcase'].includes(settings.quality)) throw new Error('Quality must be standard or showcase.');
  if (settings.repoRoot) settings.repoRoot = fs.realpathSync(settings.repoRoot);
  const file = statePath(output);
  if (pathsAlias(file, settings.input)) throw new Error('Editor session metadata must not overwrite the source.');
  const current = read(file);
  if (await alive(current)) {
    if (current.input !== settings.input || current.quality !== settings.quality || current.repoRoot !== settings.repoRoot) throw new Error('This output already has a service with different source or validation settings. Stop it before starting another.');
    const result = { ...current, running: true, reused: true };
    if (!quiet) console.log(JSON.stringify(result));
    return result;
  }
  if (current?.starting && Date.now() - current.startedAt < 150000) throw new Error('Editor service is starting. Retry shortly.');
  if (current) fs.unlinkSync(file);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ starting: true, startedAt: Date.now() }), { flag: 'wx', mode: 0o600 });
  let child;
  try {
    const state = await new Promise((resolve, reject) => {
      child = spawn(process.execPath, [self, '--serve', JSON.stringify({ settings, file })], { detached: true, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
      const timeout = setTimeout(() => { child.kill(); reject(new Error('Editor startup timed out.')); }, 130000);
      const finish = (error, result) => { clearTimeout(timeout); error ? reject(error) : resolve(result); };
      child.once('error', error => finish(error));
      child.once('exit', code => finish(new Error(`Editor exited during startup (${code}).`)));
      child.once('message', message => finish(message.error ? new Error(message.error) : null, message));
    });
    child.disconnect(); child.unref();
    const result = { ...state, running: true, reused: false };
    if (!quiet) console.log(JSON.stringify(result));
    return result;
  } catch (error) {
    child?.kill();
    if (read(file)?.starting) fs.unlinkSync(file);
    throw error;
  }
}

if (process.argv[2] === '--serve' && process.send) {
  const { settings, file } = JSON.parse(process.argv[3]);
  try {
    const session = await startEditorServer(settings);
    const state = { ...settings, input: session.input, output: session.output, url: session.url, pid: process.pid };
    fs.writeFileSync(file, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
    const cleanup = () => { try { if (read(file)?.url === state.url) fs.unlinkSync(file); } catch {} };
    session.server.on('close', cleanup);
    process.on('exit', cleanup);
    process.send(state);
  } catch (error) { process.send({ error: error.message }); process.disconnect(); process.exitCode = 1; }
}
