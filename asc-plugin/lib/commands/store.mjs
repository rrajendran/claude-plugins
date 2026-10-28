import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { platform, resolveApp, resolveAppInfo, resolveVersion, upsertByLocale, versionState } from '../core.mjs';
import { color, compact, csv, emit, expandHome, flat, normPlatform, parseKV, payload, printKV, shortDate, table, textFlag, UserError } from '../util.mjs';

const VERSION_LOC_FIELDS = { description: 'description', keywords: 'keywords', whatsNew: 'whats_new', promotionalText: 'promotional_text', supportUrl: 'support_url', marketingUrl: 'marketing_url' };
const INFO_LOC_FIELDS = { name: 'name', subtitle: 'subtitle', privacyPolicyUrl: 'privacy_policy_url', privacyChoicesUrl: 'privacy_choices_url' };

const versionLocUpsert = (ctx, versionId, locale, attributes) =>
  upsertByLocale({ client: ctx.client, listPath: `/v1/appStoreVersions/${versionId}/appStoreVersionLocalizations`, type: 'appStoreVersionLocalizations', locale, attributes, parentRel: ['appStoreVersion', 'appStoreVersions', versionId] });
const infoLocUpsert = (ctx, infoId, locale, attributes) =>
  upsertByLocale({ client: ctx.client, listPath: `/v1/appInfos/${infoId}/appInfoLocalizations`, type: 'appInfoLocalizations', locale, attributes, parentRel: ['appInfo', 'appInfos', infoId] });

async function uploadAsset(ctx, type, attrs, rel, file) {
  const bytes = fs.readFileSync(file);
  const r = await ctx.client.post(`/v1/${type}`, payload(type, { fileName: path.basename(file), fileSize: bytes.length }, rel));
  const id = r.data.id;
  for (const op of r.data.attributes.uploadOperations ?? []) {
    const res = await fetch(op.url, {
      method: op.method,
      headers: Object.fromEntries((op.requestHeaders ?? []).map((h) => [h.name, h.value])),
      body: bytes.subarray(op.offset, op.offset + op.length),
    });
    if (!res.ok) throw new UserError(`Asset chunk upload failed: HTTP ${res.status}`);
  }
  await ctx.client.patch(`/v1/${type}/${id}`, { data: { type, id, attributes: { uploaded: true, sourceFileChecksum: crypto.createHash('md5').update(bytes).digest('hex') } } });
  return id;
}

