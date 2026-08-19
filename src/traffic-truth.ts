export const SWAY_TRAFFIC_TRUTH_VERSION = 'v1' as const;

export type TrafficTruthClass =
  | 'human_candidate'
  | 'known_bot'
  | 'scanner'
  | 'qa_automation'
  | 'legacy_unclassified';

export type TrafficTruthUserAgentClass = Exclude<TrafficTruthClass, 'legacy_unclassified'>;

const TRAFFIC_SOURCE_CLASSES = [
  'human_candidate',
  'known_bot',
  'scanner',
  'qa_automation'
] as const;

const KNOWN_BOT_USER_AGENT_PATTERN = /(?:googlebot|google-inspectiontool|bingbot|duckduckbot|baiduspider|yandexbot|applebot|gptbot|oai-searchbot|chatgpt-user|facebookexternalhit|facebot|meta-externalagent|twitterbot|linkedinbot|slackbot|discordbot|telegrambot|whatsapp|ahrefsbot|mj12bot|semrushbot|petalbot|bytespider|uptimerobot|statuscake|pingdom|crawler|spider)/i;
const SCANNER_USER_AGENT_PATTERN = /(?:censysinspect|wp-safe-scanner|wpbot|cms-checker|masscan|zgrab|nmap|nikto|sqlmap|acunetix|nessus|nuclei|dirbuster|gobuster|ffuf|wpscan)/i;
const AUTOMATION_USER_AGENT_PATTERN = /(?:headlesschrome|playwright|puppeteer|selenium|phantomjs|curl\/|wget\/|python-requests|postmanruntime|insomnia|go-http-client|node-fetch|undici|axios\/|libwww-perl|scrapy)/i;

const REPOSITORY_FILE_PATHS = new Set([
  '/package.json',
  '/package-lock.json',
  '/yarn.lock',
  '/pnpm-lock.yaml',
  '/tsconfig.json',
  '/vite.config.ts',
  '/vite.config.js',
  '/server.ts',
  '/render.yaml',
  '/dockerfile',
  '/docker-compose.yml',
  '/composer.json',
  '/composer.lock',
  '/.dockerignore',
  '/.npmrc',
  '/.gitignore'
]);

const SCANNER_PREFIXES = [
  '/.env',
  '/.git',
  '/.svn',
  '/.hg',
  '/.aws',
  '/.ssh',
  '/wp-admin',
  '/wp-login',
  '/wp-content',
  '/wp-includes',
  '/wp-json',
  '/wordpress',
  '/xmlrpc.php',
  '/phpmyadmin',
  '/pma/',
  '/adminer',
  '/vendor/phpunit',
  '/cgi-bin',
  '/actuator',
  '/server-status',
  '/server-info',
  '/solr/',
  '/_profiler',
  '/_ignition',
  '/node_modules/',
  '/scripts/',
  '/drizzle/',
  '/.github/'
] as const;

const SERVER_CODE_PREFIXES = ['/src/', '/scripts/', '/drizzle/', '/node_modules/', '/vendor/'] as const;
const EXECUTABLE_PROBE_SUFFIX_PATTERN = /\.(?:php\d*|phtml|phar|asp|aspx|jsp|cgi)(?:\/|$)/i;
const SECRET_OR_BACKUP_SUFFIX_PATTERN = /(?:^|\/)(?:[^/]*\.)?(?:env|pem|key|crt|p12|pfx|sql|sqlite|db|bak|backup|old|orig|save|swp|log|ini|conf)(?:\.[^/]*)?$/i;
const WORDPRESS_MANIFEST_PATTERN = /(?:^|\/)wlwmanifest\.xml$/i;
const DOTFILE_SEGMENT_PATTERN = /(?:^|\/)\.(?!well-known(?:\/|$))[^/]+/i;
const PATH_TRAVERSAL_PATTERN = /(?:^|\/)\.\.(?:\/|$)/;

