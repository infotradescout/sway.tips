import type { LiveRoomType, RoomRequestMenuItem } from '../types';

const MAX_ROOM_MENU_ITEMS = 8;
const MAX_MENU_TITLE_LENGTH = 80;
const MAX_MENU_DESCRIPTION_LENGTH = 240;
const MAX_MENU_ID_LENGTH = 64;

const NON_MONEY_CLAIM_PATTERN = /(?:\$|\b(?:usd|dollars?|tip|paid|payment|charge|price|fee|buy|purchase)\b)/i;
const REGULATED_OFFER_PATTERN = /\b(?:alcohol|beer|wine|cocktail|liquor|shot|pint|vodka|whiske?y|tequila|rum)\b/i;
const UNSAFE_OFFER_PATTERN = /\b(?:fire|flame|weapon|knife|gun|dangerous|risky|risking|stunt|fight|injur(?:y|e|ing))\b|skip\s+the\s+line/i;

export class LiveRoomMenuPolicyError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'LiveRoomMenuPolicyError';
    this.code = code;
  }
}

function policyError(code: string, message: string): never {
  throw new LiveRoomMenuPolicyError(code, message);
}

function normalizeText(value: unknown, label: string, maxLength: number) {
  if (typeof value !== 'string') {
    policyError('invalid_room_menu_text', `${label} must be text.`);
  }
  const normalized = value.trim().replace(/\s+/g, ' ');
  if (!normalized) {
    policyError('invalid_room_menu_text', `${label} is required.`);
  }
  if (normalized.length > maxLength) {
    policyError('room_menu_text_too_long', `${label} must be ${maxLength} characters or fewer.`);
  }
  return normalized;
}

function normalizeMenuId(value: unknown, title: string, index: number) {
  const candidate = typeof value === 'string' ? value : `${title}-${index + 1}`;
  const normalized = candidate
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_MENU_ID_LENGTH);
  if (!normalized) {
    policyError('invalid_room_menu_id', 'Each room menu item needs a stable identifier.');
  }
  return normalized;
}

export function normalizeLiveRoomType(value: unknown): LiveRoomType {
  if (value === 'music' || value === 'comedy' || value === 'service' || value === 'general') {
    return value;
  }
  if (value === undefined || value === null || value === '') return 'music';
  return policyError('invalid_room_type', 'Room type must be music, comedy, service, or general.');
}

export function normalizeRoomRequestMenu(
  value: unknown,
  roomType: LiveRoomType
): RoomRequestMenuItem[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    return policyError('invalid_room_menu', 'Room request menu must be a list.');
  }
  if (value.length > MAX_ROOM_MENU_ITEMS) {
    return policyError('room_menu_too_large', `Room request menu may contain at most ${MAX_ROOM_MENU_ITEMS} items.`);
  }

  const ids = new Set<string>();
  return value.map((rawItem, index) => {
    if (!rawItem || typeof rawItem !== 'object' || Array.isArray(rawItem)) {
      return policyError('invalid_room_menu_item', 'Every room menu item must be an object.');
    }
    const item = rawItem as Record<string, unknown>;
    const title = normalizeText(item.title, `Menu item ${index + 1} title`, MAX_MENU_TITLE_LENGTH);
    const description = normalizeText(
      item.description,
      `Menu item ${index + 1} description`,
      MAX_MENU_DESCRIPTION_LENGTH
    );
    const combinedText = `${title} ${description}`;
    if (NON_MONEY_CLAIM_PATTERN.test(combinedText)) {
      return policyError(
        'room_menu_money_claim_not_allowed',
        'Room menu items in this release cannot advertise a price, payment, purchase, or tip.'
      );
    }
    if (REGULATED_OFFER_PATTERN.test(combinedText)) {
      return policyError(
        'room_menu_regulated_offer_not_allowed',
        'Room menu items cannot advertise alcohol or another regulated offer.'
      );
    }
    if (UNSAFE_OFFER_PATTERN.test(combinedText)) {
      return policyError(
        'room_menu_unsafe_offer_not_allowed',
        'Room menu items cannot advertise unsafe acts or line-skipping.'
      );
    }

    const id = normalizeMenuId(item.id, title, index);
    if (ids.has(id)) {
      return policyError('duplicate_room_menu_id', 'Room menu item identifiers must be unique.');
    }
    ids.add(id);

    const targetType = item.targetType === 'music' ? 'music' : 'custom';
    if (roomType !== 'music' && targetType !== 'custom') {
      return policyError(
        'room_menu_target_mismatch',
        'Comedy, service, and general room menu items must be custom requests.'
      );
    }
    return { id, title, description, targetType };
  });
}

export function resolveRoomRequestSelection(input: {
  roomType: LiveRoomType;
  requestMenu: RoomRequestMenuItem[];
  menuItemId: unknown;
  requestedTargetType: unknown;
}) {
  const requestedMenuItemId = typeof input.menuItemId === 'string' && input.menuItemId.trim()
    ? input.menuItemId.trim().toLowerCase()
    : null;
  const menuItem = requestedMenuItemId
    ? input.requestMenu.find((item) => item.id === requestedMenuItemId) ?? null
    : null;

  if (requestedMenuItemId && !menuItem) {
    return policyError(
      'room_menu_item_not_available',
      'That request menu item is not available in this room.'
    );
  }
  if (input.roomType !== 'music' && input.requestedTargetType !== 'custom') {
    return policyError('room_request_target_mismatch', 'This room accepts custom requests only.');
  }

  return {
    menuItem,
    targetType: menuItem?.targetType
      ?? (input.roomType === 'music' && input.requestedTargetType === 'music' ? 'music' : 'custom')
  } as const;
}

export const LIVE_ROOM_MENU_LIMITS = Object.freeze({
  maxItems: MAX_ROOM_MENU_ITEMS,
  maxTitleLength: MAX_MENU_TITLE_LENGTH,
  maxDescriptionLength: MAX_MENU_DESCRIPTION_LENGTH
});
