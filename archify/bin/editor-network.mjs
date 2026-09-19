import path from 'node:path';
import { isIP } from 'node:net';

export const editorOptionNames = {
  '--quality': 'quality', '--repo-root': 'repoRoot', '--host': 'host',
  '--port': 'port', '--origin': 'origin', '--tls-cert': 'tlsCert', '--tls-key': 'tlsKey',
};

export function parseEditorOptions(args) {
  const settings = {};
  for (let i = 0; i < args.length; i += 2) {
    const name = editorOptionNames[args[i]];
    if (!name || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error('Unknown or incomplete edit option.');
    if (Object.hasOwn(settings, name)) throw new Error(`Duplicate edit option: ${args[i]}`);
    settings[name] = args[i + 1];
  }
  if (settings.quality && !['standard', 'showcase'].includes(settings.quality)) throw new Error('Quality must be standard or showcase.');
  return settings;
}

export function editorNetwork(options = {}) {
  const host = options.host ?? '127.0.0.1';
  if (typeof host !== 'string' || (!isIP(host) && !/^(?=.{1,253}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(host))) throw new Error('Invalid editor bind host.');
  const rawPort = options.port ?? 0;
  if (!/^\d+$/.test(String(rawPort)) || Number(rawPort) > 65535) throw new Error('Editor port must be 0 through 65535.');
  const port = Number(rawPort);
  if (Boolean(options.tlsCert) !== Boolean(options.tlsKey)) throw new Error('Provide both --tls-cert and --tls-key.');
  const tlsCert = options.tlsCert ? path.resolve(options.tlsCert) : undefined;
  const tlsKey = options.tlsKey ? path.resolve(options.tlsKey) : undefined;
  const loopback = host === '127.0.0.1' || host === '::1';
  if (!loopback && !tlsCert) throw new Error('Non-loopback editor binding requires --tls-cert and --tls-key. Use an SSH tunnel for loopback HTTP.');
  let origin;
  if (options.origin !== undefined) {
    const url = new URL(options.origin);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash || ['0.0.0.0', '[::]'].includes(url.hostname)) throw new Error('Editor origin must be one HTTP(S) origin without credentials, path, query, or fragment.');
    if (url.protocol === 'http:' && (!loopback || !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname))) throw new Error('HTTP browser origins must be loopback; use HTTPS for hostname access.');
    if (tlsCert && url.protocol !== 'https:') throw new Error('TLS editor requires an HTTPS origin.');
    origin = url.origin;
  }
  if (['0.0.0.0', '::'].includes(host) && !origin) throw new Error('Wildcard binding requires an explicit --origin with the browser hostname.');
  return { host, port, origin, tlsCert, tlsKey };
}

export function editorUrl(target) {
  const url = new URL(target);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !/^\/[a-f0-9]{64}\/$/.test(url.pathname) || url.search || url.hash) throw new Error('Invalid editor URL.');
  if (url.protocol === 'http:' && !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)) throw new Error('Remote editor URLs require HTTPS.');
  return url;
}
