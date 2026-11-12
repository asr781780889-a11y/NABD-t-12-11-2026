// Integration harness: real PostgreSQL + Redis, real API + workers in-process, fake Telegram and fake AI.
import WebSocket from 'ws';
import Redis from 'ioredis';
import { world, fakeFactory, startFakeServices } from './fakes.js';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export async function waitFor(fn, { timeout = 20000, interval = 150, label = 'condition' } = {}) {
  const end = Date.now() + timeout; let last;
  while (Date.now() < end) { try { last = await fn(); if (last) return last; } catch (e) { last = e; } await sleep(interval); }
  throw new Error(`timeout waiting for ${label}${last instanceof Error ? `: ${last.message}` : ''}`);
}

export async function startHarness({ workers = true, only, serveStatic = false, port = 0 } = {}) {
  process.env.NODE_ENV = 'test';
  process.env.DATABASE_URL ??= 'postgres://nabd:nabd_test@127.0.0.1:5432/nabd_test';
  process.env.REDIS_URL ??= 'redis://127.0.0.1:6379';
  process.env.MASTER_KEY ??= 'dGVzdC1tYXN0ZXIta2V5LWZvci1uYWJkLWFpLTMyYnl0ZXM=';
  process.env.NABD_PING_S = '1'; process.env.NABD_DBCHECK_S = '2'; process.env.NABD_SWEEP_MS = '1000'; process.env.NABD_SWEEP_AGE_S = '2'; process.env.SERVE_STATIC = serveStatic ? 'true' : 'false';
  const fr = new Redis(process.env.REDIS_URL); await fr.flushdb(); await fr.quit();
  const db = await import('../../src/lib/db.js');
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  world.reset();
  const svc = await startFakeServices();
  process.env.TELEGRAM_BOT_API_BASE = svc.url;
  const { setTelegramFactory } = await import('../../src/telegram/adapter.js'); setTelegramFactory(fakeFactory);
  const { startServer } = await import('../../src/server.js');
  const srv = await startServer({ port, host: '127.0.0.1' });
  let sup = null;
  if (workers) { const { startWorkers } = await import('../../src/worker.js'); sup = await startWorkers({ boot: false, only }); }
  const base = `http://127.0.0.1:${srv.port}`;
  const jar = { cookie: '', csrf: '' };
  async function api(method, path, body, headers = {}) {
    const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(jar.cookie ? { cookie: jar.cookie } : {}), ...(jar.csrf && method !== 'GET' ? { 'x-csrf-token': jar.csrf } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' });
    const sc = res.headers.get('set-cookie'); if (sc) jar.cookie = sc.split(';')[0];
    const buf = Buffer.from(await res.arrayBuffer()); const text = buf.toString('utf8'); let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
    if (json?.csrf) jar.csrf = json.csrf;
    return { status: res.status, body: json, text, buf, headers: res.headers };
  }
  const ok = async (method, path, body, headers) => { const r = await api(method, path, body, headers); if (r.status >= 300) throw new Error(`${method} ${path} -> ${r.status} ${r.text.slice(0, 300)}`); return r.body; };
  function openWs() {
    const events = []; const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/ws`, { headers: { cookie: jar.cookie } });
    ws.on('message', (d) => { try { events.push(JSON.parse(d.toString())); } catch { /* ignore */ } });
    return { ws, events, ready: new Promise((r, j) => { ws.on('open', r); ws.on('error', j); }), close: () => ws.close() };
  }
  async function stop() {
    if (sup) await sup.stop(); await srv.close(); await svc.close();
    const { shutdownCommon } = await import('../../src/boot.js'); await shutdownCommon();
  }
  const self = { base, api, ok, jar, openWs, world, svc, sup, srv, stop, db };
  self.restartWorkers = async () => { const { startWorkers } = await import('../../src/worker.js'); self.sup = await startWorkers({ boot: false }); sup = self.sup; return self.sup; };
  self.stopWorkers = async () => { if (self.sup) { await self.sup.stop(); self.sup = null; sup = null; } };
  return self;
}
export async function setupAdmin(h, username = 'admin', password = 'Passw0rd-Strong1') {
  return h.ok('POST', '/api/setup/admin', { username, password });
}

import { spawnSync } from 'node:child_process';
export const sh = (cmd, args) => spawnSync(cmd, args, { encoding: 'utf8' });
const systemdUnitLoaded = (unit) => {
  if (!unit) return false;
  const result = sh('systemctl', ['show', unit, '-p', 'LoadState']);
  return result.status === 0 && result.stdout.includes('LoadState=loaded');
};
const nonInteractiveSudo = () => sh('sudo', ['-n', 'true']).status === 0;
const localUser = sh('id', ['-un']).stdout?.trim();
const hasServiceControl = () => localUser === 'root' || localUser === 'postgres' || nonInteractiveSudo();
export const redisCtl = {
  available: () => sh('redis-cli', ['ping']).stdout?.trim() === 'PONG',
  controllable: () => !systemdUnitLoaded('redis-server') || nonInteractiveSudo(),
  stop: () => systemdUnitLoaded('redis-server') ? sh('sudo', ['-n', 'systemctl', 'stop', 'redis-server']) : sh('redis-cli', ['shutdown', 'nosave']),
  start: () => systemdUnitLoaded('redis-server') ? sh('sudo', ['-n', 'systemctl', 'start', 'redis-server']) : sh('redis-server', ['--daemonize', 'yes', '--port', '6379', '--save', '', '--appendonly', 'no']),
};
const postgresCluster = () => {
  const result = sh('pg_lsclusters', []);
  if (result.status !== 0) return null;
  const rows = result.stdout.split(/\r?\n/).slice(1).map((line) => line.trim().split(/\s+/)).filter((row) => row.length >= 4 && /^\d+$/.test(row[0]));
  const row = rows.find((item) => item[3] === 'online') || rows[0];
  return row ? { version: row[0], name: row[1], status: row[3] } : null;
};
const postgresUnit = (cluster) => cluster ? `postgresql@${cluster.version}-${cluster.name}` : null;
const controlPostgres = (action) => {
  const cluster = postgresCluster();
  if (!cluster) return { status: 1, stdout: '', stderr: 'PostgreSQL cluster not available' };
  const unit = postgresUnit(cluster);
  if (systemdUnitLoaded(unit)) {
    if (localUser === 'root') return sh('systemctl', [action, unit]);
    if (nonInteractiveSudo()) return sh('sudo', ['-n', 'systemctl', action, unit]);
  }
  const args = [cluster.version, cluster.name, action, ...(action === 'stop' ? ['-m', 'fast'] : [])];
  if (localUser === 'root' || localUser === 'postgres') return sh('pg_ctlcluster', args);
  if (nonInteractiveSudo()) return sh('sudo', ['-n', 'pg_ctlcluster', ...args]);
  return { status: 1, stdout: '', stderr: 'cannot control PostgreSQL cluster' };
};
export const pgCtl = {
  available: () => postgresCluster()?.status === 'online',
  controllable: () => Boolean(postgresCluster() && hasServiceControl()),
  stop: () => controlPostgres('stop'),
  start: () => controlPostgres('start'),
};
