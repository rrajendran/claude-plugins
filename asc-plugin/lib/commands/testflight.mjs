import { findBuilds, resolveApp, upsertByLocale } from '../core.mjs';
import { color, compact, csv, emit, flat, payload, printKV, shortDate, table, textFlag, UserError } from '../util.mjs';
import { resolveBuild } from './builds.mjs';

/** Group ref (id or name) → group resource, searching the app's groups. */
async function resolveGroups(ctx, appId, refs) {
  const { data } = await ctx.client.list('/v1/betaGroups', { 'filter[app]': appId });
  return refs.map((ref) => {
    const g = data.find((x) => x.id === ref) ?? data.find((x) => x.attributes.name === ref);
    if (!g) throw new UserError(`No TestFlight group "${ref}". Run \`asc tf groups list\`.`);
    return g;
  });
}

export async function addBuildToGroups(ctx, appId, buildId, refs) {
  for (const g of await resolveGroups(ctx, appId, refs)) {
    // Groups with access to all builds (and every internal group created that way) receive builds automatically;
    // the API rejects explicit assignment with a 422.
    if (g.attributes.hasAccessToAllBuilds) {
      console.log(`${color.green('✔')} "${g.attributes.name}" receives all builds automatically`);
      continue;
    }
    await ctx.client.post(`/v1/betaGroups/${g.id}/relationships/builds`, { data: [{ type: 'builds', id: buildId }] });
    console.log(`${color.green('✔')} Build added to "${g.attributes.name}"`);
  }
}

export async function setBuildWhatsNew(ctx, buildId, locale, text) {
  await upsertByLocale({ client: ctx.client, listPath: `/v1/builds/${buildId}/betaBuildLocalizations`, type: 'betaBuildLocalizations', locale, attributes: { whatsNew: text }, parentRel: ['build', 'builds', buildId] });
  console.log(`${color.green('✔')} TestFlight "What to Test" saved (${locale})`);
}

export async function submitBeta(ctx, buildId) {
  await ctx.client.post('/v1/betaAppReviewSubmissions', payload('betaAppReviewSubmissions', undefined, { build: ['builds', buildId] }));
  console.log(`${color.green('✔')} Submitted for TestFlight beta app review`);
}

