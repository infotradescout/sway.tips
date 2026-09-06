        if (!response.ok) throw new Error('Room temporarily unavailable');
        const data = await response.json();
        if (!stillCurrent(sequence)) return;
        const normalized = normalizeBackendState(data);
        if (!matchesRoom(normalized)) throw new Error('Room response did not match the selected room');
        if (data?.room_lookup === 'ended') { clear('ended', ENDED_LIVE_ROOM_COPY); return; }
        publish({ scope, state: normalized, loading: false, lookup: { status: data?.room_lookup === 'active' ? 'active' : 'global', message: null } });
        if (response.headers.get('x-sway-discovery-recorded') === '1') scope.discoveryRecorded = true;
      } catch (error) {
