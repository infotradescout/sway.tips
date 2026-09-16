import { createContext } from 'react';
import type { ActiveRoomSummary, RequestItem } from './types';

export type SourcePlayerContextValue = {
  accountId: string | null;
  performerId: string | null;
  gigId: string | null;
  ready: boolean;
  previewMode: boolean;
  rooms: ActiveRoomSummary[];
  approvedRequests: RequestItem[];
  onSelectRoom?: (gigId: string | null) => void;
};

// The performer shell owns identity and room selection. Sources never uses the
// legacy global active-room id or starts a second account/room polling loop.
export const SourcePlayerContext = createContext<SourcePlayerContextValue | null>(null);
