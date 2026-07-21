import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const failures = [];

function read(relPath) {
  const absolutePath = join(root, relPath);
  if (!existsSync(absolutePath)) {
    failures.push(`Missing Continuum connector contract file: ${relPath}`);
    return '';
  }
  return readFileSync(absolutePath, 'utf8');
}

const contract = read('src/server/audio-publishing-contract.ts');
const schema = read('src/db/schema.ts');
const migration = read('drizzle/0023_audio_publishing_foundation.sql');
const sourceCapabilities = read('src/server/music-source-capabilities.ts');
const doc = read('docs/SWAY_AUDIO_PUBLISHING_FOUNDATION.md');
const packageJson = read('package.json');

for (const term of [
  'export const CONTINUUM_CONNECTOR_CAPABILITIES',
  'hostedSourceManifest: true',
  'embedPlayer: true',
  'sourceDownload: true',
  'derivativePlanning: true',
  'losslessBinaryMasterStorage: false',
  'resumableMultipartUpload: false',
  'durableAccountPermissions: false',
  'privateCollaboration: false',
  'audioPlayback: false',
  'externalDspDelivery: false',
  'directSales: false',
  'export const AUDIO_PUBLISHING_RUNTIME_CAPABILITIES',
  'losslessObjectStorage: true',
  'resumableUploadRoutes: true',
  'privateDownloadAuthorization: true',
  'fileConnectionQrRoutes: false',
  'swayPlayback: false',
  'royaltyAccounting: false'
]) {
  if (!contract.includes(term)) failures.push(`Continuum fail-closed capability contract missing term: ${term}`);
}

for (const forbidden of [
  'losslessBinaryMasterStorage: true',
  'resumableMultipartUpload: true',
  'durableAccountPermissions: true',
  'privateCollaboration: true',
  'audioPlayback: true',
  'externalDspDelivery: true',
  'directSales: true',
  'fileConnectionQrRoutes: true',
  'swayPlayback: true',
  'royaltyAccounting: true'
]) {
  if (contract.includes(forbidden)) failures.push(`Continuum/audio runtime capability must remain fail-closed: ${forbidden}`);
}

for (const term of [
  "export const mediaConnectorLinks = pgTable('media_connector_links'",
  "projectId: uuid('project_id').references(() => audioProjects.id",
  "assetVersionId: uuid('asset_version_id').references(() => audioProjectAssetVersions.id",
  "providerKey: text('provider_key').notNull()",
  "externalSourceId: text('external_source_id').notNull()",
  "sourceKind: text('source_kind').notNull()",
  "connectionStatus: text('connection_status').notNull().default('linked')",
  "capabilitySnapshot: jsonb('capability_snapshot').notNull()",
  'media_connector_links_provider_source_idx',
  'media_connector_links_resource_required',
  "'linked', 'syncing', 'ready', 'failed', 'revoked'"
]) {
  if (!schema.includes(term)) failures.push(`Media connector persistence boundary missing schema term: ${term}`);
}

for (const term of [
  'CREATE TABLE "media_connector_links"',
  'CONSTRAINT "media_connector_links_project_id_audio_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "audio_projects"("id") ON DELETE CASCADE',
  'CONSTRAINT "media_connector_links_asset_version_id_audio_project_asset_versions_id_fk" FOREIGN KEY ("asset_version_id") REFERENCES "audio_project_asset_versions"("id") ON DELETE CASCADE',
  '"provider_key" text NOT NULL',
  '"external_source_id" text NOT NULL',
  '"source_kind" text NOT NULL',
  '"connection_status" text DEFAULT \'linked\' NOT NULL',
  '"capability_snapshot" jsonb NOT NULL',
  'CONSTRAINT "media_connector_links_resource_required"',
  'CONSTRAINT "media_connector_links_status_allowed"',
  'CREATE UNIQUE INDEX "media_connector_links_provider_source_idx"'
]) {
  if (!migration.includes(term)) failures.push(`Media connector persistence boundary missing migration term: ${term}`);
}

const swayUploadStart = sourceCapabilities.indexOf("providerKey: 'sway_upload'");
const swayUploadBlock = swayUploadStart >= 0
  ? sourceCapabilities.slice(swayUploadStart, sourceCapabilities.indexOf('\n    }', swayUploadStart) + 6)
  : '';

