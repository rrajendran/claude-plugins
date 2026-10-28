import fs from 'node:fs';
import { AscError } from '../client.mjs';
import { EDITABLE_STATES, findBuilds, platform, resolveApp, versionState } from '../core.mjs';
import { color, emit, flat, run } from '../util.mjs';

const ICON = { pass: color.green('✔'), warn: color.yellow('▲'), fail: color.red('✘'), info: color.blue('ℹ') };

/** Collects check results; every check is isolated so one API failure never aborts the report. */
class Report {
  constructor() { this.items = []; this.section = ''; }
  at(name) { this.section = name; }
  add(status, name, detail = '') { this.items.push({ section: this.section, status, name, detail }); }
  pass(n, d) { this.add('pass', n, d); }
  warn(n, d) { this.add('warn', n, d); }
  fail(n, d) { this.add('fail', n, d); }
  info(n, d) { this.add('info', n, d); }
  async check(name, fn) {
    try { await fn(); } catch (e) { this.add('warn', name, `could not verify — ${e instanceof AscError ? `HTTP ${e.status} ${e.errors[0]?.title ?? ''}` : e.message}`); }
  }
  get counts() { return Object.fromEntries(['pass', 'warn', 'fail'].map((s) => [s, this.items.filter((i) => i.status === s).length])); }
}

const blank = (v) => v === undefined || v === null || String(v).trim() === '';

async function localChecks(ctx, r) {
  r.at('Local toolchain');
  await r.check('API key file', async () => {
    const mode = fs.statSync(ctx.client.keyPath).mode & 0o077;
    mode ? r.warn('API key file', `${ctx.client.keyPath} is readable by others — chmod 600`) : r.pass('API key file', ctx.client.keyPath);
  });
  const xc = await run('xcodebuild', ['-version'], { capture: true }).catch(() => ({ code: 1, out: '' }));
  xc.code === 0 ? r.pass('Xcode', xc.out.split('\n')[0]) : r.fail('Xcode', 'xcodebuild not found — install Xcode and run xcode-select --switch');
  const id = await run('security', ['find-identity', '-v', '-p', 'codesigning'], { capture: true }).catch(() => ({ code: 1, out: '' }));
  const dist = (id.out.match(/(Apple|iPhone) Distribution|3rd Party Mac Developer/g) ?? []).length;
  dist ? r.pass('Distribution signing identity', `${dist} found in keychain`) : r.info('Distribution signing identity', 'none in keychain — fine with -allowProvisioningUpdates + API key (cloud signing); otherwise `asc certs csr` / `asc certs create`');
  if (ctx.cfg._projectConfigPath) {
    r.pass('.asc.json', ctx.cfg._projectConfigPath);
    const plist = ctx.cfg.exportOptions;
    plist && !fs.existsSync(`${ctx.cfg._projectRoot}/${plist}`) ? r.warn('ExportOptions plist', `${plist} missing — run asc init`) : r.pass('ExportOptions plist', plist ?? '(default)');
  } else r.warn('.asc.json', 'not found — run `asc init` to generate project configs');
}

async function appChecks(ctx, r, appId) {
  r.at('App record');
  const app = flat((await ctx.client.get(`/v1/apps/${appId}`)).data);
  r.pass('App exists', `${app.name} (${app.bundleId}), primary locale ${app.primaryLocale}`);
  blank(app.contentRightsDeclaration) ? r.fail('Content rights declaration', 'not set — `asc apps set --content-rights DOES_NOT_USE_THIRD_PARTY_CONTENT`') : r.pass('Content rights declaration', app.contentRightsDeclaration);
  await r.check('Bundle ID', async () => {
    const { data } = await ctx.client.list('/v1/bundleIds', { 'filter[identifier]': app.bundleId });
    data.length ? r.pass('Bundle ID registered', app.bundleId) : r.warn('Bundle ID registered', 'no matching record (may be fine for wildcard)');
  });
  return app;
}