export default [
  // ------------------------------------------------------------ app-level
  {
    name: 'apps set',
    summary: 'Update app-level attributes (content rights, primary locale, bundle/sku are immutable).',
    usage: 'asc apps set --content-rights DOES_NOT_USE_THIRD_PARTY_CONTENT|USES_THIRD_PARTY_CONTENT [--primary-locale en-US]',
    options: [['--content-rights', 'Content rights declaration'], ['--primary-locale', 'Primary locale']],
    run: async (ctx) => {
      const id = await resolveApp(ctx);
      const attributes = compact({ contentRightsDeclaration: ctx.flags['content-rights'], primaryLocale: ctx.flags['primary-locale'] });
      if (!Object.keys(attributes).length) throw new UserError('Nothing to update.');
      await ctx.client.patch(`/v1/apps/${id}`, { data: { type: 'apps', id, attributes } });
      console.log(`${color.green('✔')} App updated`);
    },
  },

  // ------------------------------------------------------------ versions
  {
    name: 'versions list',
    summary: 'List App Store versions for the app.',
    options: [['--app', 'App'], ['--platform', 'ios|macos|tvos|visionos (default from config, else ios)']],
    run: async (ctx) => {
      const id = await resolveApp(ctx);
      const { data } = await ctx.client.list(`/v1/apps/${id}/appStoreVersions`, ctx.flags.platform ? { 'filter[platform]': platform(ctx) } : {});
      const rows = data.map(flat);
      emit(ctx, rows, () => console.log(table(rows, [['ID', 'id'], ['Platform', 'platform'], ['Version', 'versionString'], ['State', (v) => versionState(v)], ['Release', 'releaseType'], ['Created', (v) => shortDate(v.createdDate)]])));
    },
  },
  {
    name: 'versions create',
    summary: 'Create a new App Store version in PREPARE_FOR_SUBMISSION.',
    usage: 'asc versions create --version 1.1 [--release-type MANUAL|AFTER_APPROVAL|SCHEDULED] [--earliest-release 2026-01-01T10:00:00Z] [--copyright "© 2026 Acme"]',
    options: [['--version', 'Marketing version string'], ['--release-type', 'MANUAL | AFTER_APPROVAL | SCHEDULED'], ['--earliest-release', 'ISO date for SCHEDULED'], ['--copyright', 'Copyright line']],
    run: async (ctx) => {
      const f = ctx.flags;
      if (!f.version) throw new UserError('--version is required');
      const id = await resolveApp(ctx);
      const attributes = compact({ platform: platform(ctx), versionString: String(f.version), releaseType: f['release-type'], earliestReleaseDate: f['earliest-release'], copyright: f.copyright });
      const r = await ctx.client.post('/v1/appStoreVersions', payload('appStoreVersions', attributes, { app: ['apps', id] }));
      console.log(`${color.green('✔')} Created ${attributes.platform} version ${f.version} (id ${r.data.id})`);
    },
  },
  {
    name: 'versions update',
    summary: 'Update version attributes.',
    usage: 'asc versions update [--version latest|<id>|1.1] [--release-type …] [--copyright …] [--new-version 1.2]',
    run: async (ctx) => {
      const id = await resolveApp(ctx);
      const v = await resolveVersion(ctx, id);
      const f = ctx.flags;
      const attributes = compact({ versionString: f['new-version'], releaseType: f['release-type'], earliestReleaseDate: f['earliest-release'], copyright: f.copyright });
      await ctx.client.patch(`/v1/appStoreVersions/${v.id}`, { data: { type: 'appStoreVersions', id: v.id, attributes } });
      console.log(`${color.green('✔')} Updated ${v.attributes.versionString}`);
    },
  },
  {
    name: 'versions set-build',
    summary: 'Attach a processed build to a version.',
    usage: 'asc versions set-build --build <buildId | latest | number> [--version latest]',
    options: [['--build', 'Build id, build number, or "latest"']],
    run: async (ctx) => {
      const id = await resolveApp(ctx);
      const v = await resolveVersion(ctx, id);
      const buildId = await (await import('./builds.mjs')).resolveBuild(ctx, id, ctx.flags.build ?? 'latest');
      await ctx.client.patch(`/v1/appStoreVersions/${v.id}/relationships/build`, { data: { type: 'builds', id: buildId } });
      console.log(`${color.green('✔')} Build ${buildId} attached to ${v.attributes.versionString}`);
    },
  },
  {
    name: 'versions delete',
    summary: 'Delete a version that has not been submitted.',
    usage: 'asc versions delete --version <id|1.1> --yes',
    bool: ['yes'],
    run: async (ctx) => {
      if (!ctx.flags.yes) throw new UserError('Re-run with --yes.');
      const v = await resolveVersion(ctx, await resolveApp(ctx));
      await ctx.client.del(`/v1/appStoreVersions/${v.id}`);
      console.log(`${color.green('✔')} Deleted ${v.attributes.versionString}`);
    },
  },
  {
    name: 'versions release',
    summary: 'Release an approved version that is PENDING_DEVELOPER_RELEASE (manual release).',
    usage: 'asc versions release [--version latest]',
    run: async (ctx) => {
      const v = await resolveVersion(ctx, await resolveApp(ctx));
      await ctx.client.post('/v1/appStoreVersionReleaseRequests', payload('appStoreVersionReleaseRequests', undefined, { appStoreVersion: ['appStoreVersions', v.id] }));
      console.log(`${color.green('✔')} Release requested for ${v.attributes.versionString}`);
    },
  },
  {
    name: 'versions phased-release',
    summary: 'Enable 7-day phased release for a version.',
    usage: 'asc versions phased-release [--version latest]',
    run: async (ctx) => {
      const v = await resolveVersion(ctx, await resolveApp(ctx));
      await ctx.client.post('/v1/appStoreVersionPhasedReleases', payload('appStoreVersionPhasedReleases', { phasedReleaseState: 'INACTIVE' }, { appStoreVersion: ['appStoreVersions', v.id] }));
      console.log(`${color.green('✔')} Phased release enabled for ${v.attributes.versionString}`);
    },
  },

  // ------------------------------------------------------------ localizations
  {
    name: 'loc list',
    summary: 'List version localizations (description, keywords, what\'s new …).',
    options: [['--version', 'Version id, string, latest, editable']],
    run: async (ctx) => {
      const v = await resolveVersion(ctx, await resolveApp(ctx));
      const { data } = await ctx.client.list(`/v1/appStoreVersions/${v.id}/appStoreVersionLocalizations`);
      const rows = data.map(flat);
      emit(ctx, rows, () => console.log(table(rows, [['ID', 'id'], ['Locale', 'locale'], ['Description', (l) => (l.description ?? '').length + ' chars'], ['Keywords', 'keywords'], ['Whats new', (l) => (l.whatsNew ?? '').length + ' chars'], ['Support URL', 'supportUrl']])));
    },
  },
  {
    name: 'loc set',
    summary: 'Create/update a version localization. Text flags also accept <flag>-file.',
    usage: 'asc loc set --locale en-US [--description T] [--keywords "a,b"] [--whats-new T] [--promo T] [--support-url U] [--marketing-url U] [--version latest]',
    options: [['--locale', 'e.g. en-US (required)'], ['--description / --description-file', 'App description'], ['--keywords', 'Comma list ≤100 chars'], ['--whats-new / --whats-new-file', 'Release notes'], ['--promo', 'Promotional text'], ['--support-url', 'Support URL'], ['--marketing-url', 'Marketing URL']],
    run: async (ctx) => {
      const f = ctx.flags;
      if (!f.locale) throw new UserError('--locale is required');
      const v = await resolveVersion(ctx, await resolveApp(ctx));
      const attributes = compact({ description: textFlag(f, 'description'), keywords: f.keywords, whatsNew: textFlag(f, 'whats-new'), promotionalText: textFlag(f, 'promo'), supportUrl: f['support-url'], marketingUrl: f['marketing-url'] });
      const r = await versionLocUpsert(ctx, v.id, f.locale, attributes);
      console.log(`${color.green('✔')} ${f.locale} localization saved (id ${r.id})`);
    },
  },

  // ------------------------------------------------------------ app info
  {
    name: 'app-info show',
    summary: 'Show app info: categories, state, and localized name/subtitle/privacy URL.',
    run: async (ctx) => {
      const appId = await resolveApp(ctx);
      const info = await resolveAppInfo(ctx, appId);
      const [locs, primary, secondary] = await Promise.all([
        ctx.client.list(`/v1/appInfos/${info.id}/appInfoLocalizations`),
        ctx.client.getOptional(`/v1/appInfos/${info.id}/primaryCategory`),
        ctx.client.getOptional(`/v1/appInfos/${info.id}/secondaryCategory`),
      ]);
      const out = { appInfo: flat(info), primaryCategory: primary?.data?.id ?? null, secondaryCategory: secondary?.data?.id ?? null, localizations: locs.data.map(flat) };
      emit(ctx, out, () => {
        printKV({ id: info.id, state: versionState(info.attributes), primaryCategory: out.primaryCategory, secondaryCategory: out.secondaryCategory });
        console.log('\n' + table(out.localizations, [['ID', 'id'], ['Locale', 'locale'], ['Name', 'name'], ['Subtitle', 'subtitle'], ['Privacy URL', 'privacyPolicyUrl']]));
      });
    },
  },
  {
    name: 'app-info set',
    summary: 'Set localized name/subtitle/privacy URLs and optionally categories.',
    usage: 'asc app-info set --locale en-US [--name N] [--subtitle S] [--privacy-url U] [--privacy-choices-url U] [--primary-category UTILITIES] [--secondary-category PRODUCTIVITY]',
    run: async (ctx) => {
      const f = ctx.flags;
      const info = await resolveAppInfo(ctx, await resolveApp(ctx));
      if (f.locale) {
        await infoLocUpsert(ctx, info.id, f.locale, compact({ name: f.name, subtitle: f.subtitle, privacyPolicyUrl: f['privacy-url'], privacyChoicesUrl: f['privacy-choices-url'] }));
        console.log(`${color.green('✔')} ${f.locale} app info saved`);
      }
      if (f['primary-category'] || f['secondary-category']) {
        const rels = {};
        if (f['primary-category']) rels.primaryCategory = ['appCategories', f['primary-category'].toUpperCase()];
        if (f['secondary-category']) rels.secondaryCategory = ['appCategories', f['secondary-category'].toUpperCase()];
        await ctx.client.patch(`/v1/appInfos/${info.id}`, payload('appInfos', undefined, rels, info.id));
        console.log(`${color.green('✔')} categories saved`);
      }
    },
  },
  {
    name: 'categories',
    summary: 'List valid App Store category ids (use with app-info set).',
    run: async (ctx) => {
      const { data } = await ctx.client.list('/v1/appCategories', { 'filter[platforms]': platform(ctx), exists: undefined });
      const rows = data.map((c) => ({ id: c.id, platforms: (c.attributes.platforms ?? []).join(',') }));
      emit(ctx, rows, () => console.log(table(rows, [['Category', 'id'], ['Platforms', 'platforms']])));
    },
  },
  {
    name: 'age-rating show',
    summary: 'Show the age rating declaration.',
    run: async (ctx) => {
      const info = await resolveAppInfo(ctx, await resolveApp(ctx));
      const r = await ctx.client.get(`/v1/appInfos/${info.id}/ageRatingDeclaration`);
      emit(ctx, flat(r.data), () => printKV(flat(r.data)));
    },
  },
  {
    name: 'age-rating set',
    summary: 'Set age rating answers as key=value pairs (NONE|INFREQUENT_OR_MILD|FREQUENT_OR_INTENSE for levels, true|false for flags).',
    usage: 'asc age-rating set violenceCartoonOrFantasy=NONE gambling=false unrestrictedWebAccess=false …',
    examples: ['asc age-rating set alcoholTobaccoOrDrugUseOrReferences=NONE gambling=false unrestrictedWebAccess=false'],
    run: async (ctx) => {
      const attributes = parseKV(ctx.args);
      if (!Object.keys(attributes).length) throw new UserError('Pass key=value pairs; see `asc age-rating show` for the key names.');
      const info = await resolveAppInfo(ctx, await resolveApp(ctx));
      const r = await ctx.client.get(`/v1/appInfos/${info.id}/ageRatingDeclaration`);
      await ctx.client.patch(`/v1/ageRatingDeclarations/${r.data.id}`, { data: { type: 'ageRatingDeclarations', id: r.data.id, attributes } });
      console.log(`${color.green('✔')} Age rating updated (${Object.keys(attributes).length} fields)`);
    },
  },

  // ------------------------------------------------------------ screenshots
  {
    name: 'screenshots list',
    summary: 'List screenshot sets and counts for each locale.',
    run: async (ctx) => {
      const v = await resolveVersion(ctx, await resolveApp(ctx));
      const locs = await ctx.client.list(`/v1/appStoreVersions/${v.id}/appStoreVersionLocalizations`);
      const rows = [];
      for (const l of locs.data) {
        const sets = await ctx.client.list(`/v1/appStoreVersionLocalizations/${l.id}/appScreenshotSets`, { include: 'appScreenshots', 'limit[appScreenshots]': 50 });
        for (const s of sets.data) {
          const shots = (s.relationships.appScreenshots?.data ?? []).length;
          rows.push({ locale: l.attributes.locale, localizationId: l.id, setId: s.id, displayType: s.attributes.screenshotDisplayType, count: shots });
        }
      }
      emit(ctx, rows, () => console.log(table(rows, [['Locale', 'locale'], ['Display type', 'displayType'], ['Count', 'count'], ['Set ID', 'setId'], ['Localization ID', 'localizationId']])));
    },
  },
  {
    name: 'screenshots upload',
    summary: 'Upload screenshots into a display-type set (creates the set if needed).',
    usage: 'asc screenshots upload --locale en-US --display-type APP_IPHONE_67 --files a.png,b.png [--replace]',
    options: [['--locale', 'Locale (default en-US)'], ['--display-type', 'APP_IPHONE_67, APP_IPHONE_65, APP_IPHONE_61, APP_IPAD_PRO_3GEN_129, APP_IPAD_PRO_129, APP_DESKTOP, APP_APPLE_TV, APP_APPLE_VISION_PRO …'], ['--files', 'Comma list of PNG/JPEG files, or a directory'], ['--replace', 'Delete existing screenshots in the set first']],
    bool: ['replace'],
    run: async (ctx) => {
      const f = ctx.flags;
      if (!f['display-type'] || !f.files) throw new UserError('--display-type and --files are required');
      let files = csv(f.files).map(expandHome);
      if (files.length === 1 && fs.statSync(files[0]).isDirectory()) files = fs.readdirSync(files[0]).filter((n) => /\.(png|jpe?g)$/i.test(n)).sort().map((n) => path.join(files[0], n));
      const v = await resolveVersion(ctx, await resolveApp(ctx));
      const loc = await versionLocUpsert(ctx, v.id, f.locale ?? 'en-US', {});
      const sets = await ctx.client.list(`/v1/appStoreVersionLocalizations/${loc.id}/appScreenshotSets`, { include: 'appScreenshots' });
      const type = f['display-type'].toUpperCase();
      let set = sets.data.find((s) => s.attributes.screenshotDisplayType === type);
      if (!set) set = (await ctx.client.post('/v1/appScreenshotSets', payload('appScreenshotSets', { screenshotDisplayType: type }, { appStoreVersionLocalization: ['appStoreVersionLocalizations', loc.id] }))).data;
      else if (f.replace) for (const s of set.relationships.appScreenshots?.data ?? []) await ctx.client.del(`/v1/appScreenshots/${s.id}`);
      for (const file of files) {
        process.stdout.write(`  ${path.basename(file)} … `);
        await uploadAsset(ctx, 'appScreenshots', {}, { appScreenshotSet: ['appScreenshotSets', set.id] }, file);
        console.log(color.green('uploaded'));
      }
    },
  },
  {
    name: 'screenshots delete',
    summary: 'Delete a screenshot by id.',
    usage: 'asc screenshots delete <screenshotId>',
    run: async (ctx) => {
      await ctx.client.del(`/v1/appScreenshots/${ctx.args[0]}`);
      console.log(`${color.green('✔')} Deleted`);
    },
  },

  // ------------------------------------------------------------ review
  {
    name: 'review details show',
    summary: 'Show App Review contact + demo account details.',
    run: async (ctx) => {
      const v = await resolveVersion(ctx, await resolveApp(ctx));
      const r = await ctx.client.getOptional(`/v1/appStoreVersions/${v.id}/appStoreReviewDetail`);
      if (!r?.data) return console.log(color.yellow('No review details set. Use `asc review details set`.'));
      emit(ctx, flat(r.data), () => printKV({ ...flat(r.data), demoAccountPassword: r.data.attributes.demoAccountPassword ? '********' : '' }));
    },
  },
  {
    name: 'review details set',
    summary: 'Set App Review contact info, demo account and notes.',
    usage: 'asc review details set --first Ada --last Lovelace --phone +14155550100 --email a@x.com [--demo-required --demo-user u --demo-password p] [--notes T | --notes-file f]',
    bool: ['demo-required'],
    run: async (ctx) => {
      const f = ctx.flags;
      const v = await resolveVersion(ctx, await resolveApp(ctx));
      const attributes = compact({
        contactFirstName: f.first, contactLastName: f.last, contactPhone: f.phone, contactEmail: f.email,
        demoAccountRequired: f['demo-required'] === undefined ? undefined : !!f['demo-required'],
        demoAccountName: f['demo-user'], demoAccountPassword: f['demo-password'], notes: textFlag(f, 'notes'),
      });
      const cur = await ctx.client.getOptional(`/v1/appStoreVersions/${v.id}/appStoreReviewDetail`);
      if (cur?.data) await ctx.client.patch(`/v1/appStoreReviewDetails/${cur.data.id}`, { data: { type: 'appStoreReviewDetails', id: cur.data.id, attributes } });
      else await ctx.client.post('/v1/appStoreReviewDetails', payload('appStoreReviewDetails', attributes, { appStoreVersion: ['appStoreVersions', v.id] }));
      console.log(`${color.green('✔')} Review details saved`);
    },
  },
  {
    name: 'review submit',
    summary: 'Submit a version for App Review. Run `asc readiness` first.',
    usage: 'asc review submit [--version latest] [--yes]',
    bool: ['yes'],
    run: async (ctx) => {
      if (!ctx.flags.yes) throw new UserError(`This sends the editable ${platform(ctx)} version to App Review and cannot be undone casually. Re-run with --yes to confirm.`);
      const appId = await resolveApp(ctx);
      const v = await resolveVersion(ctx, appId, ctx.flags.version ?? 'editable');
      const open = await ctx.client.list(`/v1/apps/${appId}/reviewSubmissions`, { 'filter[state]': 'READY_FOR_REVIEW', 'filter[platform]': platform(ctx) });
      const sub = open.data[0] ?? (await ctx.client.post('/v1/reviewSubmissions', payload('reviewSubmissions', { platform: platform(ctx) }, { app: ['apps', appId] }))).data;
      await ctx.client.post('/v1/reviewSubmissionItems', payload('reviewSubmissionItems', undefined, { reviewSubmission: ['reviewSubmissions', sub.id], appStoreVersion: ['appStoreVersions', v.id] }));
      await ctx.client.patch(`/v1/reviewSubmissions/${sub.id}`, { data: { type: 'reviewSubmissions', id: sub.id, attributes: { submitted: true } } });
      console.log(`${color.green('✔')} Submitted ${v.attributes.versionString} for review (submission ${sub.id})`);
    },
  },
  {
    name: 'review status',
    summary: 'Show review submissions and the current version state.',
    run: async (ctx) => {
      const appId = await resolveApp(ctx);
      const [subs, vers] = await Promise.all([ctx.client.list(`/v1/apps/${appId}/reviewSubmissions`), ctx.client.list(`/v1/apps/${appId}/appStoreVersions`)]);
      const out = { submissions: subs.data.map(flat), versions: vers.data.map(flat) };
      emit(ctx, out, () => {
        console.log(table(out.submissions, [['Submission', 'id'], ['Platform', 'platform'], ['State', 'state'], ['Submitted', (s) => shortDate(s.submittedDate)]]));
        console.log('\n' + table(out.versions, [['Version', 'versionString'], ['Platform', 'platform'], ['State', (v) => versionState(v)]]));
      });
    },
  },
  {
    name: 'review cancel',
    summary: 'Cancel a pending review submission (withdraw from review).',
    usage: 'asc review cancel <submissionId>',
    run: async (ctx) => {
      await ctx.client.patch(`/v1/reviewSubmissions/${ctx.args[0]}`, { data: { type: 'reviewSubmissions', id: ctx.args[0], attributes: { canceled: true } } });
      console.log(`${color.green('✔')} Cancel requested`);
    },
  },

  // ------------------------------------------------------------ pricing
  {
    name: 'pricing show',
    summary: 'Show the app price schedule (is a price set?).',
    run: async (ctx) => {
      const appId = await resolveApp(ctx);
      const r = await ctx.client.getOptional(`/v1/apps/${appId}/appPriceSchedule`, { include: 'baseTerritory' });
      emit(ctx, r, () => console.log(r?.data ? `${color.green('✔')} Price schedule ${r.data.id}, base territory ${r.included?.[0]?.id ?? '?'}` : color.yellow('No price schedule set.')));
    },
  },
  {
    name: 'pricing set-free',
    summary: 'Make the app free (base territory USA). For paid tiers use `asc api` with an appPricePoint id.',
    run: async (ctx) => {
      const appId = await resolveApp(ctx);
      const pts = await ctx.client.list(`/v1/apps/${appId}/appPricePoints`, { 'filter[territory]': 'USA' });
      const free = pts.data.find((p) => Number(p.attributes.customerPrice) === 0);
      if (!free) throw new UserError('Could not find the free price point.');
      await ctx.client.post('/v1/appPriceSchedules', {
        data: { type: 'appPriceSchedules', relationships: { app: { data: { type: 'apps', id: appId } }, baseTerritory: { data: { type: 'territories', id: 'USA' } }, manualPrices: { data: [{ type: 'appPrices', id: '${price0}' }] } } },
        included: [{ type: 'appPrices', id: '${price0}', attributes: { startDate: null }, relationships: { appPricePoint: { data: { type: 'appPricePoints', id: free.id } } } }],
      });
      console.log(`${color.green('✔')} App set to Free`);
    },
  },

  // ------------------------------------------------------------ metadata sync
  {
    name: 'metadata pull',
    summary: 'Download all localized metadata into <metadataDir>/<locale>/*.txt (version + app info).',
    usage: 'asc metadata pull [--dir asc/metadata] [--version latest]',
    run: async (ctx) => {
      const dir = path.resolve(ctx.cfg._projectRoot, ctx.flags.dir ?? ctx.cfg.metadataDir ?? 'asc/metadata');
      const appId = await resolveApp(ctx);
      const v = await resolveVersion(ctx, appId);
      const info = await resolveAppInfo(ctx, appId);
      const [vl, il] = await Promise.all([ctx.client.list(`/v1/appStoreVersions/${v.id}/appStoreVersionLocalizations`), ctx.client.list(`/v1/appInfos/${info.id}/appInfoLocalizations`)]);
      let n = 0;
      const put = (locale, file, value) => {
        fs.mkdirSync(path.join(dir, locale), { recursive: true });
        fs.writeFileSync(path.join(dir, locale, `${file}.txt`), value ?? '');
        n++;
      };
      for (const l of vl.data) for (const [k, file] of Object.entries(VERSION_LOC_FIELDS)) put(l.attributes.locale, file, l.attributes[k]);
      for (const l of il.data) for (const [k, file] of Object.entries(INFO_LOC_FIELDS)) put(l.attributes.locale, file, l.attributes[k]);
      console.log(`${color.green('✔')} Wrote ${n} files to ${dir}`);
    },
  },
  {
    name: 'metadata push',
    summary: 'Upload <metadataDir>/<locale>/*.txt to App Store Connect. Empty files are skipped (never wipe remote values).',
    usage: 'asc metadata push [--dir asc/metadata] [--version editable] [--dry-run]',
    bool: ['dry-run'],
    run: async (ctx) => {
      const dir = path.resolve(ctx.cfg._projectRoot, ctx.flags.dir ?? ctx.cfg.metadataDir ?? 'asc/metadata');
      if (!fs.existsSync(dir)) throw new UserError(`${dir} not found. Run \`asc init\` or \`asc metadata pull\`.`);
      const appId = await resolveApp(ctx);
      const v = await resolveVersion(ctx, appId, ctx.flags.version ?? 'editable');
      const info = await resolveAppInfo(ctx, appId);
      for (const locale of fs.readdirSync(dir).filter((d) => fs.statSync(path.join(dir, d)).isDirectory())) {
        const read = (file) => {
          const p = path.join(dir, locale, `${file}.txt`);
          const t = fs.existsSync(p) ? fs.readFileSync(p, 'utf8').replace(/\s+$/, '') : '';
          return t || undefined;
        };
        const va = compact(Object.fromEntries(Object.entries(VERSION_LOC_FIELDS).map(([k, file]) => [k, read(file)])));
        const ia = compact(Object.fromEntries(Object.entries(INFO_LOC_FIELDS).map(([k, file]) => [k, read(file)])));
        console.log(`${locale}: version[${Object.keys(va).join(', ') || '-'}] info[${Object.keys(ia).join(', ') || '-'}]`);
        if (ctx.flags['dry-run']) continue;
        if (Object.keys(va).length) await versionLocUpsert(ctx, v.id, locale, va);
        if (Object.keys(ia).length) await infoLocUpsert(ctx, info.id, locale, ia);
      }
      console.log(ctx.flags['dry-run'] ? color.yellow('Dry run — nothing sent.') : `${color.green('✔')} Metadata pushed to ${v.attributes.versionString}`);
    },
  },
];
