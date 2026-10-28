import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findBuilds, platform, resolveApp } from '../core.mjs';
import { color, compact, csv, emit, expandHome, flat, printKV, run, runOrThrow, shortDate, sleep, table, UserError } from '../util.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DESTINATION = { IOS: 'generic/platform=iOS', MAC_OS: 'generic/platform=macOS', TV_OS: 'generic/platform=tvOS', VISION_OS: 'generic/platform=visionOS' };
const ALTOOL_TYPE = { IOS: 'ios', MAC_OS: 'macos', TV_OS: 'appletvos', VISION_OS: 'visionos' };

/** build ref: uuid | build number | "latest" → build resource id. */
export async function resolveBuild(ctx, appId, ref = 'latest') {
  ref = String(ref);
  if (UUID.test(ref)) return ref;
  const builds = await findBuilds(ctx, appId, { number: ref === 'latest' ? undefined : ref, limit: 1 });
  if (!builds.length) throw new UserError(ref === 'latest' ? 'App has no builds yet.' : `No build with number ${ref}.`);
  return builds[0].id;
}

const buildCols = [['ID', 'id'], ['Version', 'marketingVersion'], ['Build', 'version'], ['Platform', 'platform'], ['State', 'processingState'], ['Uploaded', (b) => shortDate(b.uploadedDate)], ['Expired', 'expired'], ['Encryption', 'usesNonExemptEncryption']];

async function nextBuildNumber(ctx, appId) {
  const builds = await findBuilds(ctx, appId, { limit: 200 });
  const max = Math.max(0, ...builds.map((b) => parseInt(b.version, 10)).filter(Number.isFinite));
  return max + 1;
}

/** altool finds the key by name in API_PRIVATE_KEYS_DIR — ensure AuthKey_<id>.p8 is there. */
function altoolEnv(ctx) {
  const { keyId, keyPath } = ctx.client;
  if (path.basename(keyPath) === `AuthKey_${keyId}.p8`) return { API_PRIVATE_KEYS_DIR: path.dirname(keyPath) };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asc-key-'));
  fs.symlinkSync(keyPath, path.join(dir, `AuthKey_${keyId}.p8`));
  return { API_PRIVATE_KEYS_DIR: dir };
}

const authArgs = (ctx) => ['-allowProvisioningUpdates', '-authenticationKeyPath', ctx.client.keyPath, '-authenticationKeyID', ctx.client.keyId, '-authenticationKeyIssuerID', ctx.client.issuerId];

async function uploadFile(ctx, file, { validateOnly = false } = {}) {
  file = path.resolve(expandHome(file));
  if (!fs.existsSync(file)) throw new UserError(`File not found: ${file}`);
  const type = ctx.flags.type ?? (file.endsWith('.pkg') ? 'macos' : ALTOOL_TYPE[platform(ctx)]);
  console.log(`${color.bold(validateOnly ? 'Validating' : 'Uploading')} ${path.basename(file)} (${type}) via altool …`);
  const { code, out } = await run('xcrun', ['altool', validateOnly ? '--validate-app' : '--upload-app', '-f', file, '-t', type, '--apiKey', ctx.client.keyId, '--apiIssuer', ctx.client.issuerId, ...(ctx.flags.verbose ? ['--verbose'] : [])], { env: altoolEnv(ctx), capture: true });
  console.log(out.trim().split('\n').slice(-12).join('\n'));
  if (code !== 0) throw new UserError(`altool failed with exit code ${code}`);
  console.log(`${color.green('✔')} ${validateOnly ? 'Validation passed (note: validation does not catch every signing problem Apple finds after upload)' : 'Upload accepted — Apple is now processing the build'}`);
  return out.match(/Delivery UUID: ([0-9a-f-]+)/i)?.[1];
}

/** Ask Apple how a delivery fared. Returns { state, problems[] }; state is PROCESSING until Apple decides. */
async function deliveryStatus(ctx, deliveryId) {
  const { out } = await run('xcrun', ['altool', '--build-status', '--delivery-id', deliveryId, '--apiKey', ctx.client.keyId, '--apiIssuer', ctx.client.issuerId], { env: altoolEnv(ctx), capture: true });
  const state = out.match(/IMPORT-STATUS:\s*(\w+)/)?.[1] ?? out.match(/BUILD-STATUS:\s*(\w+)/)?.[1] ?? 'PROCESSING';
  const problems = [...new Set([...out.matchAll(/description\s*:\s*(.+)/g)].map((m) => m[1].trim()).filter(Boolean))];
  return { state, problems };
}