export function normalizeTrafficPath(rawPath: string | null | undefined) {
  let value = typeof rawPath === 'string' && rawPath.trim() ? rawPath.trim() : '/';
  value = value.split('#', 1)[0].split('?', 1)[0].replace(/\\/g, '/');

  for (let pass = 0; pass < 2; pass += 1) {
    try {
      const decoded = decodeURIComponent(value);
      if (decoded === value) break;
      value = decoded;
    } catch {
      break;
    }
  }

  value = value.replace(/\/{2,}/g, '/');
  if (!value.startsWith('/')) value = `/${value}`;
  return value.toLowerCase();
}

export function isScannerTrafficPath(rawPath: string | null | undefined) {
  const path = normalizeTrafficPath(rawPath);
  if (path.startsWith('/.well-known/')) return false;
  if (REPOSITORY_FILE_PATHS.has(path)) return true;
  if (SCANNER_PREFIXES.some((prefix) => path === prefix || path.startsWith(prefix))) return true;
  if (SERVER_CODE_PREFIXES.some((prefix) => path.startsWith(prefix))) return true;
  if (EXECUTABLE_PROBE_SUFFIX_PATTERN.test(path)) return true;
  if (SECRET_OR_BACKUP_SUFFIX_PATTERN.test(path)) return true;
  if (WORDPRESS_MANIFEST_PATTERN.test(path)) return true;
  if (DOTFILE_SEGMENT_PATTERN.test(path)) return true;
  if (PATH_TRAVERSAL_PATTERN.test(path)) return true;
  return false;
}

export function classifyTrafficUserAgent(userAgent: string | null | undefined): TrafficTruthUserAgentClass {
  const normalized = typeof userAgent === 'string' ? userAgent.trim() : '';
  if (SCANNER_USER_AGENT_PATTERN.test(normalized)) return 'scanner';
  if (KNOWN_BOT_USER_AGENT_PATTERN.test(normalized)) return 'known_bot';
  if (!normalized || AUTOMATION_USER_AGENT_PATTERN.test(normalized)) return 'qa_automation';
  return 'human_candidate';
}

