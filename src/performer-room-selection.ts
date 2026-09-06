type RoomSelectionStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
const PREFIX = 'sway:performer-room-selection:v1:';
const ROOM_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function browserStorage(): RoomSelectionStorage | null {
  try { return typeof window === 'undefined' ? null : window.sessionStorage; }
  catch { return null; }
}

// Store only a room id, never private room data. The authenticated server still
// authorizes every read and write; a remembered id is not proof of ownership.
export function readPerformerRoomSelection(
  identity: string | null,
  storage: RoomSelectionStorage | null = browserStorage()
): string | null {
  if (!identity || !storage) return null;
  try {
    const value = storage.getItem(`${PREFIX}${identity}`);
    if (value && ROOM_ID.test(value)) return value;
    if (value !== null) storage.removeItem(`${PREFIX}${identity}`);
  } catch { /* Unavailable browser storage must not prevent opening a room. */ }
  return null;
}

export function savePerformerRoomSelection(
  identity: string | null,
  roomId: string | null,
  storage: RoomSelectionStorage | null = browserStorage()
): void {
  if (!identity || !storage) return;
  try {
    const key = `${PREFIX}${identity}`;
    if (roomId && ROOM_ID.test(roomId)) storage.setItem(key, roomId);
    else storage.removeItem(key);
  } catch { /* Room actions still work when session storage is blocked or full. */ }
}
