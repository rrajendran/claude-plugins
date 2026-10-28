import { flat, normPlatform, UserError } from './util.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const EDITABLE_STATES = ['PREPARE_FOR_SUBMISSION', 'DEVELOPER_REJECTED', 'REJECTED', 'METADATA_REJECTED', 'INVALID_BINARY'];

export const versionState = (v) => v.appVersionState ?? v.appStoreState;

export function platform(ctx) {
  return normPlatform(ctx.flags.platform ?? ctx.cfg.platform) ?? 'IOS';
}

/** Resolve --app (numeric id | bundle id | name) → app id. Falls back to .asc.json "app"/"bundleId". */
export async function resolveApp(ctx, ref) {
  ref = ref ?? ctx.flags.app ?? ctx.cfg.app ?? ctx.cfg.bundleId;
  if (!ref) throw new UserError('No app specified. Pass --app <id|bundleId|name>, set ASC_APP, or run `asc init` to write .asc.json.');
  ref = String(ref);
  if (/^\d{6,}$/.test(ref)) return ref;
  ctx._appCache ??= {};
  if (ctx._appCache[ref]) return ctx._appCache[ref];
  const q = ref.includes('.') ? { 'filter[bundleId]': ref } : { 'filter[name]': ref };
  const { data } = await ctx.client.list('/v1/apps', q);
  const hit = data.find((a) => a.attributes.bundleId === ref) ?? data.find((a) => a.attributes.name === ref) ?? (data.length === 1 ? data[0] : null);
  if (!hit) throw new UserError(`No app matches "${ref}". Run \`asc apps list\`.`);
  return (ctx._appCache[ref] = hit.id);
}

/** Resolve a version reference → App Store version resource. ref: uuid | "1.2.3" | "latest" | "editable". */
export async function resolveVersion(ctx, appId, ref = ctx.flags.version ?? 'latest') {
  if (UUID.test(ref)) {
    const r = await ctx.client.get(`/v1/appStoreVersions/${ref}`);
    return r.data;
  }
  const { data } = await ctx.client.list(`/v1/apps/${appId}/appStoreVersions`, { 'filter[platform]': platform(ctx) });
  const sorted = data.sort((a, b) => (b.attributes.createdDate ?? '').localeCompare(a.attributes.createdDate ?? ''));
  let hit;
  if (ref === 'latest') hit = sorted[0];
  else if (ref === 'editable') hit = sorted.find((v) => EDITABLE_STATES.includes(versionState(v.attributes)));
  else hit = sorted.find((v) => v.attributes.versionString === ref);
  if (!hit) throw new UserError(`No ${platform(ctx)} App Store version matches "${ref}". Create one with \`asc versions create\`.`);
  return hit;
}

/** The appInfo record in an editable state, else the first one. */
export async function resolveAppInfo(ctx, appId) {
  const { data } = await ctx.client.list(`/v1/apps/${appId}/appInfos`);
  if (!data.length) throw new UserError('App has no appInfos record.');
  return data.find((i) => EDITABLE_STATES.includes(versionState(i.attributes))) ?? data[0];
}

/** Latest uploaded build for an app, optionally filtered by build number / version string. */
export async function findBuilds(ctx, appId, { number, version, limit = 25 } = {}) {
  const q = {
    'filter[app]': appId,
    sort: '-uploadedDate',
    include: 'preReleaseVersion',
    limit,
    ...(number && { 'filter[version]': number }),
    ...(version && { 'filter[preReleaseVersion.version]': version }),
    ...(ctx.flags.platform || ctx.cfg.platform ? { 'filter[preReleaseVersion.platform]': platform(ctx) } : {}),
  };
  const { data, included } = await ctx.client.list('/v1/builds', q, { max: limit });
  const pre = Object.fromEntries(included.filter((i) => i.type === 'preReleaseVersions').map((i) => [i.id, i.attributes]));
  return data.map((b) => ({
    ...flat(b),
    marketingVersion: pre[b.relationships?.preReleaseVersion?.data?.id]?.version,
    platform: pre[b.relationships?.preReleaseVersion?.data?.id]?.platform,
  }));
}

/** Create-or-update a localization-style resource keyed by locale. */
export async function upsertByLocale({ client, listPath, type, locale, attributes, parentRel }) {
  const { data } = await client.list(listPath);
  const existing = data.find((d) => d.attributes.locale === locale);
  if (existing) {
    if (!Object.keys(attributes).length) return existing;
    const r = await client.patch(`/v1/${type}/${existing.id}`, { data: { type, id: existing.id, attributes } });
    return r.data;
  }
  const r = await client.post(`/v1/${type}`, {
    data: { type, attributes: { locale, ...attributes }, relationships: { [parentRel[0]]: { data: { type: parentRel[1], id: parentRel[2] } } } },
  });
  return r.data;
}