async function versionChecks(ctx, r, appId) {
  r.at('App Store version');
  const plat = platform(ctx);
  const { data } = await ctx.client.list(`/v1/apps/${appId}/appStoreVersions`, { 'filter[platform]': plat });
  const sorted = data.sort((a, b) => (b.attributes.createdDate ?? '').localeCompare(a.attributes.createdDate ?? ''));
  const v = sorted.find((x) => EDITABLE_STATES.includes(versionState(x.attributes))) ?? sorted[0];
  if (!v) { r.fail(`${plat} version`, 'no version exists — `asc versions create --version 1.0`'); return null; }
  const state = versionState(v.attributes);
  EDITABLE_STATES.includes(state) ? r.pass(`${plat} version ${v.attributes.versionString}`, state) : r.warn(`${plat} version ${v.attributes.versionString}`, `state is ${state} — not editable; create a new version to submit again`);

  await r.check('Build attached', async () => {
    const b = await ctx.client.getOptional(`/v1/appStoreVersions/${v.id}/build`);
    if (!b?.data) return r.fail('Build attached', 'no build selected — `asc versions set-build --build latest`');
    const a = b.data.attributes;
    a.processingState === 'VALID' && !a.expired ? r.pass('Build attached', `build ${a.version} (VALID)`) : r.fail('Build attached', `build ${a.version} is ${a.expired ? 'EXPIRED' : a.processingState}`);
    a.usesNonExemptEncryption === null || a.usesNonExemptEncryption === undefined
      ? r.fail('Export compliance', 'unanswered — `asc builds encryption latest --uses-encryption false` or set ITSAppUsesNonExemptEncryption=NO in Info.plist')
      : r.pass('Export compliance', `usesNonExemptEncryption=${a.usesNonExemptEncryption}`);
  });

  await r.check('Localizations', async () => {
    const locs = (await ctx.client.list(`/v1/appStoreVersions/${v.id}/appStoreVersionLocalizations`)).data;
    if (!locs.length) return r.fail('Version localizations', 'none — `asc loc set --locale en-US …`');
    for (const l of locs) {
      const a = l.attributes;
      const missing = ['description', 'keywords', 'supportUrl'].filter((k) => blank(a[k]));
      missing.length ? r.fail(`Metadata [${a.locale}]`, `missing ${missing.join(', ')}`) : r.pass(`Metadata [${a.locale}]`, 'description, keywords, support URL present');
      if (blank(a.whatsNew) && sorted.length > 1) r.warn(`What's New [${a.locale}]`, 'empty (required for updates)');
      if (a.keywords && a.keywords.length > 100) r.fail(`Keywords [${a.locale}]`, `${a.keywords.length} chars > 100 limit`);
    }
    r.at('Screenshots');
    for (const l of locs) {
      const sets = await ctx.client.list(`/v1/appStoreVersionLocalizations/${l.id}/appScreenshotSets`, { include: 'appScreenshots', 'limit[appScreenshots]': 50 });
      const shots = Object.fromEntries(sets.included.filter((i) => i.type === 'appScreenshots').map((i) => [i.id, i.attributes]));
      if (!sets.data.length) { r.fail(`Screenshots [${l.attributes.locale}]`, 'no screenshot sets — `asc screenshots upload`'); continue; }
      for (const s of sets.data) {
        const ids = (s.relationships.appScreenshots?.data ?? []).map((x) => x.id);
        const bad = ids.filter((id) => ['FAILED', 'UPLOAD_FAILED'].includes(shots[id]?.assetDeliveryState?.state));
        const label = `Screenshots [${l.attributes.locale}] ${s.attributes.screenshotDisplayType}`;
        if (!ids.length) r.fail(label, 'empty set');
        else if (bad.length) r.fail(label, `${bad.length} failed asset(s)`);
        else r.pass(label, `${ids.length} screenshot(s)`);
      }
    }
  });

  r.at('App Review');
  await r.check('Review details', async () => {
    const d = await ctx.client.getOptional(`/v1/appStoreVersions/${v.id}/appStoreReviewDetail`);
    const a = d?.data?.attributes;
    if (!a) return r.fail('Review contact', 'not set — `asc review details set …`');
    const missing = ['contactFirstName', 'contactLastName', 'contactPhone', 'contactEmail'].filter((k) => blank(a[k]));
    missing.length ? r.fail('Review contact', `missing ${missing.join(', ')}`) : r.pass('Review contact', `${a.contactFirstName} ${a.contactLastName}`);
    if (a.demoAccountRequired) (blank(a.demoAccountName) || blank(a.demoAccountPassword)) ? r.fail('Demo account', 'marked required but username/password missing') : r.pass('Demo account', a.demoAccountName);
    else r.info('Demo account', 'not required');
  });
  return v;
}

