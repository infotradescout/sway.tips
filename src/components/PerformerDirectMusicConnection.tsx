import { useContext, useEffect, useRef, useState, type FormEvent } from "react";
import { SourcePlayerContext } from "../source-player-context";
import {
  DirectMusicClient,
  DirectMusicClientError,
  isMusicTrack,
} from "../direct-music-client";
import type {
  DirectMusicOverview,
  MusicCommandAction,
  MusicConnection,
  MusicDevice,
  MusicPage,
  MusicPlayback,
  MusicPlaylist,
  MusicTrack,
} from "../direct-music";
type View = {
  kind: "playlists" | "playlist" | "saved" | "search";
  offset: number;
  query: string;
  playlistId: string;
};
const startView: View = {
  kind: "playlists",
  offset: 0,
  query: "",
  playlistId: "",
};
export default function PerformerDirectMusicConnection() {
  const context = useContext(SourcePlayerContext);
  if (!context?.accountId || !context.performerId) return null;
  return (
    <DirectConnection
      key={[context.accountId, context.performerId, context.previewMode].join(
        ":",
      )}
      performerId={context.performerId}
      preview={context.previewMode}
    />
  );
}
function DirectConnection({
  performerId,
  preview,
}: {
  performerId: string;
  preview: boolean;
}) {
  const scope = useContext(SourcePlayerContext),
    lifetime = useRef(new AbortController()),
    client = useRef<DirectMusicClient | null>(null);
  const [overview, setOverview] = useState<DirectMusicOverview | null>(null),
    [error, setError] = useState<string | null>(null),
    [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false),
    busyRef = useRef(false);
  const [devices, setDevices] = useState<MusicDevice[]>([]),
    [playback, setPlayback] = useState<MusicPlayback | null>(null),
    [clock, setClock] = useState(Date.now());
  const [items, setItems] = useState<MusicPage<
      MusicTrack | MusicPlaylist
    > | null>(null),
    [view, setView] = useState<View>(startView),
    [query, setQuery] = useState("");
  const listSequence = useRef(0),
    currentConnection = useRef<MusicConnection | null>(null),
    currentView = useRef(view),
    [readFailed, setReadFailed] = useState(false);
  const [commandUnknown, setCommandUnknown] = useState(false),
    connection = overview?.connections[0] ?? null;
  currentConnection.current = connection;
  currentView.current = view;
  const live = () => !lifetime.current.signal.aborted;
  const matchesConnection = (c: MusicConnection) =>
    live() &&
    currentConnection.current?.id === c.id &&
    currentConnection.current?.revision === c.revision;
  const canObserve = (c: MusicConnection) =>
    matchesConnection(c) && currentConnection.current?.status === "connected";
  const observe = (c: MusicConnection, state: MusicPlayback) => {
    if (!canObserve(c)) return;
    setPlayback((old) =>
      !old || Date.parse(state.observedAt) >= Date.parse(old.observedAt)
        ? state
        : old,
    );
  };
  const callbackError = useRef<string | null>(null);

  const report = (e: unknown) => {
    if (e instanceof Error && e.name === "AbortError") return;
    if (live()) {
      setError(
        e instanceof Error ? e.message : "Music connection unavailable.",
      );
      if (
        e instanceof DirectMusicClientError &&
        [
          "sign_in_required",
          "account_changed",
          "connection_changed",
          "reconnect_required",
        ].includes(e.code)
      ) {
        // Invalidate in-flight reads before React renders the revoked connection.
        listSequence.current += 1;
        if (currentConnection.current)
          currentConnection.current = {
            ...currentConnection.current,
            status: "reconnect_required",
          };
        setPlayback(null);
        setDevices([]);
        setItems(null);
        setOverview((old) =>
          old
            ? {
                ...old,
                connections: old.connections.map((c) => ({
                  ...c,
                  status: "reconnect_required",
                })),
              }
            : old,
        );
      }
    }
  };
  const run = async (work: () => Promise<void>) => {
    if (preview || busyRef.current || !live() || !client.current) return;
    const expectedConnection = currentConnection.current;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (e) {
      if (!expectedConnection || matchesConnection(expectedConnection)) report(e);
    } finally {
      busyRef.current = false;
      if (live()) setBusy(false);
    }
  };
  const refresh = async () => {
    const result = await client.current!.overview();
    if (live()) {
      const next = result.connections[0] ?? null;
      const previous = currentConnection.current;
      if (
        previous?.id !== next?.id ||
        previous?.revision !== next?.revision ||
        previous?.status !== next?.status ||
        result.availability !== "available"
      ) {
        // A reconnect is a new authorization, not permission to reuse old observations.
        listSequence.current += 1;
        setPlayback(null);
        setDevices([]);
        setItems(null);
        currentView.current = startView;
        setView(startView);
        setQuery("");
        setReadFailed(false);
        setCommandUnknown(false);
      }
      // Retire old async work immediately, including before the next React render.
      currentConnection.current = next;
      setOverview(result);
      setNotice(null);
    }
  };
  const readPlayback = async (c: MusicConnection) => {
    try {
      return await client.current!.playback(c);
    } catch (error) {
      if (canObserve(c)) {
        setPlayback(null);
        setReadFailed(true);
      }
      throw error;
    }
  };
  const readPlayers = async (c: MusicConnection) => {
    const found = await client.current!.devices(c);
    if (!canObserve(c)) return;
    setDevices(found);
    const state = await readPlayback(c);
    if (!canObserve(c)) return;
    observe(c, state);
    setReadFailed(false);
    setCommandUnknown(false);
    setNotice("Player state refreshed. No command was repeated.");
  };
  const readLibrary = async (c: MusicConnection, v: View) => {
    const seq = ++listSequence.current;
    try {
      const result = await client.current!.browse(
        c,
        v.kind,
        v.offset,
        v.query,
        v.playlistId,
      );
      if (canObserve(c) && seq === listSequence.current) setItems(result);
    } catch (e) {
      // A late old-account failure must not revoke a newly connected account.
      if (canObserve(c) && seq === listSequence.current) throw e;
    }
  };
  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    client.current = new DirectMusicClient(performerId, controller.signal);
    if (!preview) {
      void refresh().catch(report);
      const code = new URLSearchParams(window.location.search).get(
        "direct_music_error",
      );
      const messages: Record<string, string> = {
        oauth_canceled:
          "Music account connection was canceled. Your previous connection was kept.",
        oauth_expired:
          "This sign-in attempt expired. Start again from Connect Spotify.",
        connection_changed:
          "Your account connection changed during sign-in. Refresh before reconnecting.",
        reconnect_required:
          "The requested music permissions were not granted. Reconnect and review them.",
        approval_required:
          "Spotify is awaiting approval for Sway?s intended use.",
        account_changed:
          "Your Sway account changed during sign-in. Refresh and try again.",
      };
      if (code) {
        callbackError.current =
          messages[code] ??
          "Music account connection could not be completed. Refresh and reconnect.";
        setError(callbackError.current);
      }
    }
    return () => {
      controller.abort();
    };
  }, []);
  useEffect(() => {
    if (
      !connection ||
      connection.status !== "connected" ||
      overview?.availability !== "available" ||
      preview
    )
      return;
    let disposed = false,
      timer: ReturnType<typeof setTimeout> | undefined,
      libraryAt = 0;
    const c = connection;
    const tick = async () => {
      let wait = 5000;
      try {
        if (document.visibilityState !== "hidden") {
          const state = await readPlayback(c);
          if (!disposed && canObserve(c)) {
            observe(c, state);
            setReadFailed(false);
            setClock(Date.now());
          }
          if (
            !disposed &&
            canObserve(c) &&
            Date.now() - libraryAt >= 30000
          ) {
            await readLibrary(c, currentView.current);
            libraryAt = Date.now();
          }
        }
      } catch (e) {
        if (!disposed && canObserve(c)) {
          setReadFailed(true);
          setPlayback(null);
          report(e);
          if (e instanceof DirectMusicClientError && e.retryAfterSeconds)
            wait = Math.max(wait, e.retryAfterSeconds * 1000);
        }
      }
      if (!disposed && live()) timer = setTimeout(tick, wait);
    };
    void client
      .current!.devices(c)
      .then((found) => {
        if (!disposed && canObserve(c)) setDevices(found);
      })
      .catch((e) => {
        if (!disposed && canObserve(c)) {
          setDevices([]);
          report(e);
        }
      });
    void tick();
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
    };
  }, [
    connection?.id,
    connection?.revision,
    connection?.status,
    overview?.availability,
    preview,
  ]);
  useEffect(() => {
    if (
      connection?.status === "connected" &&
      overview?.availability === "available"
    )
      void readLibrary(connection, view).catch(report);
  }, [view]);
  useEffect(() => {
    const timer = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const selectView = (v: View) => {
    setItems(null);
    setView(v);
  };
  const connect = () =>
    run(async () => {
      if (
        connection &&
        !window.confirm(
          "Reconnect or change the Spotify account " +
            connection.label +
            "? The selected player will be cleared.",
        )
      )
        return;
      const url = await client.current!.connect(connection);
      if (live() && (!connection || matchesConnection(connection)))
        window.location.assign(url);
    });
  const disconnect = () =>
    run(async () => {
      if (
        !connection ||
        !window.confirm(
          "Disconnect " +
            connection.label +
            " from Sway? Sway will delete this connection and its stored authorization. This does not stop music already playing.",
        )
      )
        return;
      await client.current!.disconnect(connection);
      if (matchesConnection(connection)) {
        currentConnection.current = null;
        listSequence.current += 1;
        setView(startView);
        setQuery("");
        setCommandUnknown(false);
        setOverview((old) => (old ? { ...old, connections: [] } : old));
        setPlayback(null);
        setDevices([]);
        setItems(null);
        setNotice("Music account disconnected.");
      }
    });
  const choose = (deviceId: string) =>
    run(async () => {
      if (!connection) return;
      await client.current!.target(connection, deviceId);
      if (canObserve(connection)) {
        setOverview((old) =>
          old
            ? {
                ...old,
                connections: old.connections.map((c) => ({
                  ...c,
                  selectedDeviceId: deviceId,
                })),
              }
            : old,
        );
        setNotice("Playback destination selected. No music was started.");
      }
    });
  const command = (action: MusicCommandAction, uri?: string) =>
    run(async () => {
      if (!connection?.selectedDeviceId || !canControl || !canObserve(connection)) return;
      const id = crypto.randomUUID();
      try {
        const result = await client.current!.command(
          connection,
          id,
          action,
          connection.selectedDeviceId,
          uri,
        );
        if (canObserve(connection)) {
          setNotice(result.message);
          setCommandUnknown(
            result.status === "uncertain" || result.status === "in_flight",
          );
          if (result.status === "rejected") setError(result.message);
        }
      } catch (e) {
        if (canObserve(connection)) {
          setCommandUnknown(
            !(e instanceof DirectMusicClientError) ||
              [
                "unavailable",
                "connection_unavailable",
                "invalid_response",
              ].includes(e.code),
          );
          setNotice(
            "The command result could not be confirmed. Check playback before sending another action.",
          );
        }
        throw e;
      }
      if (!canObserve(connection)) return;
      const state = await readPlayback(connection);
      if (canObserve(connection)) {
        observe(connection, state);
        setReadFailed(false);
      }
    });
  const fresh =
    !!playback &&
    !readFailed &&
    clock - Date.parse(playback.observedAt) < 15000;
  const selected = devices.find(
    (d) => d.id === connection?.selectedDeviceId && !d.restricted,
  );
  const canControl =
    !preview &&
    !busy &&
    !commandUnknown &&
    overview?.availability === "available" &&
    connection?.status === "connected" &&
    !!selected &&
    fresh;
  const disallows = (action: MusicCommandAction) =>
    playback?.disallowed.includes(
      {
        pause: "pausing",
        resume: "resuming",
        next: "skipping_next",
        previous: "skipping_prev",
        transfer: "transferring_playback",
        queue: "adding_to_queue",
        play: "resuming",
      }[action],
    );
  const actualDevice = devices.find((d) => d.id === playback?.deviceId);
  const submitSearch = (e: FormEvent) => {
    e.preventDefault();
    if (query.trim())
      selectView({
        kind: "search",
        offset: 0,
        query: query.trim(),
        playlistId: "",
      });
  };
  const tracks = items?.items.filter(isMusicTrack) ?? [],
    playlists =
      items?.items.filter((i): i is MusicPlaylist => !isMusicTrack(i)) ?? [];
  return (
    <section
      data-sway-direct-music="true"
      className="sway-source-panel mb-5"
      aria-label="Direct music connection"
    >
      <p className="sway-source-kicker">Connect and control</p>
      <h3>Play from your music account.</h3>
      <p className="sway-source-description">
        Sign in with your service, choose where music plays, and control it
        here. The source player handles the audio. No library export or upload
        is required.
      </p>
      {preview ? (
        <p className="sway-source-feedback">
          Account connections are unavailable in preview mode.
        </p>
      ) : null}
      {!overview && !preview && !error ? (
        <p role="status" className="sway-source-feedback">
          Checking music connections…
        </p>
      ) : null}
      {overview?.availability === "approval_required" ? (
        <p className="sway-source-feedback">
          Spotify connection is awaiting provider approval for Sway’s use. It is
          not available for live performances or paid requests under standard
          consumer access.
        </p>
      ) : null}
      {overview?.availability === "setup_required" ? (
        <p className="sway-source-feedback">
          Spotify account connection is not configured on Sway yet. You do not
          need to create a developer app.
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-3 mt-4">
        <button
          type="button"
          className="sway-source-button sway-source-button--primary"
          disabled={preview || busy || overview?.availability !== "available"}
          onClick={connect}
        >
          {connection ? "Reconnect Spotify" : "Connect Spotify"}
        </button>
        {connection ? (
          <>
            <span className="text-sm text-slate-200">
              {connection.label} ·{" "}
              {connection.status === "connected"
                ? "Account connected"
                : "Reconnect required"}
            </span>
            <button
              type="button"
              className="sway-source-button"
              onClick={disconnect}
              disabled={busy}
            >
              Disconnect
            </button>
          </>
        ) : null}
        <button
          type="button"
          className="sway-source-button"
          disabled={preview || busy}
          onClick={() => void run(refresh)}
        >
          Refresh connection
        </button>
      </div>
      {notice ? (
        <p role="status" className="sway-source-feedback">
          {notice}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="sway-source-feedback">
          {error}
        </p>
      ) : null}
      {connection?.status === "connected" &&
      overview?.availability === "available" ? (
        <div className="mt-5 grid min-w-0 gap-5 lg:grid-cols-2">
          <div className="min-w-0">
            <label
              className="block text-sm font-semibold"
              htmlFor="direct-music-device"
            >
              Playback destination
            </label>
            <select
              id="direct-music-device"
              className="sway-source-field mt-2 w-full"
              value={connection.selectedDeviceId ?? ""}
              disabled={busy}
              onChange={(e) => void choose(e.target.value)}
            >
              <option value="" disabled>
                Choose a player
              </option>
              {devices
                .filter((d) => d.id)
                .map((d) => (
                  <option key={d.id} value={d.id} disabled={d.restricted}>
                    {d.name}
                    {d.restricted ? " · restricted" : ""}
                    {d.active ? " · active" : ""}
                  </option>
                ))}
            </select>
            {!devices.length ? (
              <p className="sway-source-description">
                Open Spotify on the intended computer, phone, or supported
                speaker, then refresh players. No music starts until you choose
                an action.
              </p>
            ) : null}
            <button
              type="button"
              className="sway-source-button mt-3"
              disabled={busy}
              onClick={() => void run(() => readPlayers(connection))}
            >
              Refresh players and playback
            </button>
            {playback && fresh ? (
              <div
                data-sway-direct-playback="true"
                className="mt-4 rounded-xl border border-white/10 p-4"
              >
                <p className="text-sm font-semibold">
                  {playback.deviceId
                    ? playback.playing
                      ? "Playing"
                      : "Paused"
                    : "No active playback"}
                  {actualDevice ? " on " + actualDevice.name : ""}
                </p>
                {playback.deviceId &&
                playback.deviceId !== connection.selectedDeviceId ? (
                  <p className="text-sm text-amber-200">
                    The active player differs from your selected destination.
                  </p>
                ) : null}
                {playback.track ? (
                  <div className="mt-3 flex min-w-0 gap-3">
                    {playback.track.artwork ? (
                      <img
                        src={playback.track.artwork}
                        alt=""
                        className="h-14 w-14 rounded shrink-0"
                      />
                    ) : null}
                    <div className="min-w-0">
                      <a
                        href={playback.track.url}
                        target="_blank"
                        rel="noreferrer"
                        className="block break-words text-sm underline"
                      >
                        {playback.track.title}
                      </a>
                      <p className="text-sm text-slate-400 break-words">
                        {playback.track.artist}
                      </p>
                      <p className="text-xs text-slate-400">
                        Music provided by Spotify
                      </p>
                    </div>
                  </div>
                ) : null}
              </div>
            ) : (
              <p role="status" className="sway-source-feedback">
                Playback state is not confirmed. Controls stay unavailable until
                the player can be checked.
              </p>
            )}
            <div className="mt-3 flex flex-wrap gap-2">
              {(["resume", "pause", "previous", "next"] as const).map(
                (action) => (
                  <button
                    key={action}
                    type="button"
                    className="sway-source-button"
                    disabled={!canControl || disallows(action)}
                    onClick={() => void command(action)}
                  >
                    {action[0].toUpperCase() + action.slice(1)}
                  </button>
                ),
              )}
            </div>
            {commandUnknown ? (
              <p className="sway-source-description">
                Use “Refresh players and playback” before another command. An
                uncertain command is never automatically repeated.
              </p>
            ) : null}
            <details className="sway-source-disclosure">
              <summary>Move playback to this device</summary>
              <p>
                This explicitly switches the active destination; it does not
                automatically begin a new track.
              </p>
              <button
                type="button"
                className="sway-source-button"
                disabled={!canControl || disallows("transfer")}
                onClick={() => void command("transfer")}
              >
                Use this playback device
              </button>
            </details>
            {scope?.approvedRequests.filter((r) =>
              /^spotify:track:[A-Za-z0-9]{22}$/.test(r.spotifyUri ?? ""),
            ).length ? (
              <div className="mt-4">
                <h4 className="font-semibold">Approved Spotify requests</h4>
                {scope.approvedRequests
                  .filter((r) =>
                    /^spotify:track:[A-Za-z0-9]{22}$/.test(r.spotifyUri ?? ""),
                  )
                  .slice(0, 20)
                  .map((r) => (
                    <div
                      key={r.id}
                      className="mt-2 flex flex-wrap items-center gap-2"
                    >
                      <span className="text-sm break-words">{r.title}</span>
                      <button
                        className="sway-source-button"
                        disabled={!canControl}
                        onClick={() => void command("play", r.spotifyUri!)}
                      >
                        Play request
                      </button>
                    </div>
                  ))}
              </div>
            ) : null}
          </div>
          <div className="min-w-0">
            <form onSubmit={submitSearch} className="flex flex-wrap gap-2">
              <input
                aria-label="Search connected Spotify music"
                value={query}
                maxLength={200}
                onChange={(e) => setQuery(e.target.value)}
                className="sway-source-field min-w-0 flex-1"
                placeholder="Search songs or artists"
              />
              <button
                className="sway-source-button"
                disabled={!query.trim() || busy}
              >
                Search
              </button>
            </form>
            <div className="my-3 flex flex-wrap gap-2">
              <button
                className="sway-source-button"
                onClick={() => selectView(startView)}
              >
                My playlists
              </button>
              <button
                className="sway-source-button"
                onClick={() => selectView({ ...startView, kind: "saved" })}
              >
                Saved songs
              </button>
              <button
                className="sway-source-button"
                onClick={() => void run(() => readLibrary(connection, view))}
              >
                Refresh library
              </button>
            </div>
            <p className="text-xs text-slate-400">
              Read directly from your connected Spotify account. Updates refresh
              automatically while this screen is open.
            </p>
            {!items ? (
              <p role="status" className="sway-source-feedback">
                Loading connected library…
              </p>
            ) : null}
            {items && !items.items.length ? (
              <p className="sway-source-feedback">
                No music returned for this view.
              </p>
            ) : null}
            <div
              className="mt-3 max-h-[32rem] overflow-auto"
              aria-label="Connected music library"
            >
              {playlists.map((p) => (
                <button
                  key={p.id}
                  className="flex w-full min-w-0 gap-3 rounded-lg p-3 text-left hover:bg-white/5"
                  onClick={() =>
                    selectView({
                      ...startView,
                      kind: "playlist",
                      playlistId: p.id,
                    })
                  }
                >
                  {p.artwork ? (
                    <img
                      src={p.artwork}
                      alt=""
                      className="h-12 w-12 rounded shrink-0"
                    />
                  ) : null}
                  <span className="min-w-0 break-words text-sm">{p.name}</span>
                </button>
              ))}
              {tracks.map((t, i) => (
                <div
                  key={t.id + ":" + i}
                  className="flex min-w-0 flex-wrap gap-3 border-b border-white/5 py-3"
                >
                  {t.artwork ? (
                    <img
                      src={t.artwork}
                      alt=""
                      className="h-12 w-12 rounded shrink-0"
                    />
                  ) : null}
                  <div className="min-w-0 flex-1">
                    <a
                      href={t.url}
                      target="_blank"
                      rel="noreferrer"
                      className="text-sm break-words underline"
                    >
                      {t.title}
                    </a>
                    <p className="text-xs text-slate-400 break-words">
                      {t.artist}
                    </p>
                    {!t.playable ? (
                      <p className="text-xs text-amber-200">
                        Unavailable for playback
                      </p>
                    ) : null}
                  </div>
                  <div className="flex gap-2">
                    <button
                      className="sway-source-button"
                      aria-label={"Play " + t.title}
                      disabled={!canControl || !t.playable}
                      onClick={() => void command("play", t.uri)}
                    >
                      Play
                    </button>
                    <button
                      className="sway-source-button"
                      aria-label={"Queue " + t.title}
                      disabled={
                        !canControl || !t.playable || disallows("queue")
                      }
                      onClick={() => void command("queue", t.uri)}
                    >
                      Queue
                    </button>
                  </div>
                </div>
              ))}
            </div>
            {items ? (
              <div className="mt-3 flex gap-3">
                <button
                  className="sway-source-button"
                  disabled={view.offset === 0}
                  onClick={() =>
                    selectView({
                      ...view,
                      offset: Math.max(
                        0,
                        view.offset - (view.kind === "search" ? 10 : 50),
                      ),
                    })
                  }
                >
                  Previous page
                </button>
                <button
                  className="sway-source-button"
                  disabled={items.nextOffset === null}
                  onClick={() =>
                    selectView({ ...view, offset: items.nextOffset! })
                  }
                >
                  Next page
                </button>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </section>
  );
}
