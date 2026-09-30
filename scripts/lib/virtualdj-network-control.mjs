const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

function trimText(value, maxLength = 2048) {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, maxLength) : null;
}

function escapeVdjString(value) {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/[\r\n]+/g, ' ')
    .slice(0, 2048);
}

function parseVdjBoolean(value) {
  const normalized = String(value ?? '').trim();
  if (/^(?:true|yes|on|1)$/i.test(normalized)) return true;
  if (/^(?:false|no|off|0)$/i.test(normalized)) return false;
  return null;
}

function parseNumber(value) {
  const parsed = Number.parseFloat(String(value ?? '').replace(/[^0-9.+-]/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeDeck(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 8 ? parsed : 1;
}

function comparableText(value) {
  return String(value ?? '').normalize('NFKC').trim().toLocaleLowerCase().replace(/\s+/g, ' ');
}

function comparablePath(value) {
  // File names can differ only by whitespace, Unicode or case. Without an
  // authoritative filesystem identity, fail closed instead of conflating them.
  return typeof value === 'string' ? value.replace(/\\/g, '/') : '';
}

function commandConfirmation(action, track, state) {
  if (action === 'load') {
    const requestedPath = comparablePath(track.path);
    if (requestedPath && requestedPath === comparablePath(state.trackPath)) return 'exact_track_confirmed';
    return 'source_acknowledged';
  }
  if (action === 'play' && state.playing === true) return 'source_state_confirmed';
  if (action === 'pause' && state.playing === false) return 'source_state_confirmed';
  return 'source_acknowledged';
}

export class VirtualDjNetworkControl {
  constructor({
    baseUrl = 'http://127.0.0.1:8088',
    password = null,
    deck = 1,
    requestTimeoutMs = 5_000,
    allowRemote = false,
    fetchImpl = fetch
  } = {}) {
    const url = new URL(baseUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error('VirtualDJ Network Control must use HTTP or HTTPS.');
    }
    if (!allowRemote && !LOOPBACK_HOSTS.has(url.hostname)) {
      throw new Error('VirtualDJ Network Control must stay on this machine unless --allow-remote-virtualdj is explicit.');
    }
    this.baseUrl = url.toString().replace(/\/+$/, '');
    this.password = trimText(password, 512);
    this.deck = normalizeDeck(deck);
    this.requestTimeoutMs = Math.max(1_000, Math.min(Number(requestTimeoutMs) || 5_000, 30_000));
    this.fetchImpl = fetchImpl;
  }

  async request(endpoint, script) {
    const controller = new AbortController();
    let timeout;
    const deadline = new Promise((_, reject) => {
      timeout = setTimeout(() => {
        // Cancellation is best effort: a stalled transport or response body
        // must not hold the bridge's single execution loop indefinitely.
        reject(new Error(endpoint === 'execute'
          ? 'VirtualDJ command response timed out. The command may have reached your deck. Check playback before sending another command.'
          : 'VirtualDJ playback status timed out.'));
        controller.abort();
      }, this.requestTimeoutMs);
    });
    try {
      return await Promise.race([deadline, (async () => {
        const response = await this.fetchImpl(`${this.baseUrl}/${endpoint}`, {
          method: 'POST',
          headers: {
            'content-type': 'text/plain; charset=utf-8',
            ...(this.password ? { authorization: `Bearer ${this.password}` } : {})
          },
          body: script,
          signal: controller.signal
        });
        if (!response.ok) {
          // Never expose an echoed booth-local script or path in cloud errors.
          throw new Error(`VirtualDJ ${endpoint} rejected the request (${response.status}).`);
        }
        const body = await response.text();
        return body.trim();
      })()]);
    } catch (error) {
      if (error instanceof Error && [
        'VirtualDJ command response timed out. The command may have reached your deck. Check playback before sending another command.',
        'VirtualDJ playback status timed out.'
      ].includes(error.message)) throw error;
      if (error instanceof Error && !/ rejected the request \(/.test(error.message)) {
        if (endpoint === 'execute') {
          const uncertain = new Error('VirtualDJ response was lost; command outcome is uncertain. Check the selected deck before retrying.');
          uncertain.cause = error;
          throw uncertain;
        }
        const unavailable = new Error('VirtualDJ state request failed.');
        unavailable.cause = error;
        throw unavailable;
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  query(script) {
    return this.request('query', script);
  }

  async execute(script) {
    const result = await this.request('execute', script);
    // Network Control documents exactly true/false for /execute. Query-style
    // values such as 1 or on are not an execution acknowledgement.
    if (result !== 'true') throw new Error('VirtualDJ rejected the command.');
    return result;
  }

  async readState(deck = this.deck) {
    const targetDeck = normalizeDeck(deck);
    // Poll deliberately stays low-rate. VirtualDJ's official Network Control
    // endpoint is command-oriented; it is not a high-frequency waveform feed.
    const [title, artist, filePath, playing, position, bpm] = await Promise.all([
      this.query(`deck ${targetDeck} get_title`),
      this.query(`deck ${targetDeck} get_artist`),
      this.query(`deck ${targetDeck} get_filepath`),
      this.query(`deck ${targetDeck} play`),
      this.query(`deck ${targetDeck} get_position`),
      this.query(`deck ${targetDeck} get_bpm`)
    ]);
    const playingValue = parseVdjBoolean(playing);
    if (playingValue === null) throw new Error('VirtualDJ returned an unreadable playback state.');
    const bpmValue = parseNumber(bpm);
    return {
      sourceKey: 'virtualdj',
      transport: 'virtualdj_network_control_http',
      connectionStatus: 'connected',
      deck: targetDeck,
      trackTitle: trimText(title, 200),
      trackArtist: trimText(artist, 200),
      trackPath: trimText(filePath),
      playing: playingValue,
      positionMs: null,
      durationMs: null,
      bpmTimes100: bpmValue === null ? null : Math.max(0, Math.round(bpmValue * 100)),
      observedAt: new Date().toISOString(),
      metadata: {
        positionRatio: parseNumber(position),
        networkControlUrl: this.baseUrl
      }
    };
  }

  async executeCommand(command) {
    const payload = command?.payload && typeof command.payload === 'object' ? command.payload : {};
    const deck = normalizeDeck(payload.deck ?? this.deck);
    const track = payload.track && typeof payload.track === 'object' ? payload.track : {};
    let script;
    let loadMatchMode = null;

    switch (command?.action) {
      case 'load': {
        const path = trimText(track.path);
        if (path) {
          script = `deck ${deck} load "${escapeVdjString(path)}"`;
          loadMatchMode = 'exact_library_path';
          break;
        }
        throw new Error('VirtualDJ automatic load requires an exact synced booth path. Load this track manually.');
      }
      case 'play':
        script = `deck ${deck} play on`;
        break;
      case 'pause':
        script = `deck ${deck} pause`;
        break;
      case 'stop':
        script = `deck ${deck} stop`;
        break;
      case 'cue':
        script = `deck ${deck} cue_stop`;
        break;
      case 'next':
        script = `deck ${deck} load_next`;
        break;
      case 'previous':
        script = `deck ${deck} load_previous`;
        break;
      default:
        throw new Error(`Unsupported VirtualDJ action: ${String(command?.action || '')}`);
    }

    await this.execute(script);
    let observation = null;
    try {
      observation = await this.readState(deck);
    } catch {
      // Acceptance remains real even when follow-up state cannot confirm it.
    }
    return {
      executed: true,
      acknowledgement: 'accepted',
      deck,
      action: command.action,
      script,
      loadMatchMode,
      confirmationStatus: observation ? commandConfirmation(command.action, track, observation) : 'source_acknowledged',
      observedAt: observation?.observedAt || null,
      observedDeck: observation?.deck || deck,
      observedTrackTitle: observation?.trackTitle || null,
      observedTrackArtist: observation?.trackArtist || null,
      observedPlaying: typeof observation?.playing === 'boolean' ? observation.playing : null,
      observation
    };
  }
}

export const VIRTUALDJ_NETWORK_CONTROL_REQUIREMENTS = {
  minimumVersion: '2023',
  license: 'Pro',
  extension: 'Network Control',
  officialDocumentation: 'https://virtualdj.com/wiki/NetworkControlPlugin.html'
};