function safeSourceSuffix(source: string | null | undefined) {
  const normalized = typeof source === 'string' ? source.trim().toLowerCase() : '';
  const safe = normalized
    .replace(/[?&=#]/g, '_')
    .replace(/[^a-z0-9_.:-]+/g, '_')
    .replace(/^[:_.-]+|[:_.-]+$/g, '')
    .slice(0, 48);
  return safe || 'unknown';
}

export function parseTrafficTruthSource(source: string | null | undefined): {
  classification: TrafficTruthClass;
  source: string;
} {
  const normalized = typeof source === 'string' ? source.trim().toLowerCase() : '';
  for (const classification of TRAFFIC_SOURCE_CLASSES) {
    const prefix = `${classification}:`;
    if (normalized.startsWith(prefix)) {
      return {
        classification,
        source: safeSourceSuffix(normalized.slice(prefix.length))
      };
    }
  }
  return {
    classification: 'legacy_unclassified',
    source: safeSourceSuffix(normalized)
  };
}

export function encodeTrafficTruthSource(
  classification: Exclude<TrafficTruthClass, 'legacy_unclassified'>,
  source: string | null | undefined
) {
  const parsed = parseTrafficTruthSource(source);
  const prefix = `${classification}:`;
  const available = Math.max(1, 64 - prefix.length);
  return `${prefix}${safeSourceSuffix(parsed.source).slice(0, available)}`;
}

export type TrafficTruthAuditRow = {
  eventId: string;
  entityType: string;
  entityId: string;
  eventType: string;
  metadata: Record<string, unknown> | null;
  createdAt: Date | string;
};

export type TrafficTruthAuditSummary = {
  version: typeof SWAY_TRAFFIC_TRUTH_VERSION;
  rawRows: number;
  projectedRows: number;
  humanCandidateEvents: number;
  humanCandidateJourneys: number;
  knownBotEvents: number;
  knownBotJourneys: number;
  scannerEvents: number;
  scannerJourneys: number;
  qaAutomationEvents: number;
  qaAutomationJourneys: number;
  legacyUnclassifiedEvents: number;
  legacyUnclassifiedJourneys: number;
  automatedJourneysExcluded: number;
  taintedJourneysExcluded: number;
  legacyJourneysExcluded: number;
};

function rowSource(row: TrafficTruthAuditRow) {
  const metadata = row.metadata;
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  const source = metadata.source ?? metadata.attribution_channel;
  return typeof source === 'string' ? source : null;
}

function cloneWithProjectedSource<T extends TrafficTruthAuditRow>(row: T) {
  if (!row.metadata) return row;
  const parsed = parseTrafficTruthSource(rowSource(row));
  if (parsed.classification !== 'human_candidate') return row;
  const metadata = { ...row.metadata };
  if (typeof metadata.source === 'string') metadata.source = parsed.source;
  if (typeof metadata.attribution_channel === 'string') metadata.attribution_channel = parsed.source;
  return { ...row, metadata };
}

export function projectHumanTrafficAuditRows<T extends TrafficTruthAuditRow>(inputRows: T[]): {
  rows: T[];
  summary: TrafficTruthAuditSummary;
} {
  const humanTaggedJourneys = new Set<string>();
  const humanJourneys = new Set<string>();
  const excludedJourneys = new Set<string>();
  const classJourneys: Record<Exclude<TrafficTruthClass, 'human_candidate'> | 'human_candidate', Set<string>> = {
    human_candidate: new Set<string>(),
    known_bot: new Set<string>(),
    scanner: new Set<string>(),
    qa_automation: new Set<string>(),
    legacy_unclassified: new Set<string>()
  };
  const classEvents: Record<TrafficTruthClass, number> = {
    human_candidate: 0,
    known_bot: 0,
    scanner: 0,
    qa_automation: 0,
    legacy_unclassified: 0
  };

  for (const row of inputRows) {
    if (row.entityType !== 'shell_friction' || row.eventType === 'discovery_experiment.assignment') continue;
    const classification = parseTrafficTruthSource(rowSource(row)).classification;
    classEvents[classification] += 1;
    classJourneys[classification].add(row.entityId);
    if (classification === 'human_candidate') {
      humanTaggedJourneys.add(row.entityId);
      humanJourneys.add(row.entityId);
    }
    if (classification === 'known_bot' || classification === 'scanner' || classification === 'qa_automation') {
      excludedJourneys.add(row.entityId);
    }
  }

  for (const journeyId of excludedJourneys) humanJourneys.delete(journeyId);

  const rows = inputRows.flatMap((row) => {
    if (row.entityType !== 'shell_friction') return [row];
    if (!humanJourneys.has(row.entityId)) return [];
    const classification = parseTrafficTruthSource(rowSource(row)).classification;
    if (classification === 'known_bot' || classification === 'scanner' || classification === 'qa_automation') return [];
    return [cloneWithProjectedSource(row) as T];
  });

  const taintedJourneysExcluded = [...humanTaggedJourneys]
    .filter((journeyId) => excludedJourneys.has(journeyId)).length;
  const legacyJourneysExcluded = [...classJourneys.legacy_unclassified]
    .filter((journeyId) => (
      !humanTaggedJourneys.has(journeyId)
      && !excludedJourneys.has(journeyId)
    )).length;

  return {
    rows,
    summary: {
      version: SWAY_TRAFFIC_TRUTH_VERSION,
      rawRows: inputRows.length,
      projectedRows: rows.length,
      humanCandidateEvents: classEvents.human_candidate,
      humanCandidateJourneys: humanJourneys.size,
      knownBotEvents: classEvents.known_bot,
      knownBotJourneys: classJourneys.known_bot.size,
      scannerEvents: classEvents.scanner,
      scannerJourneys: classJourneys.scanner.size,
      qaAutomationEvents: classEvents.qa_automation,
      qaAutomationJourneys: classJourneys.qa_automation.size,
      legacyUnclassifiedEvents: classEvents.legacy_unclassified,
      legacyUnclassifiedJourneys: classJourneys.legacy_unclassified.size,
      automatedJourneysExcluded: excludedJourneys.size,
      taintedJourneysExcluded,
      legacyJourneysExcluded
    }
  };
}
