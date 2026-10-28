import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test, before, after } from 'node:test';
import { spawn } from 'node:child_process';
import { AscClient } from '../lib/client.mjs';
import { findCommand, parseArgs } from '../lib/cli.mjs';

const BIN = path.resolve(import.meta.dirname, '../bin/asc');
let server, base, tmp, keyPath, publicKey;
const seen = [];

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'asc-test-'));
  const kp = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  publicKey = kp.publicKey;
  keyPath = path.join(tmp, 'AuthKey_TESTKEY123.p8');
  fs.writeFileSync(keyPath, kp.privateKey.export({ type: 'pkcs8', format: 'pem' }));

  server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    seen.push(`${req.method} ${url.pathname}`);
    const send = (obj, code = 200) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (url.pathname === '/v1/apps' && url.searchParams.get('cursor') === '2') return send({ data: [{ type: 'apps', id: '222222', attributes: { name: 'Two', bundleId: 'com.x.two' } }] });
    if (url.pathname === '/v1/apps') return send({ data: [{ type: 'apps', id: '111111', attributes: { name: 'One', bundleId: 'com.x.one', sku: 's', primaryLocale: 'en-US' } }], links: { next: `${base}/v1/apps?cursor=2` }, meta: { paging: { total: 2 } } });
    if (url.pathname === '/v1/apps/111111') return send({ data: { type: 'apps', id: '111111', attributes: { name: 'One', bundleId: 'com.x.one', primaryLocale: 'en-US', contentRightsDeclaration: null } } });
    if (url.pathname === '/v1/apps/111111/appStoreVersions') return send({ data: [] });
    if (url.pathname === '/v1/apps/111111/appInfos') return send({ data: [] });
    if (url.pathname === '/v1/builds') return send({ data: [] });
    send({ errors: [{ status: '404', code: 'NOT_FOUND', title: 'nope', detail: 'no such resource' }] }, 404);
  });
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => { server.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

const cli = (args, env = {}) => new Promise((resolve) => {
  const p = spawn('node', [BIN, ...args], { cwd: tmp, env: { ...process.env, NO_COLOR: '1', HOME: tmp, ASC_API_BASE: base, ASC_KEY_PATH: keyPath, ASC_KEY_ID: 'TESTKEY123', ASC_ISSUER_ID: 'issuer-uuid', ...env } });
  let out = '';
  p.stdout.on('data', (d) => (out += d));
  p.stderr.on('data', (d) => (out += d));
  p.on('close', (code) => resolve({ code, out }));
});

test('JWT is ES256, verifiable, with the right claims', () => {
  const c = new AscClient({ keyId: 'TESTKEY123', issuerId: 'iss', keyPath });
  const [h, p, s] = c.token().split('.');
  const header = JSON.parse(Buffer.from(h, 'base64url'));
  const claims = JSON.parse(Buffer.from(p, 'base64url'));
  assert.deepEqual(header, { alg: 'ES256', kid: 'TESTKEY123', typ: 'JWT' });
  assert.equal(claims.aud, 'appstoreconnect-v1');
  assert.equal(claims.iss, 'iss');
  assert.ok(claims.exp - claims.iat <= 1200, 'Apple rejects tokens valid >20 min');
  assert.ok(crypto.verify('sha256', Buffer.from(`${h}.${p}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url')));
  assert.equal(c.token(), c.token(), 'token is cached');
});

test('list() follows pagination links', async () => {
  const c = new AscClient({ keyId: 'K', issuerId: 'I', keyPath });
  const { data } = await c.list(`${base}/v1/apps`);
  assert.deepEqual(data.map((d) => d.id), ['111111', '222222']);
});

test('errors surface Apple error details', async () => {
  const c = new AscClient({ keyId: 'K', issuerId: 'I', keyPath });
  await assert.rejects(() => c.get(`${base}/v1/nothing`), /HTTP 404[\s\S]*NOT_FOUND: nope — no such resource/);
  assert.equal(await c.getOptional(`${base}/v1/nothing`), null);
});

test('arg parsing: bools, --no-x, = form, repeats, command resolution', () => {
  const { positional, flags } = parseArgs(['tf', 'groups', 'create', '--name', 'Beta', '--internal', '--limit=5', '--query', 'a=1', '--query', 'b=2', '--no-wait']);
  assert.deepEqual(positional, ['tf', 'groups', 'create']);
  assert.equal(flags.internal, true);
  assert.equal(flags.limit, '5');
  assert.deepEqual(flags.query, ['a=1', 'b=2']);
  assert.equal(flags.wait, false);
  assert.equal(findCommand(positional).cmd.name, 'tf groups create');
  assert.deepEqual(findCommand(['review', 'cancel', 'abc']).args, ['abc']);
});

test('CLI: apps list works end to end and --json is parseable', async () => {
  const t = await cli(['apps', 'list']);
  assert.equal(t.code, 0, t.out);
  assert.match(t.out, /One[\s\S]*Two/);
  const j = await cli(['apps', 'list', '--json']);
  assert.equal(JSON.parse(j.out).length, 2);
});

test('CLI: missing issuer gives an actionable error', async () => {
  const r = await cli(['apps', 'list'], { ASC_ISSUER_ID: '' });
  assert.equal(r.code, 1);
  assert.match(r.out, /issuer id/);
});

test('CLI: readiness reports blockers, never crashes, exits 1', async () => {
  const r = await cli(['readiness', '--app', 'com.x.one', '--only', 'appstore']);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /NOT READY/);
  assert.match(r.out, /Content rights declaration/);
  assert.match(r.out, /no version exists/);
});

test('CLI: destructive commands demand --yes', async () => {
  for (const args of [['certs', 'revoke', 'x'], ['builds', 'expire', '1', '--app', '111111'], ['review', 'submit', '--app', '111111']]) {
    const r = await cli(args);
    assert.equal(r.code, 1);
    assert.match(r.out, /--yes/, args.join(' '));
  }
});

test('CLI: init writes configs without clobbering', async () => {
  const d = fs.mkdtempSync(path.join(tmp, 'proj-'));
  const run = () => new Promise((resolve) => {
    const p = spawn('node', [BIN, 'init', '--bundle-id', 'com.x.one', '--team', 'ABCDE12345', '--scheme', 'App'], { cwd: d, env: { ...process.env, NO_COLOR: '1', HOME: tmp } });
    let out = '';
    p.stdout.on('data', (x) => (out += x));
    p.on('close', () => resolve(out));
  });
  await run();
  const cfg = JSON.parse(fs.readFileSync(path.join(d, '.asc.json'), 'utf8'));
  assert.equal(cfg.app, 'com.x.one');
  assert.equal(cfg.teamId, 'ABCDE12345');
  assert.match(fs.readFileSync(path.join(d, 'asc/ExportOptions-appstore.plist'), 'utf8'), /<string>app-store-connect<\/string>/);
  fs.writeFileSync(path.join(d, '.asc.json'), '{"custom":true}');
  assert.match(await run(), /skipped/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(d, '.asc.json'), 'utf8')).custom, true);
});
