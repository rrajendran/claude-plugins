import fs from 'node:fs';
import path from 'node:path';
import { saveUserConfig, readUserConfig, USER_CONFIG, PROJECT_CONFIG_NAME } from '../config.mjs';
import { resolveApp } from '../core.mjs';
import { color, emit, expandHome, flat, normPlatform, printKV, run, shortDate, table, UserError, csv } from '../util.mjs';

const CONFIG_KEYS = ['keyId', 'issuerId', 'keyPath', 'app', 'platform'];

export const plist = (obj) => {
  const val = (v, ind) => {
    const pad = '\t'.repeat(ind);
    if (typeof v === 'boolean') return `${pad}<${v}/>\n`;
    if (typeof v === 'number') return `${pad}<integer>${v}</integer>\n`;
    if (Array.isArray(v)) return `${pad}<array>\n${v.map((x) => val(x, ind + 1)).join('')}${pad}</array>\n`;
    if (typeof v === 'object') return `${pad}<dict>\n${Object.entries(v).map(([k, x]) => `${pad}\t<key>${k}</key>\n${val(x, ind + 1)}`).join('')}${pad}</dict>\n`;
    return `${pad}<string>${String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;')}</string>\n`;
  };
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n${val(obj, 0)}</plist>\n`;
};

async function xcodeJSON(args) {
  const { code, out } = await run('xcodebuild', args, { capture: true });
  if (code !== 0) return null;
  // stderr is merged into `out`, and xcodebuild warns with brace-laden lines (`{ platform:macOS … }`)
  // before the JSON, so start at the first line that is only an opening bracket.
  const m = /^[[{]\s*$/m.exec(out);
  try { return m ? JSON.parse(out.slice(m.index)) : null; } catch { return null; }
}

export default [
  {
    name: 'auth check',
    summary: 'Verify the API key, issuer and key id by calling the API.',
    run: async (ctx) => {
      const r = await ctx.client.get('/v1/apps', { limit: 1 });
      emit(ctx, { ok: true, keyId: ctx.client.keyId, apps: r.meta?.paging?.total }, () => {
        console.log(`${color.green('✔')} Authenticated with key ${ctx.client.keyId} (${r.meta?.paging?.total ?? '?'} app(s) visible)`);
      });
    },
  },
  {
    name: 'auth token',
    summary: 'Print a fresh JWT (valid 15 minutes) for use with curl or other tools.',
    usage: 'asc auth token',
    run: async (ctx) => console.log(ctx.client.token()),
  },
  {
    name: 'config show',
    summary: 'Show resolved configuration and where each layer comes from.',
    noAuth: true,
    run: async (ctx) => {
      const { _projectConfigPath, _projectRoot, ...cfg } = ctx.cfg;
      emit(ctx, { ...cfg, userConfig: USER_CONFIG, projectConfig: _projectConfigPath }, () => {
        printKV({ ...cfg, userConfig: USER_CONFIG, projectConfig: _projectConfigPath ?? '(none)' });
      });
    },
  },
  {
    name: 'config set',
    summary: `Persist a value in the user config (${USER_CONFIG}). Keys: ${CONFIG_KEYS.join(', ')}.`,
    usage: 'asc config set <key> <value>',
    examples: ['asc config set issuerId 69a6de7e-xxxx-xxxx-xxxx-xxxxxxxxxxxx', 'asc config set keyPath ~/.keys/AuthKey_VBM5T6WP94.p8'],
    noAuth: true,
    run: async (ctx) => {
      const [k, v] = ctx.args;
      if (!CONFIG_KEYS.includes(k) || v === undefined) throw new UserError(`Usage: asc config set <${CONFIG_KEYS.join('|')}> <value>`);
      saveUserConfig({ [k]: k === 'keyPath' ? expandHome(v) : v });
      console.log(`${color.green('✔')} ${k} saved to ${USER_CONFIG}`);
    },
  },
  {
    name: 'config unset',
    summary: 'Remove a value from the user config.',
    usage: 'asc config unset <key>',
    noAuth: true,
    run: async (ctx) => {
      const cur = readUserConfig();
      delete cur[ctx.args[0]];
      fs.writeFileSync(USER_CONFIG, JSON.stringify(cur, null, 2) + '\n', { mode: 0o600 });
      console.log(`${color.green('✔')} removed ${ctx.args[0]}`);
    },
  },

  // ------------------------------------------------------------ apps
  {
    name: 'apps list',
    summary: 'List apps in the account.',
    run: async (ctx) => {
      const { data } = await ctx.client.list('/v1/apps');
      const rows = data.map(flat);
      emit(ctx, rows, () => console.log(table(rows, [['ID', 'id'], ['Name', 'name'], ['Bundle ID', 'bundleId'], ['SKU', 'sku'], ['Locale', 'primaryLocale']])));
    },
  },
  {
    name: 'apps info',
    summary: 'Show an app with its App Store versions and latest builds.',
    usage: 'asc apps info [--app <id|bundleId|name>]',
    options: [['--app', 'App id, bundle id or name (default from .asc.json)']],
    run: async (ctx) => {
      const id = await resolveApp(ctx);
      const [app, versions, builds] = await Promise.all([
        ctx.client.get(`/v1/apps/${id}`),
        ctx.client.list(`/v1/apps/${id}/appStoreVersions`),
        ctx.client.list('/v1/builds', { 'filter[app]': id, sort: '-uploadedDate', include: 'preReleaseVersion' }, { max: 5 }),
      ]);
      const out = { app: flat(app.data), versions: versions.data.map(flat), builds: builds.data.map(flat) };
      emit(ctx, out, () => {
        printKV(out.app);
        console.log(`\n${color.bold('App Store versions')}`);
        console.log(table(out.versions, [['ID', 'id'], ['Platform', 'platform'], ['Version', 'versionString'], ['State', (v) => v.appVersionState ?? v.appStoreState], ['Release', 'releaseType'], ['Created', (v) => shortDate(v.createdDate)]]));
        console.log(`\n${color.bold('Recent builds')}`);
        console.log(table(out.builds, [['ID', 'id'], ['Build', 'version'], ['State', 'processingState'], ['Uploaded', (b) => shortDate(b.uploadedDate)], ['Expired', 'expired']]));
      });
    },
  },

  // ------------------------------------------------------------ users
  {
    name: 'users list',
    summary: 'List team members.',
    run: async (ctx) => {
      const { data } = await ctx.client.list('/v1/users');
      const rows = data.map(flat);
      emit(ctx, rows, () => console.log(table(rows, [['ID', 'id'], ['Username', 'username'], ['Name', (u) => `${u.firstName} ${u.lastName}`], ['Roles', (u) => (u.roles ?? []).join(',')]])));
    },
  },
  {
    name: 'users invite',
    summary: 'Invite a team member.',
    usage: 'asc users invite --email <e> --first <name> --last <name> --roles DEVELOPER,APP_MANAGER [--all-apps]',
    options: [['--email', 'Email'], ['--first', 'First name'], ['--last', 'Last name'], ['--roles', 'Comma list: ADMIN, FINANCE, TECHNICAL, SALES, MARKETING, DEVELOPER, ACCOUNT_HOLDER, READ_ONLY, APP_MANAGER, ACCESS_TO_REPORTS, CUSTOMER_SUPPORT'], ['--all-apps', 'Give access to all apps']],
    bool: ['all-apps'],
    run: async (ctx) => {
      const f = ctx.flags;
      if (!f.email || !f.first || !f.last || !f.roles) throw new UserError('--email, --first, --last and --roles are required');
      await ctx.client.post('/v1/userInvitations', { data: { type: 'userInvitations', attributes: { email: f.email, firstName: f.first, lastName: f.last, roles: csv(f.roles), allAppsVisible: !!f['all-apps'] } } });
      console.log(`${color.green('✔')} Invitation sent to ${f.email}`);
    },
  },

  // ------------------------------------------------------------ raw API
  {
    name: 'api',
    summary: 'Call any App Store Connect API endpoint directly (escape hatch for anything not wrapped).',
    usage: 'asc api <GET|POST|PATCH|DELETE> <path> [--query k=v ...] [--data <json|@file>] [--all]',
    examples: ['asc api GET /v1/apps --query limit=5', 'asc api GET /v1/apps/123/betaGroups --all', "asc api PATCH /v1/builds/abc --data '{\"data\":{\"type\":\"builds\",\"id\":\"abc\",\"attributes\":{\"expired\":true}}}'"],
    options: [['--query', 'Query param k=v (repeatable)'], ['--data', 'JSON body, or @path/to/file.json'], ['--all', 'Follow pagination (GET only)']],
    bool: ['all'],
    run: async (ctx) => {
      const [method, p] = ctx.args;
      if (!method || !p) throw new UserError('Usage: asc api <METHOD> <path>');
      const query = Object.fromEntries([].concat(ctx.flags.query ?? []).map((kv) => [kv.slice(0, kv.indexOf('=')), kv.slice(kv.indexOf('=') + 1)]));
      let body;
      if (ctx.flags.data) body = JSON.parse(String(ctx.flags.data).startsWith('@') ? fs.readFileSync(expandHome(ctx.flags.data.slice(1)), 'utf8') : ctx.flags.data);
      const m = method.toUpperCase();
      const out = m === 'GET' && ctx.flags.all ? await ctx.client.list(p, query) : await ctx.client.request(m, p, { query, body });
      console.log(JSON.stringify(out, null, 2));
    },
  },

  // ------------------------------------------------------------ init
  {
    name: 'init',
    summary: 'Generate project configs: .asc.json, ExportOptions plists, metadata folder, .gitignore entries. Auto-detects the Xcode project.',
    usage: 'asc init [--project X.xcodeproj | --workspace X.xcworkspace] [--scheme S] [--bundle-id com.x.y] [--team TEAMID] [--platform ios|macos] [--force]',
    options: [['--project / --workspace', 'Xcode container (auto-detected)'], ['--scheme', 'Scheme to build'], ['--bundle-id', 'App bundle id'], ['--team', 'Apple developer team id'], ['--platform', 'ios|macos|tvos|visionos'], ['--force', 'Overwrite existing files']],
    bool: ['force'],
    noAuth: true,
    run: async (ctx) => {
      const f = ctx.flags;
      const cwd = process.cwd();
      const ls = fs.readdirSync(cwd);
      const workspace = f.workspace ?? ls.find((n) => n.endsWith('.xcworkspace'));
      const project = f.project ?? ls.find((n) => n.endsWith('.xcodeproj'));
      const container = workspace ?? project;
      const flag = workspace ? '-workspace' : '-project';

      let scheme = f.scheme;
      let settings = {};
      if (container) {
        if (!scheme) {
          const list = await xcodeJSON([flag, container, '-list', '-json']);
          const schemes = list?.project?.schemes ?? list?.workspace?.schemes ?? [];
          scheme = schemes.find((s) => container.startsWith(s)) ?? schemes[0];
        }
        if (scheme) {
          const bs = await xcodeJSON([flag, container, '-scheme', scheme, '-configuration', 'Release', '-showBuildSettings', '-json']);
          const app = (bs ?? []).find((t) => t.buildSettings?.WRAPPER_EXTENSION === 'app') ?? (bs ?? [])[0];
          settings = app?.buildSettings ?? {};
        }
      }
      const bundleId = f['bundle-id'] ?? settings.PRODUCT_BUNDLE_IDENTIFIER;
      const teamId = f.team ?? settings.DEVELOPMENT_TEAM;
      const plat = normPlatform(f.platform) ?? ({ iphoneos: 'IOS', macosx: 'MAC_OS', appletvos: 'TV_OS', xros: 'VISION_OS' }[settings.PLATFORM_NAME] ?? 'IOS');

      const cfg = {
        app: bundleId ?? 'com.example.app',
        platform: plat,
        ...(workspace ? { workspace } : container ? { project } : {}),
        scheme: scheme ?? 'App',
        configuration: 'Release',
        teamId: teamId ?? 'TEAMID',
        buildDir: 'build',
        exportOptions: 'asc/ExportOptions-appstore.plist',
        metadataDir: 'asc/metadata',
        testflight: { groups: [], notify: false, whatsNewFile: 'asc/testflight-whats-new.txt' },
      };

      const written = [];
      const write = (rel, content) => {
        const p = path.join(cwd, rel);
        if (fs.existsSync(p) && !f.force) return written.push([rel, 'exists, skipped (use --force)']);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, content);
        written.push([rel, 'written']);
      };
      write(PROJECT_CONFIG_NAME, JSON.stringify(cfg, null, 2) + '\n');
      const base = { teamID: cfg.teamId, signingStyle: 'automatic', compileBitcode: false };
      write('asc/ExportOptions-appstore.plist', plist({ method: 'app-store-connect', destination: 'export', uploadSymbols: true, manageAppVersionAndBuildNumber: false, ...base }));
      write('asc/ExportOptions-adhoc.plist', plist({ method: 'release-testing', thinning: '<none>', ...base }));
      write('asc/ExportOptions-development.plist', plist({ method: 'debugging', ...base }));
      write('asc/testflight-whats-new.txt', 'What to test:\n- \n');
      write('asc/metadata/en-US/description.txt', '');
      write('asc/metadata/en-US/keywords.txt', '');
      write('asc/metadata/en-US/whats_new.txt', '');
      write('asc/metadata/en-US/promotional_text.txt', '');
      write('asc/metadata/en-US/support_url.txt', '');
      write('asc/metadata/en-US/marketing_url.txt', '');
      write('asc/metadata/en-US/name.txt', '');
      write('asc/metadata/en-US/subtitle.txt', '');
      write('asc/metadata/en-US/privacy_policy_url.txt', '');

      const gi = path.join(cwd, '.gitignore');
      const ignore = ['build/', '.asc.env'];
      const existing = fs.existsSync(gi) ? fs.readFileSync(gi, 'utf8') : '';
      const add = ignore.filter((l) => !existing.split('\n').includes(l));
      if (add.length) { fs.appendFileSync(gi, `${existing && !existing.endsWith('\n') ? '\n' : ''}${add.join('\n')}\n`); written.push(['.gitignore', `added ${add.join(', ')}`]); }

      console.log(table(written.map(([file, status]) => ({ file, status })), [['File', 'file'], ['Status', 'status']]));
      if (!bundleId || !teamId || !scheme) console.log(color.yellow('\nSome values could not be detected — edit .asc.json (app, teamId, scheme).'));
      console.log(`\nNext: ${color.bold('asc auth check')} → ${color.bold('asc readiness')}`);
    },
  },
];