async function infoChecks(ctx, r, appId) {
  r.at('App information');
  const { data } = await ctx.client.list(`/v1/apps/${appId}/appInfos`);
  const info = data.find((i) => EDITABLE_STATES.includes(versionState(i.attributes))) ?? data[0];
  if (!info) return r.fail('App info', 'no appInfo record');
  await r.check('Categories', async () => {
    const p = await ctx.client.getOptional(`/v1/appInfos/${info.id}/primaryCategory`);
    p?.data ? r.pass('Primary category', p.data.id) : r.fail('Primary category', 'not set — `asc app-info set --primary-category UTILITIES` (see `asc categories`)');
  });
  await r.check('App info localizations', async () => {
    const locs = (await ctx.client.list(`/v1/appInfos/${info.id}/appInfoLocalizations`)).data;
    if (!locs.length) return r.fail('App info localizations', 'none');
    for (const l of locs) {
      blank(l.attributes.name) ? r.fail(`App name [${l.attributes.locale}]`, 'empty') : r.pass(`App name [${l.attributes.locale}]`, l.attributes.name);
      blank(l.attributes.privacyPolicyUrl) ? r.fail(`Privacy policy URL [${l.attributes.locale}]`, 'required — `asc app-info set --locale … --privacy-url …`') : r.pass(`Privacy policy URL [${l.attributes.locale}]`, l.attributes.privacyPolicyUrl);
    }
  });
  await r.check('Age rating', async () => {
    const a = (await ctx.client.get(`/v1/appInfos/${info.id}/ageRatingDeclaration`)).data.attributes;
    const nulls = Object.entries(a).filter(([k, v]) => v === null && !['kidsAgeBand', 'ageRatingOverride', 'ageRatingOverrideV2', 'koreaAgeRatingOverride', 'socialMediaAgeRestricted', 'gracRatingClassificationNumber', 'developerAgeRatingInfoUrl'].includes(k)).map(([k]) => k);
    nulls.length ? r.fail('Age rating', `unanswered: ${nulls.slice(0, 6).join(', ')}${nulls.length > 6 ? ` +${nulls.length - 6}` : ''}`) : r.pass('Age rating', 'all questions answered');
  });
}

async function commerceChecks(ctx, r, appId) {
  r.at('Pricing & availability');
  await r.check('Price schedule', async () => {
    const p = await ctx.client.getOptional(`/v1/apps/${appId}/appPriceSchedule`);
    p?.data ? r.pass('Price schedule', 'set') : r.fail('Price schedule', 'not set — `asc pricing set-free` or set in the web UI');
  });
  await r.check('Availability', async () => {
    const a = (await ctx.client.getOptional(`/v1/apps/${appId}/appAvailabilityV2`)) ?? (await ctx.client.getOptional(`/v1/apps/${appId}/appAvailability`));
    a?.data ? r.pass('Territory availability', 'configured') : r.fail('Territory availability', 'not configured — set in App Store Connect → Pricing and Availability');
  });
}