export default [
  // ------------------------------------------------------------ groups
  {
    name: 'tf groups list',
    summary: 'List TestFlight groups.',
    run: async (ctx) => {
      const { data } = await ctx.client.list('/v1/betaGroups', { 'filter[app]': await resolveApp(ctx) });
      const rows = data.map(flat);
      emit(ctx, rows, () => console.log(table(rows, [['ID', 'id'], ['Name', 'name'], ['Internal', 'isInternalGroup'], ['Public link', (g) => (g.publicLinkEnabled ? g.publicLink : '')], ['Limit', 'publicLinkLimit'], ['All builds', 'hasAccessToAllBuilds']])));
    },
  },
  {
    name: 'tf groups create',
    summary: 'Create a TestFlight group.',
    usage: 'asc tf groups create --name "Beta" [--internal] [--public-link [--limit 1000]] [--all-builds] [--feedback]',
    bool: ['internal', 'public-link', 'all-builds', 'feedback'],
    run: async (ctx) => {
      const f = ctx.flags;
      if (!f.name) throw new UserError('--name is required');
      const attributes = compact({ name: f.name, isInternalGroup: !!f.internal, hasAccessToAllBuilds: f['all-builds'] ? true : undefined, publicLinkEnabled: f['public-link'] ? true : undefined, publicLinkLimitEnabled: f.limit ? true : undefined, publicLinkLimit: f.limit ? Number(f.limit) : undefined, feedbackEnabled: f.feedback ? true : undefined });
      const r = await ctx.client.post('/v1/betaGroups', payload('betaGroups', attributes, { app: ['apps', await resolveApp(ctx)] }));
      console.log(`${color.green('✔')} Created group ${f.name} (id ${r.data.id})${r.data.attributes.publicLink ? `\nPublic link: ${r.data.attributes.publicLink}` : ''}`);
    },
  },
  {
    name: 'tf groups delete',
    summary: 'Delete a TestFlight group.',
    usage: 'asc tf groups delete <groupId|name> --yes',
    bool: ['yes'],
    run: async (ctx) => {
      if (!ctx.flags.yes) throw new UserError('Re-run with --yes.');
      const [g] = await resolveGroups(ctx, await resolveApp(ctx), [ctx.args[0]]);
      await ctx.client.del(`/v1/betaGroups/${g.id}`);
      console.log(`${color.green('✔')} Deleted ${g.attributes.name}`);
    },
  },

  // ------------------------------------------------------------ testers
  {
    name: 'tf testers list',
    summary: 'List testers (app-wide, or one group).',
    options: [['--group', 'Group name/id'], ['--email', 'Filter by email']],
    run: async (ctx) => {
      const appId = await resolveApp(ctx);
      const q = compact({ 'filter[email]': ctx.flags.email, ...(ctx.flags.group ? {} : { 'filter[apps]': appId }) });
      let path = '/v1/betaTesters';
      if (ctx.flags.group) path = `/v1/betaGroups/${(await resolveGroups(ctx, appId, [ctx.flags.group]))[0].id}/betaTesters`;
      const { data } = await ctx.client.list(path, q);
      const rows = data.map(flat);
      emit(ctx, rows, () => console.log(table(rows, [['ID', 'id'], ['Email', 'email'], ['Name', (t) => `${t.firstName ?? ''} ${t.lastName ?? ''}`.trim()], ['State', 'state'], ['Invite', 'inviteType']])));
    },
  },
  {
    name: 'tf testers add',
    summary: 'Add a tester to one or more groups (creates them if new; sends an invite for external testers).',
    usage: 'asc tf testers add --email a@b.com [--first A --last B] --group "Beta,Internal"',
    run: async (ctx) => {
      const f = ctx.flags;
      if (!f.email || !f.group) throw new UserError('--email and --group are required');
      const groups = await resolveGroups(ctx, await resolveApp(ctx), csv(f.group));
      const r = await ctx.client.post('/v1/betaTesters', payload('betaTesters', compact({ email: f.email, firstName: f.first, lastName: f.last }), { betaGroups: ['betaGroups', groups.map((g) => g.id)] }));
      console.log(`${color.green('✔')} ${f.email} added to ${groups.map((g) => g.attributes.name).join(', ')} (tester ${r.data.id})`);
    },
  },
  {
    name: 'tf testers remove',
    summary: 'Remove a tester from the account (all apps).',
    usage: 'asc tf testers remove <testerId> --yes',
    bool: ['yes'],
    run: async (ctx) => {
      if (!ctx.flags.yes) throw new UserError('Re-run with --yes.');
      await ctx.client.del(`/v1/betaTesters/${ctx.args[0]}`);
      console.log(`${color.green('✔')} Removed`);
    },
  },
  {
    name: 'tf testers invite',
    summary: 'Re-send a TestFlight invitation email.',
    usage: 'asc tf testers invite <testerId>',
    run: async (ctx) => {
      await ctx.client.post('/v1/betaTesterInvitations', payload('betaTesterInvitations', undefined, { app: ['apps', await resolveApp(ctx)], betaTester: ['betaTesters', ctx.args[0]] }));
      console.log(`${color.green('✔')} Invitation sent`);
    },
  },

  // ------------------------------------------------------------ builds in TestFlight
  {
    name: 'tf builds add',
    summary: 'Add a build to groups so those testers get it.',
    usage: 'asc tf builds add --build latest|<number|id> --group "Beta,Internal"',
    run: async (ctx) => {
      if (!ctx.flags.group) throw new UserError('--group is required');
      const appId = await resolveApp(ctx);
      await addBuildToGroups(ctx, appId, await resolveBuild(ctx, appId, ctx.flags.build ?? 'latest'), csv(ctx.flags.group));
    },
  },
  {
    name: 'tf builds remove',
    summary: 'Remove a build from groups.',
    usage: 'asc tf builds remove --build <number|id> --group "Beta"',
    run: async (ctx) => {
      const appId = await resolveApp(ctx);
      const buildId = await resolveBuild(ctx, appId, ctx.flags.build ?? 'latest');
      for (const g of await resolveGroups(ctx, appId, csv(ctx.flags.group))) {
        await ctx.client.del(`/v1/betaGroups/${g.id}/relationships/builds`, { data: [{ type: 'builds', id: buildId }] });
        console.log(`${color.green('✔')} Removed from "${g.attributes.name}"`);
      }
    },
  },
  {
    name: 'tf builds list',
    summary: 'List builds with their internal/external TestFlight states.',
    run: async (ctx) => {
      const appId = await resolveApp(ctx);
      const builds = await findBuilds(ctx, appId, { limit: Number(ctx.flags.limit ?? 10) });
      const rows = [];
      for (const b of builds) {
        const d = await ctx.client.getOptional(`/v1/builds/${b.id}/buildBetaDetail`);
        rows.push({ ...b, internal: d?.data?.attributes.internalBuildState, external: d?.data?.attributes.externalBuildState, autoNotify: d?.data?.attributes.autoNotifyEnabled });
      }
      emit(ctx, rows, () => console.log(table(rows, [['ID', 'id'], ['Version', 'marketingVersion'], ['Build', 'version'], ['Processing', 'processingState'], ['Internal', 'internal'], ['External', 'external'], ['Auto-notify', 'autoNotify']])));
    },
  },
  {
    name: 'tf whats-new',
    summary: 'Set the "What to Test" text for a build.',
    usage: 'asc tf whats-new --build latest --text "Try the new sync" [--text-file f] [--locale en-US]',
    run: async (ctx) => {
      const text = textFlag(ctx.flags, 'text');
      if (!text) throw new UserError('--text or --text-file is required');
      const appId = await resolveApp(ctx);
      await setBuildWhatsNew(ctx, await resolveBuild(ctx, appId, ctx.flags.build ?? 'latest'), ctx.flags.locale ?? 'en-US', text);
    },
  },
  {
    name: 'tf submit',
    summary: 'Submit a build for external TestFlight beta app review (needed before external groups get it).',
    usage: 'asc tf submit [--build latest|<number|id>]',
    run: async (ctx) => {
      const appId = await resolveApp(ctx);
      await submitBeta(ctx, await resolveBuild(ctx, appId, ctx.flags.build ?? 'latest'));
    },
  },
  {
    name: 'tf status',
    summary: 'Beta review state + TestFlight detail for a build.',
    usage: 'asc tf status [--build latest]',
    run: async (ctx) => {
      const appId = await resolveApp(ctx);
      const id = await resolveBuild(ctx, appId, ctx.flags.build ?? 'latest');
      const [sub, det] = await Promise.all([ctx.client.getOptional(`/v1/builds/${id}/betaAppReviewSubmission`), ctx.client.getOptional(`/v1/builds/${id}/buildBetaDetail`)]);
      const out = { betaReview: flat(sub?.data), detail: flat(det?.data) };
      emit(ctx, out, () => { printKV({ buildId: id, betaReviewState: out.betaReview?.betaReviewState ?? '(not submitted)', ...out.detail }); });
    },
  },
  {
    name: 'tf auto-notify',
    summary: 'Toggle automatic tester notification for a build.',
    usage: 'asc tf auto-notify --build latest --enabled true|false',
    run: async (ctx) => {
      const appId = await resolveApp(ctx);
      const id = await resolveBuild(ctx, appId, ctx.flags.build ?? 'latest');
      const det = await ctx.client.get(`/v1/builds/${id}/buildBetaDetail`);
      await ctx.client.patch(`/v1/buildBetaDetails/${det.data.id}`, { data: { type: 'buildBetaDetails', id: det.data.id, attributes: { autoNotifyEnabled: String(ctx.flags.enabled) !== 'false' } } });
      console.log(`${color.green('✔')} autoNotifyEnabled = ${String(ctx.flags.enabled) !== 'false'}`);
    },
  },

  // ------------------------------------------------------------ beta app info
  {
    name: 'tf info show',
    summary: 'Show TestFlight app info: beta description, feedback email, review contact.',
    run: async (ctx) => {
      const appId = await resolveApp(ctx);
      const [locs, rev] = await Promise.all([ctx.client.list(`/v1/apps/${appId}/betaAppLocalizations`), ctx.client.getOptional(`/v1/apps/${appId}/betaAppReviewDetail`)]);
      const out = { localizations: locs.data.map(flat), reviewDetail: flat(rev?.data) };
      emit(ctx, out, () => {
        console.log(table(out.localizations, [['ID', 'id'], ['Locale', 'locale'], ['Feedback email', 'feedbackEmail'], ['Description', (l) => (l.description ?? '').slice(0, 50)], ['Privacy URL', 'privacyPolicyUrl']]));
        console.log('\n' + color.bold('Beta review contact'));
        if (out.reviewDetail) printKV({ ...out.reviewDetail, demoAccountPassword: out.reviewDetail.demoAccountPassword ? '********' : '' });
        else console.log(color.yellow('(not set)'));
      });
    },
  },
  {
    name: 'tf info set',
    summary: 'Set TestFlight beta description/feedback email/URLs for a locale.',
    usage: 'asc tf info set --locale en-US [--description T] [--feedback-email e] [--marketing-url U] [--privacy-url U]',
    run: async (ctx) => {
      const f = ctx.flags;
      const appId = await resolveApp(ctx);
      await upsertByLocale({ client: ctx.client, listPath: `/v1/apps/${appId}/betaAppLocalizations`, type: 'betaAppLocalizations', locale: f.locale ?? 'en-US', attributes: compact({ description: textFlag(f, 'description'), feedbackEmail: f['feedback-email'], marketingUrl: f['marketing-url'], privacyPolicyUrl: f['privacy-url'] }), parentRel: ['app', 'apps', appId] });
      console.log(`${color.green('✔')} Beta app info saved`);
    },
  },
  {
    name: 'tf review-contact set',
    summary: 'Set the contact and demo account used for TestFlight beta app review.',
    usage: 'asc tf review-contact set --first A --last B --phone +1… --email e [--demo-required --demo-user u --demo-password p] [--notes T]',
    bool: ['demo-required'],
    run: async (ctx) => {
      const f = ctx.flags;
      const appId = await resolveApp(ctx);
      const attributes = compact({ contactFirstName: f.first, contactLastName: f.last, contactPhone: f.phone, contactEmail: f.email, demoAccountRequired: f['demo-required'] === undefined ? undefined : !!f['demo-required'], demoAccountName: f['demo-user'], demoAccountPassword: f['demo-password'], notes: textFlag(f, 'notes') });
      const cur = await ctx.client.getOptional(`/v1/apps/${appId}/betaAppReviewDetail`);
      if (cur?.data) await ctx.client.patch(`/v1/betaAppReviewDetails/${cur.data.id}`, { data: { type: 'betaAppReviewDetails', id: cur.data.id, attributes } });
      else throw new UserError('No beta review detail record exists for this app yet; set it once in App Store Connect → TestFlight → Test Information, then update here.');
      console.log(`${color.green('✔')} Beta review contact saved`);
    },
  },
  {
    name: 'tf feedback',
    summary: 'List recent TestFlight screenshot feedback submissions.',
    options: [['--limit', 'Max rows (default 20)']],
    run: async (ctx) => {
      const appId = await resolveApp(ctx);
      const { data } = await ctx.client.list(`/v1/apps/${appId}/betaFeedbackScreenshotSubmissions`, { sort: '-createdDate' }, { max: Number(ctx.flags.limit ?? 20) });
      const rows = data.map(flat);
      emit(ctx, rows, () => console.log(table(rows, [['ID', 'id'], ['Created', (r) => shortDate(r.createdDate)], ['Device', 'deviceModel'], ['OS', 'osVersion'], ['Email', 'email'], ['Comment', (r) => (r.comment ?? '').slice(0, 60)]])));
    },
  },
];