function container(ctx) {
  const c = ctx.cfg;
  const root = c._projectRoot;
  if (ctx.flags.workspace || c.workspace) return ['-workspace', path.resolve(root, ctx.flags.workspace ?? c.workspace)];
  if (ctx.flags.project || c.project) return ['-project', path.resolve(root, ctx.flags.project ?? c.project)];
  throw new UserError('No Xcode project configured. Run `asc init` or pass --project/--workspace and --scheme.');
}

async function archive(ctx, { buildNumber, marketingVersion } = {}) {
  const c = ctx.cfg;
  const scheme = ctx.flags.scheme ?? c.scheme;
  if (!scheme) throw new UserError('No scheme. Pass --scheme or set "scheme" in .asc.json.');
  const out = path.resolve(c._projectRoot, ctx.flags.out ?? c.buildDir ?? 'build');
  const archivePath = path.join(out, `${scheme}-${platform(ctx)}.xcarchive`);
  fs.mkdirSync(out, { recursive: true });
  const identity = ctx.flags['archive-identity'] ?? c.archiveSigningIdentity;
  const overrides = [identity && `CODE_SIGN_IDENTITY=${identity}`, identity && c.teamId && `DEVELOPMENT_TEAM=${c.teamId}`, buildNumber && `CURRENT_PROJECT_VERSION=${buildNumber}`, marketingVersion && `MARKETING_VERSION=${marketingVersion}`].filter(Boolean);
  console.log(`${color.bold('Archiving')} ${scheme} (${platform(ctx)}${buildNumber ? `, build ${buildNumber}` : ''}) → ${archivePath}`);
  await runOrThrow('xcodebuild', [...container(ctx), '-scheme', scheme, '-configuration', ctx.flags.configuration ?? c.configuration ?? 'Release', '-destination', DESTINATION[platform(ctx)], '-archivePath', archivePath, ...authArgs(ctx), 'archive', ...overrides]);
  return archivePath;
}

/**
 * Archiving with a development identity signs SwiftPM resource bundles (e.g. Realm_Realm.bundle) with it, and
 * export keeps those signatures, so Apple rejects the package ("must be signed with the certificate contained in
 * the provisioning profile"). Removing them lets export treat the bundles as plain resources of the signed app.
 */
async function stripNestedBundleSignatures(archivePath) {
  const apps = path.join(archivePath, 'Products', 'Applications');
  for (const app of fs.existsSync(apps) ? fs.readdirSync(apps).filter((n) => n.endsWith('.app')) : []) {
    const res = path.join(apps, app, 'Contents', 'Resources');
    for (const b of fs.existsSync(res) ? fs.readdirSync(res).filter((n) => n.endsWith('.bundle')) : []) await run('codesign', ['--remove-signature', path.join(res, b)], { capture: true });
  }
}

async function exportArchive(ctx, archivePath) {
  const c = ctx.cfg;
  const plist = path.resolve(c._projectRoot, ctx.flags['export-options'] ?? (typeof c.exportOptions === 'object' ? c.exportOptions[platform(ctx)] : c.exportOptions) ?? 'asc/ExportOptions-appstore.plist');
  if (!fs.existsSync(plist)) throw new UserError(`Export options not found: ${plist}. Run \`asc init\`.`);
  const exportPath = path.join(path.dirname(archivePath), `export-${path.basename(archivePath, '.xcarchive')}`);
  fs.rmSync(exportPath, { recursive: true, force: true });
  if (platform(ctx) === 'MAC_OS' && c.archiveSigningIdentity) await stripNestedBundleSignatures(archivePath);
  console.log(`${color.bold('Exporting')} → ${exportPath}`);
  await runOrThrow('xcodebuild', ['-exportArchive', '-archivePath', archivePath, '-exportPath', exportPath, '-exportOptionsPlist', plist, ...authArgs(ctx)]);
  const artifact = fs.readdirSync(exportPath).find((n) => /\.(ipa|pkg)$/.test(n));
  if (!artifact) throw new UserError(`Export produced no .ipa/.pkg in ${exportPath}`);
  return path.join(exportPath, artifact);
}

