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
        const body = await response.text();
        if (!response.ok) {
          throw new Error(`VirtualDJ ${endpoint} rejected the request (${response.status}): ${body || 'no response body'}`);
        }
        return body.trim();
      })()]);
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
    if (result !== 'true') throw new Error(`VirtualDJ returned ${result || 'false'} for: ${script}`);
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
        const query = [trimText(track.artist, 200), trimText(track.title, 200)].filter(Boolean).join(' ');
        if (!query) throw new Error('VirtualDJ load requires an exact library path or a title/artist search.');
        script = `search "${escapeVdjString(query)}" & browser_scroll "top" & deck ${deck} load`;
        loadMatchMode = 'virtualdj_search_first_result';
        break;
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
    return {
      executed: true,
      deck,
      action: command.action,
      script,
      loadMatchMode
    };
  }
}

export const VIRTUALDJ_NETWORK_CONTROL_REQUIREMENTS = {
  minimumVersion: '2023',
  license: 'Pro',
  extension: 'Network Control',
  officialDocumentation: 'https://virtualdj.com/wiki/NetworkControlPlugin.html'
};
