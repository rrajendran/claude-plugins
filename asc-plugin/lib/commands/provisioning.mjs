import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { color, csv, emit, expandHome, flat, normPlatform, payload, runOrThrow, shortDate, table, UserError } from '../util.mjs';

/** Accept either a bundle-id resource id or a reverse-DNS identifier. */
async function resolveBundleId(ctx, ref) {
  if (!ref) throw new UserError('--bundle-id is required');
  if (!ref.includes('.')) return ref;
  const { data } = await ctx.client.list('/v1/bundleIds', { 'filter[identifier]': ref });
  const hit = data.find((b) => b.attributes.identifier === ref);
  if (!hit) throw new UserError(`Bundle id ${ref} is not registered. Run \`asc bundle-ids create\`.`);
  return hit.id;
}

const save = (outPath, b64, fallback) => {
  const p = expandHome(outPath ?? fallback);
  fs.mkdirSync(path.dirname(path.resolve(p)), { recursive: true });
  fs.writeFileSync(p, Buffer.from(b64, 'base64'));
  return p;
};

export default [
  // ------------------------------------------------------------ bundle ids
  {
    name: 'bundle-ids list',
    summary: 'List registered bundle identifiers.',
    options: [['--identifier', 'Filter by identifier']],
    run: async (ctx) => {
      const { data } = await ctx.client.list('/v1/bundleIds', ctx.flags.identifier ? { 'filter[identifier]': ctx.flags.identifier } : {});
      const rows = data.map(flat);
      emit(ctx, rows, () => console.log(table(rows, [['ID', 'id'], ['Identifier', 'identifier'], ['Name', 'name'], ['Platform', 'platform'], ['Seed', 'seedId']])));
    },
  },
  {
    name: 'bundle-ids create',
    summary: 'Register a new bundle identifier.',
    usage: 'asc bundle-ids create --identifier com.acme.app --name "Acme" [--platform ios|macos|universal]',
    options: [['--identifier', 'Reverse-DNS identifier'], ['--name', 'Display name'], ['--platform', 'ios | macos | universal (default universal)']],
    run: async (ctx) => {
      const { identifier, name, platform } = ctx.flags;
      if (!identifier || !name) throw new UserError('--identifier and --name are required');
      const p = platform ? (platform.toLowerCase() === 'universal' ? 'UNIVERSAL' : normPlatform(platform)) : 'UNIVERSAL';
      const r = await ctx.client.post('/v1/bundleIds', payload('bundleIds', { identifier, name, platform: p }));
      console.log(`${color.green('✔')} Registered ${identifier} (id ${r.data.id})`);
    },
  },
  {
    name: 'bundle-ids delete',
    summary: 'Delete a bundle identifier.',
    usage: 'asc bundle-ids delete <id|identifier> --yes',
    bool: ['yes'],
    run: async (ctx) => {
      if (!ctx.flags.yes) throw new UserError('Deleting a bundle id is irreversible. Re-run with --yes.');
      const id = await resolveBundleId(ctx, ctx.args[0]);
      await ctx.client.del(`/v1/bundleIds/${id}`);
      console.log(`${color.green('✔')} Deleted ${id}`);
    },
  },
  {
    name: 'bundle-ids capabilities',
    summary: 'List capabilities enabled on a bundle id.',
    usage: 'asc bundle-ids capabilities <id|identifier>',
    run: async (ctx) => {
      const id = await resolveBundleId(ctx, ctx.args[0]);
      const { data } = await ctx.client.list(`/v1/bundleIds/${id}/bundleIdCapabilities`);
      const rows = data.map(flat);
      emit(ctx, rows, () => console.log(table(rows, [['ID', 'id'], ['Capability', 'capabilityType']])));
    },
  },
  {
    name: 'bundle-ids enable',
    summary: 'Enable a capability (e.g. ICLOUD, PUSH_NOTIFICATIONS, IN_APP_PURCHASE, APP_GROUPS, ASSOCIATED_DOMAINS, SIGN_IN_WITH_APPLE).',
    usage: 'asc bundle-ids enable <id|identifier> --capability ICLOUD',
    options: [['--capability', 'Capability type enum from the API']],
    run: async (ctx) => {
      const id = await resolveBundleId(ctx, ctx.args[0]);
      if (!ctx.flags.capability) throw new UserError('--capability is required');
      await ctx.client.post('/v1/bundleIdCapabilities', payload('bundleIdCapabilities', { capabilityType: ctx.flags.capability.toUpperCase() }, { bundleId: ['bundleIds', id] }));
      console.log(`${color.green('✔')} Enabled ${ctx.flags.capability.toUpperCase()}`);
    },
  },
  {
    name: 'bundle-ids disable',
    summary: 'Disable a capability by capability id (see `bundle-ids capabilities`).',
    usage: 'asc bundle-ids disable <capabilityId>',
    run: async (ctx) => {
      await ctx.client.del(`/v1/bundleIdCapabilities/${ctx.args[0]}`);
      console.log(`${color.green('✔')} Disabled`);
    },
  },

  // ------------------------------------------------------------ certificates
  {
    name: 'certs list',
    summary: 'List signing certificates.',
    options: [['--type', 'Filter: IOS_DEVELOPMENT, IOS_DISTRIBUTION, MAC_APP_DISTRIBUTION, MAC_INSTALLER_DISTRIBUTION, DEVELOPMENT, DISTRIBUTION, DEVELOPER_ID_APPLICATION …']],
    run: async (ctx) => {
      const { data } = await ctx.client.list('/v1/certificates', ctx.flags.type ? { 'filter[certificateType]': ctx.flags.type.toUpperCase() } : {});
      const rows = data.map(flat);
      emit(ctx, rows, () => console.log(table(rows, [['ID', 'id'], ['Type', 'certificateType'], ['Name', 'name'], ['Expires', (c) => shortDate(c.expirationDate)], ['Serial', 'serialNumber']])));
    },
  },
  {
    name: 'certs csr',
    summary: 'Generate a private key + certificate signing request with openssl (key stays on this machine).',
    usage: 'asc certs csr --email you@x.com [--name "Your Name"] [--out ~/.keys/asc-signing]',
    options: [['--email', 'Contact email'], ['--name', 'Common name (default: Apple Distribution)'], ['--out', 'Output prefix (default ./signing → signing.key, signing.csr)']],
    noAuth: true,
    run: async (ctx) => {
      if (!ctx.flags.email) throw new UserError('--email is required');
      const prefix = expandHome(ctx.flags.out ?? 'signing');
      const subj = `/emailAddress=${ctx.flags.email}/CN=${ctx.flags.name ?? 'Apple Distribution'}/C=US`;
      await runOrThrow('openssl', ['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-keyout', `${prefix}.key`, '-out', `${prefix}.csr`, '-subj', subj]);
      fs.chmodSync(`${prefix}.key`, 0o600);
      console.log(`${color.green('✔')} ${prefix}.csr (upload) and ${prefix}.key (keep secret)`);
    },
  },
  {
    name: 'certs create',
    summary: 'Create a certificate from a CSR and save the .cer.',
    usage: 'asc certs create --type IOS_DISTRIBUTION --csr signing.csr [--out dist.cer]',
    options: [['--type', 'Certificate type'], ['--csr', 'CSR file'], ['--out', 'Where to save the .cer']],
    run: async (ctx) => {
      const { type, csr, out } = ctx.flags;
      if (!type || !csr) throw new UserError('--type and --csr are required');
      const r = await ctx.client.post('/v1/certificates', payload('certificates', { certificateType: type.toUpperCase(), csrContent: fs.readFileSync(expandHome(csr), 'utf8') }));
      const p = save(out, r.data.attributes.certificateContent, `${r.data.id}.cer`);
      console.log(`${color.green('✔')} Created certificate ${r.data.id} → ${p}\nImport with: security import ${p} -k ~/Library/Keychains/login.keychain-db`);
    },
  },
  {
    name: 'certs download',
    summary: 'Download an existing certificate as .cer.',
    usage: 'asc certs download <id> [--out file.cer]',
    run: async (ctx) => {
      const r = await ctx.client.get(`/v1/certificates/${ctx.args[0]}`);
      console.log(`${color.green('✔')} ${save(ctx.flags.out, r.data.attributes.certificateContent, `${ctx.args[0]}.cer`)}`);
    },
  },
  {
    name: 'certs revoke',
    summary: 'Revoke (delete) a certificate.',
    usage: 'asc certs revoke <id> --yes',
    bool: ['yes'],
    run: async (ctx) => {
      if (!ctx.flags.yes) throw new UserError('Revoking invalidates profiles that use it. Re-run with --yes.');
      await ctx.client.del(`/v1/certificates/${ctx.args[0]}`);
      console.log(`${color.green('✔')} Revoked ${ctx.args[0]}`);
    },
  },

  // ------------------------------------------------------------ devices
  {
    name: 'devices list',
    summary: 'List registered devices.',
    run: async (ctx) => {
      const { data } = await ctx.client.list('/v1/devices');
      const rows = data.map(flat);
      emit(ctx, rows, () => console.log(table(rows, [['ID', 'id'], ['Name', 'name'], ['Platform', 'platform'], ['Class', 'deviceClass'], ['Status', 'status'], ['UDID', 'udid']])));
    },
  },
  {
    name: 'devices register',
    summary: 'Register a device for ad-hoc/development profiles.',
    usage: 'asc devices register --name "My iPhone" --udid <UDID> [--platform ios|macos]',
    run: async (ctx) => {
      const { name, udid, platform } = ctx.flags;
      if (!name || !udid) throw new UserError('--name and --udid are required');
      const r = await ctx.client.post('/v1/devices', payload('devices', { name, udid, platform: normPlatform(platform) ?? 'IOS' }));
      console.log(`${color.green('✔')} Registered device ${r.data.id}`);
    },
  },

  // ------------------------------------------------------------ profiles
  {
    name: 'profiles list',
    summary: 'List provisioning profiles.',
    options: [['--type', 'Filter by profile type, e.g. IOS_APP_STORE']],
    run: async (ctx) => {
      const { data } = await ctx.client.list('/v1/profiles', ctx.flags.type ? { 'filter[profileType]': ctx.flags.type.toUpperCase() } : {});
      const rows = data.map(flat);
      emit(ctx, rows, () => console.log(table(rows, [['ID', 'id'], ['Name', 'name'], ['Type', 'profileType'], ['State', 'profileState'], ['Expires', (p) => shortDate(p.expirationDate)], ['UUID', 'uuid']])));
    },
  },
  {
    name: 'profiles create',
    summary: 'Create a provisioning profile.',
    usage: 'asc profiles create --name "Acme AppStore" --type IOS_APP_STORE --bundle-id com.acme.app --certs <certId,...> [--devices <deviceId,...>]',
    options: [['--type', 'IOS_APP_STORE | IOS_APP_DEVELOPMENT | IOS_APP_ADHOC | MAC_APP_STORE | MAC_APP_DIRECT | TVOS_APP_STORE …'], ['--bundle-id', 'Identifier or bundle-id resource id'], ['--certs', 'Certificate ids (comma)'], ['--devices', 'Device ids (dev/adhoc only)']],
    run: async (ctx) => {
      const { name, type, certs, devices } = ctx.flags;
      if (!name || !type || !certs) throw new UserError('--name, --type, --bundle-id and --certs are required');
      const bundleId = await resolveBundleId(ctx, ctx.flags['bundle-id']);
      const rels = { bundleId: ['bundleIds', bundleId], certificates: ['certificates', csv(certs)], ...(devices && { devices: ['devices', csv(devices)] }) };
      const r = await ctx.client.post('/v1/profiles', payload('profiles', { name, profileType: type.toUpperCase() }, rels));
      console.log(`${color.green('✔')} Created profile ${r.data.id} (${r.data.attributes.uuid}). Download: asc profiles download ${r.data.id} --install`);
    },
  },
  {
    name: 'profiles download',
    summary: 'Download a profile; --install puts it where Xcode picks it up.',
    usage: 'asc profiles download <id> [--out file] [--install]',
    bool: ['install'],
    run: async (ctx) => {
      const r = await ctx.client.get(`/v1/profiles/${ctx.args[0]}`);
      const a = r.data.attributes;
      const ext = a.profileType.startsWith('MAC') ? 'provisionprofile' : 'mobileprovision';
      const dest = ctx.flags.install
        ? path.join(os.homedir(), 'Library', 'MobileDevice', 'Provisioning Profiles', `${a.uuid}.${ext}`)
        : ctx.flags.out ?? `${a.name.replace(/\W+/g, '_')}.${ext}`;
      console.log(`${color.green('✔')} ${save(dest, a.profileContent)}`);
    },
  },
  {
    name: 'profiles delete',
    summary: 'Delete a provisioning profile.',
    usage: 'asc profiles delete <id> --yes',
    bool: ['yes'],
    run: async (ctx) => {
      if (!ctx.flags.yes) throw new UserError('Re-run with --yes to delete.');
      await ctx.client.del(`/v1/profiles/${ctx.args[0]}`);
      console.log(`${color.green('✔')} Deleted ${ctx.args[0]}`);
    },
  },
];