async function waitForBuild(ctx, appId, number, { timeoutMin = 45, intervalSec = 30, deliveryId } = {}) {
  const deadline = Date.now() + timeoutMin * 60_000;
  let last = '';
  while (Date.now() < deadline) {
    const [b] = await findBuilds(ctx, appId, { number, limit: 1 });
    const state = b?.processingState ?? 'NOT_YET_VISIBLE';
    if (state !== last) { console.log(`  build ${number}: ${state}`); last = state; }
    if (state === 'VALID') return b;
    if (state === 'NOT_YET_VISIBLE' && deliveryId) {
      const d = await deliveryStatus(ctx, deliveryId);
      if (d.state === 'FAILED') throw new UserError(`Apple rejected the upload:\n  - ${d.problems.join('\n  - ') || 'no details; check the email from App Store Connect'}`);
    }
    if (state === 'INVALID' || state === 'FAILED') throw new UserError(`Build ${number} processing ended in ${state}. Check the email from App Store Connect for the reason.`);
    await sleep(intervalSec * 1000);
  }
  throw new UserError(`Timed out after ${timeoutMin} min waiting for build ${number} to finish processing.`);
}

export default [
  {
    name: 'builds list',
    summary: 'List uploaded builds (newest first).',
    options: [['--app', 'App'], ['--limit', 'Max rows (default 25)'], ['--platform', 'Filter by platform']],
    run: async (ctx) => {
      const rows = await findBuilds(ctx, await resolveApp(ctx), { limit: Number(ctx.flags.limit ?? 25) });
      emit(ctx, rows, () => console.log(table(rows, buildCols)));
    },
  },
  {
    name: 'builds info',
    summary: 'Show one build (id, number, or "latest") with its TestFlight beta state.',
    usage: 'asc builds info [<id|number|latest>]',
    run: async (ctx) => {
      const appId = await resolveApp(ctx);
      const id = await resolveBuild(ctx, appId, ctx.args[0]);
      const [b, beta] = await Promise.all([ctx.client.get(`/v1/builds/${id}`), ctx.client.getOptional(`/v1/builds/${id}/buildBetaDetail`)]);
      const out = { build: flat(b.data), beta: flat(beta?.data) };
      emit(ctx, out, () => { printKV(out.build); if (out.beta) { console.log(color.bold('\nTestFlight')); printKV(out.beta); } });
    },
  },
  {
    name: 'builds next-number',
    summary: 'Print the next free build number (max existing + 1).',
    run: async (ctx) => console.log(await nextBuildNumber(ctx, await resolveApp(ctx))),
  },
  {
    name: 'builds wait',
    summary: 'Block until a build finishes processing (VALID). Exit 1 on INVALID/timeout.',
    usage: 'asc builds wait --number 42 [--timeout 45] [--interval 30]',
    options: [['--number', 'Build number (CFBundleVersion)'], ['--timeout', 'Minutes (default 45)'], ['--interval', 'Seconds between polls (default 30)']],
    run: async (ctx) => {
      if (!ctx.flags.number) throw new UserError('--number is required');
      const b = await waitForBuild(ctx, await resolveApp(ctx), String(ctx.flags.number), { timeoutMin: Number(ctx.flags.timeout ?? 45), intervalSec: Number(ctx.flags.interval ?? 30) });
      console.log(`${color.green('✔')} Build ${b.version} is VALID (id ${b.id})`);
    },
  },
  {
    name: 'builds expire',
    summary: 'Expire a build so it can no longer be tested/submitted.',
    usage: 'asc builds expire <id|number> --yes',
    bool: ['yes'],
    run: async (ctx) => {
      if (!ctx.flags.yes) throw new UserError('Expiring cannot be undone. Re-run with --yes.');
      const id = await resolveBuild(ctx, await resolveApp(ctx), ctx.args[0]);
      await ctx.client.patch(`/v1/builds/${id}`, { data: { type: 'builds', id, attributes: { expired: true } } });
      console.log(`${color.green('✔')} Expired ${id}`);
    },
  },
  {
    name: 'builds encryption',
    summary: 'Answer export compliance for a build (usesNonExemptEncryption).',
    usage: 'asc builds encryption <id|number|latest> --uses-encryption false',
    run: async (ctx) => {
      const val = ctx.flags['uses-encryption'];
      if (val === undefined) throw new UserError('--uses-encryption true|false is required');
      const id = await resolveBuild(ctx, await resolveApp(ctx), ctx.args[0]);
      await ctx.client.patch(`/v1/builds/${id}`, { data: { type: 'builds', id, attributes: { usesNonExemptEncryption: String(val) === 'true' } } });
      console.log(`${color.green('✔')} Export compliance saved (tip: set ITSAppUsesNonExemptEncryption in Info.plist to skip this)`);
    },
  },

  // ------------------------------------------------------------ pipeline
  {
    name: 'upload',
    summary: 'Upload an .ipa/.pkg to App Store Connect (uses xcrun altool with your API key).',
    usage: 'asc upload <file.ipa|file.pkg> [--validate] [--platform ios|macos|tvos|visionos]',
    bool: ['validate'],
    run: async (ctx) => {
      if (!ctx.args[0]) throw new UserError('Usage: asc upload <file>');
      await uploadFile(ctx, ctx.args[0], { validateOnly: !!ctx.flags.validate });
    },
  },
  {
    name: 'archive',
    summary: 'xcodebuild archive with API-key based automatic signing.',
    usage: 'asc archive [--scheme S] [--build-number N|auto] [--marketing-version 1.2] [--out build]',
    run: async (ctx) => {
      const n = ctx.flags['build-number'] === 'auto' ? await nextBuildNumber(ctx, await resolveApp(ctx)) : ctx.flags['build-number'];
      console.log(await archive(ctx, { buildNumber: n, marketingVersion: ctx.flags['marketing-version'] }));
    },
  },
  {
    name: 'export',
    summary: 'xcodebuild -exportArchive using the configured ExportOptions plist.',
    usage: 'asc export --archive build/App.xcarchive [--export-options asc/ExportOptions-appstore.plist]',
    run: async (ctx) => {
      if (!ctx.flags.archive) throw new UserError('--archive is required');
      console.log(await exportArchive(ctx, path.resolve(ctx.flags.archive)));
    },
  },
  {
    name: 'ship',
    summary: 'End-to-end: archive → export → upload → wait for processing → (TestFlight groups, what\'s new, beta review) → optional App Store version attach.',
    usage: 'asc ship [--build-number auto|N] [--marketing-version X] [--group "Beta Testers,Internal"] [--notify] [--submit-beta] [--attach] [--skip-archive --ipa file] [--no-wait]',
    options: [['--build-number', '"auto" = latest + 1 (default auto)'], ['--group', 'TestFlight group names/ids to add the build to (default: .asc.json testflight.groups)'], ['--notify', 'Notify testers'], ['--submit-beta', 'Submit for external TestFlight beta review'], ['--attach', 'Attach the build to the editable App Store version'], ['--skip-archive', 'Reuse an existing artifact'], ['--ipa', 'Artifact path with --skip-archive'], ['--no-wait', 'Do not wait for processing (disables later steps)']],
    bool: ['notify', 'submit-beta', 'attach', 'skip-archive', 'wait'],
    run: async (ctx) => {
      const f = ctx.flags;
      const appId = await resolveApp(ctx);
      let number = f['build-number'] ?? 'auto';
      if (number === 'auto') number = String(await nextBuildNumber(ctx, appId));
      let artifact = f.ipa;
      if (!f['skip-archive']) artifact = await exportArchive(ctx, await archive(ctx, { buildNumber: number, marketingVersion: f['marketing-version'] }));
      if (!artifact) throw new UserError('--skip-archive requires --ipa <file>');
      const deliveryId = await uploadFile(ctx, artifact);
      if (f.wait === false) return console.log(color.yellow('Skipping wait; run `asc builds wait --number ' + number + '` later.'));

      console.log(color.bold('Waiting for processing …'));
      const build = await waitForBuild(ctx, appId, number, { deliveryId });
      const tf = await import('./testflight.mjs');
      const groups = f.group ? csv(f.group) : ctx.cfg.testflight?.groups ?? [];
      const notesFile = path.resolve(ctx.cfg._projectRoot, ctx.cfg.testflight?.whatsNewFile ?? '');
      const notes = ctx.cfg.testflight?.whatsNewFile && fs.existsSync(notesFile) ? fs.readFileSync(notesFile, 'utf8').trim() : '';
      if (notes) await tf.setBuildWhatsNew(ctx, build.id, ctx.flags.locale ?? 'en-US', notes);
      if (groups.length) await tf.addBuildToGroups(ctx, appId, build.id, groups);
      if (f['submit-beta']) await tf.submitBeta(ctx, build.id);
      if (f.attach) {
        const { resolveVersion } = await import('../core.mjs');
        const v = await resolveVersion(ctx, appId, 'editable');
        await ctx.client.patch(`/v1/appStoreVersions/${v.id}/relationships/build`, { data: { type: 'builds', id: build.id } });
        console.log(`${color.green('✔')} Attached build ${number} to App Store version ${v.attributes.versionString}`);
      }
      console.log(`\n${color.green('✔')} Shipped build ${number} (${build.id}). Next: ${color.bold('asc readiness')}`);
    },
  },
];