if (swayUploadStart < 0) {
  failures.push('Music source capability catalog must retain the sway_upload provider entry.');
} else {
  for (const term of [
    "sourceMode: 'sway_owned_audio'",
    'playInSway: false',
    'requiresTrackAvailabilityCheck: true',
    'Sway playback requires licensed audio',
    'provenance, license records, and playback audit'
  ]) {
    if (!swayUploadBlock.includes(term)) failures.push(`sway_upload must remain fail-closed before licensed playback exists: ${term}`);
  }
}

for (const term of [
  'Continuum is a connector for source manifests, embeds, source/package download, derivative planning',
  "It is not Sway's master vault, rights ledger, user/permission system, audio player, store distributor, or sales ledger.",
  '| Lossless binary master storage | false |',
  '| Resumable multipart upload | false |',
  '| Durable account permissions | false |',
  '| Private collaboration | false |',
  '| Audio playback | false |',
  '| External DSP delivery | false |',
  '| Direct sales | false |',
  'Missing or unknown capabilities evaluate to false.',
  'Connector failure cannot mutate or delete the immutable original.'
]) {
  if (!doc.includes(term)) failures.push(`Continuum boundary documentation missing truth term: ${term}`);
}

if (!packageJson.includes('node scripts/sway-continuum-connector.contract.test.mjs')) {
  failures.push('package.json must register the Continuum connector contract in test:contracts.');
}

if (contract && schema && migration) {
  const behaviorProgram = String.raw`
    import {
      AUDIO_PUBLISHING_RUNTIME_CAPABILITIES,
      CONTINUUM_CONNECTOR_CAPABILITIES
    } from './src/server/audio-publishing-contract.ts';

    const supportedManifestCapabilities = [
      'hostedSourceManifest',
      'embedPlayer',
      'sourceDownload',
      'derivativePlanning'
    ];
    for (const capability of supportedManifestCapabilities) {
      if (CONTINUUM_CONNECTOR_CAPABILITIES[capability] !== true) {
        throw new Error('Continuum manifest capability unexpectedly unavailable: ' + capability);
      }
    }

    const unsupportedConnectorCapabilities = [
      'losslessBinaryMasterStorage',
      'resumableMultipartUpload',
      'durableAccountPermissions',
      'privateCollaboration',
      'audioPlayback',
      'externalDspDelivery',
      'directSales'
    ];
    for (const capability of unsupportedConnectorCapabilities) {
      if (CONTINUUM_CONNECTOR_CAPABILITIES[capability] !== false) {
        throw new Error('Continuum connector must fail closed for: ' + capability);
      }
    }

    const unavailableRuntimeCapabilities = [
      'catalogCutoverAutomation',
      'fileConnectionQrRoutes',
      'swayPlayback',
      'externalDspDelivery',
      'directSales',
      'royaltyAccounting'
    ];
    for (const capability of unavailableRuntimeCapabilities) {
      if (AUDIO_PUBLISHING_RUNTIME_CAPABILITIES[capability] !== false) {
        throw new Error('Audio publishing runtime must fail closed for: ' + capability);
      }
    }

    const enabledRuntimeCapabilities = [
      'losslessObjectStorage',
      'resumableUploadRoutes',
      'privateDownloadAuthorization'
    ];
    for (const capability of enabledRuntimeCapabilities) {
      if (AUDIO_PUBLISHING_RUNTIME_CAPABILITIES[capability] !== true) {
        throw new Error('Audio publishing Slice 1 runtime must enable: ' + capability);
      }
    }

    if (CONTINUUM_CONNECTOR_CAPABILITIES.unknownCapability === true) {
      throw new Error('Unknown Continuum capabilities must not be enabled.');
    }
  `;

  const behavior = spawnSync(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '--eval', behaviorProgram],
    { cwd: root, encoding: 'utf8' }
  );

  if (behavior.status !== 0) {
    failures.push(`Continuum capability behavior checks failed:\n${behavior.stderr || behavior.stdout}`);
  }
}

if (failures.length) {
  console.error('Continuum connector contract failed:');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log('Continuum connector contract passed.');
