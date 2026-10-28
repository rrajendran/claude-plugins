import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expandHome, UserError } from './util.mjs';

export const USER_CONFIG = path.join(os.homedir(), '.config', 'asc-plugin', 'config.json');
export const PROJECT_CONFIG_NAME = '.asc.json';

const KEY_DIRS = ['~/.keys', '~/.appstoreconnect/private_keys', '~/.private_keys', '~/private_keys'].map(expandHome);

const readJSON = (p) => {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw new UserError(`Could not parse ${p}: ${e.message}`);
  }
};

/** Walk up from cwd looking for .asc.json. */
export function findProjectConfig(start = process.cwd()) {
  let dir = start;
  for (;;) {
    const p = path.join(dir, PROJECT_CONFIG_NAME);
    if (fs.existsSync(p)) return p;
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

/** Find AuthKey_*.p8 in the conventional locations (only when exactly one candidate exists). */
function discoverKey() {
  const found = [];
  for (const d of KEY_DIRS) {
    try {
      for (const f of fs.readdirSync(d)) if (/^AuthKey_[A-Z0-9]+\.p8$/.test(f)) found.push(path.join(d, f));
    } catch { /* directory missing or unreadable */ }
  }
  return found.length === 1 ? found[0] : null;
}

/**
 * Resolve configuration. Precedence (high → low):
 *   CLI flags > environment (ASC_*) > project .asc.json > user config > discovered key.
 */
export function loadConfig(flags = {}) {
  const user = readJSON(USER_CONFIG) ?? {};
  const projPath = findProjectConfig();
  const proj = projPath ? readJSON(projPath) ?? {} : {};
  const env = process.env;

  const cfg = {
    ...user,
    ...proj,
    ...(env.ASC_APP && { app: env.ASC_APP }),
    ...(env.ASC_KEY_ID && { keyId: env.ASC_KEY_ID }),
    ...(env.ASC_ISSUER_ID && { issuerId: env.ASC_ISSUER_ID }),
    ...(env.ASC_KEY_PATH && { keyPath: env.ASC_KEY_PATH }),
    ...(flags['key-id'] && { keyId: flags['key-id'] }),
    ...(flags.issuer && { issuerId: flags.issuer }),
    ...(flags['key-path'] && { keyPath: flags['key-path'] }),
  };
  // Credentials never come from the project file's committed values unless explicitly there, but allow it.
  cfg.keyPath = expandHome(cfg.keyPath ?? discoverKey() ?? '');
  if (!cfg.keyId && cfg.keyPath) {
    const m = path.basename(cfg.keyPath).match(/^AuthKey_([A-Z0-9]+)\.p8$/);
    if (m) cfg.keyId = m[1];
  }
  cfg._projectConfigPath = projPath;
  cfg._projectRoot = projPath ? path.dirname(projPath) : process.cwd();
  return cfg;
}

export function requireCredentials(cfg) {
  const missing = [];
  if (!cfg.keyPath) missing.push('key path (ASC_KEY_PATH / `asc config set keyPath ~/.keys/AuthKey_XXXX.p8`)');
  else {
    try {
      fs.accessSync(cfg.keyPath, fs.constants.R_OK);
    } catch (e) {
      const dir = path.dirname(cfg.keyPath);
      throw new UserError(e.code === 'EACCES'
        ? `Cannot read ${cfg.keyPath}: permission denied. A key directory needs the execute bit — try: chmod 700 ${dir} && chmod 600 ${cfg.keyPath}`
        : `Private key not found: ${cfg.keyPath}`);
    }
  }
  if (!cfg.keyId) missing.push('key id (ASC_KEY_ID / `asc config set keyId XXXXXXXXXX`)');
  if (!cfg.issuerId) missing.push('issuer id (ASC_ISSUER_ID / `asc config set issuerId <uuid>`) — App Store Connect → Users and Access → Integrations → App Store Connect API');
  if (missing.length) throw new UserError(`Missing credentials:\n  - ${missing.join('\n  - ')}`);
}

export function saveUserConfig(patch) {
  const cur = readJSON(USER_CONFIG) ?? {};
  const next = { ...cur, ...patch };
  fs.mkdirSync(path.dirname(USER_CONFIG), { recursive: true });
  fs.writeFileSync(USER_CONFIG, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
  return next;
}

export function readUserConfig() {
  return readJSON(USER_CONFIG) ?? {};
}