async function testflightChecks(ctx, r, appId) {
  r.at('TestFlight');
  const builds = await findBuilds(ctx, appId, { limit: 5 });
  if (!builds.length) return r.warn('Builds', 'no builds uploaded yet — `asc ship` or `asc upload`');
  const b = builds[0];
  b.processingState === 'VALID' ? r.pass('Latest build', `${b.marketingVersion} (${b.version}) VALID`) : r.warn('Latest build', `${b.marketingVersion} (${b.version}) is ${b.processingState}`);
  await r.check('Beta detail', async () => {
    const d = await ctx.client.getOptional(`/v1/builds/${b.id}/buildBetaDetail`);
    if (d?.data) r.info('TestFlight states', `internal=${d.data.attributes.internalBuildState}, external=${d.data.attributes.externalBuildState}`);
  });
  await r.check('Test information', async () => {
    const locs = (await ctx.client.list(`/v1/apps/${appId}/betaAppLocalizations`)).data;
    locs.some((l) => !blank(l.attributes.description) && !blank(l.attributes.feedbackEmail)) ? r.pass('Beta app description + feedback email', `${locs.length} locale(s)`) : r.warn('Beta app description + feedback email', 'needed for external testing — `asc tf info set …`');
    const rd = await ctx.client.getOptional(`/v1/apps/${appId}/betaAppReviewDetail`);
    const a = rd?.data?.attributes;
    a && !['contactFirstName', 'contactLastName', 'contactPhone', 'contactEmail'].some((k) => blank(a[k])) ? r.pass('Beta review contact', a.contactEmail) : r.warn('Beta review contact', 'incomplete — needed for external testing');
  });
  await r.check('Groups', async () => {
    const g = (await ctx.client.list('/v1/betaGroups', { 'filter[app]': appId })).data;
    g.length ? r.pass('TestFlight groups', g.map((x) => x.attributes.name).join(', ')) : r.warn('TestFlight groups', 'none — `asc tf groups create --name Beta`');
  });
}

export default [
  {
    name: 'readiness',
    summary: 'Audit whether the app is ready for TestFlight and App Store submission. Exits 1 if any blocking check fails.',
    usage: 'asc readiness [--app …] [--platform ios|macos|tvos|visionos] [--only appstore|testflight|local] [--json]',
    options: [['--only', 'Limit to local | appstore | testflight'], ['--platform', 'Platform to audit (default ios)']],
    examples: ['asc readiness', 'asc readiness --platform macos', 'asc readiness --only testflight --json'],
    run: async (ctx) => {
      const r = new Report();
      const only = ctx.flags.only;
      const appId = await resolveApp(ctx);
      if (!only || only === 'local') await localChecks(ctx, r);
      r.at('Authentication');
      r.pass('API credentials', `key ${ctx.client.keyId}`);
      if (!only || only === 'appstore') {
        await appChecks(ctx, r, appId);
        await versionChecks(ctx, r, appId);
        await infoChecks(ctx, r, appId);
        await commerceChecks(ctx, r, appId);
        r.at('Manual items (not exposed by the API)');
        r.info('App Privacy "nutrition label"', 'confirm in App Store Connect → App Privacy; submission is blocked without it');
        r.info('Tax, banking, agreements', 'Paid Apps agreement must be active for paid apps / IAP');
      }
      if (!only || only === 'testflight') await testflightChecks(ctx, r, appId);

      emit(ctx, { summary: r.counts, checks: r.items }, () => {
        let sec = '';
        for (const i of r.items) {
          if (i.section !== sec) { sec = i.section; console.log(`\n${color.bold(sec)}`); }
          console.log(`  ${ICON[i.status]} ${i.name}${i.detail ? color.dim(` — ${i.detail}`) : ''}`);
        }
        const c = r.counts;
        console.log(`\n${c.fail ? color.red('NOT READY') : color.green('READY')}  ${color.green(`${c.pass} passed`)}, ${color.yellow(`${c.warn} warnings`)}, ${color.red(`${c.fail} blocking`)}`);
      });
      if (r.counts.fail) process.exitCode = 1;
    },
  },
];
