export const PROFESSIONAL_IDENTITY_OPTIONS = [
  { id: 'comedian', label: 'Comedian' },
  { id: 'singer', label: 'Singer' },
  { id: 'songwriter', label: 'Songwriter' },
  { id: 'dj', label: 'DJ' },
  { id: 'musician', label: 'Musician' },
  { id: 'band', label: 'Band' },
  { id: 'producer', label: 'Producer' },
  { id: 'host', label: 'Host / MC' },
  { id: 'emcee', label: 'Emcee' },
  { id: 'bartender', label: 'Bartender' },
  { id: 'dancer', label: 'Dancer' },
  { id: 'actor', label: 'Actor' },
  { id: 'speaker', label: 'Speaker' },
  { id: 'podcaster', label: 'Podcaster' },
  { id: 'magician', label: 'Magician' },
  { id: 'event_professional', label: 'Event professional' },
  { id: 'vendor', label: 'Vendor' },
  { id: 'service_professional', label: 'Service professional' },
  { id: 'creator', label: 'Creator' },
  { id: 'other', label: 'Other' }
] as const;

export type ProfessionalIdentityKind = typeof PROFESSIONAL_IDENTITY_OPTIONS[number]['id'];

export const PERFORMER_EARNING_MODE_OPTIONS = [
  { id: 'live_tips', label: 'Live tips' },
  { id: 'audience_requests', label: 'Audience requests' },
  { id: 'bookings', label: 'Bookings' },
  { id: 'partnerships', label: 'Partnerships' },
  { id: 'services', label: 'Services' },
  { id: 'releases', label: 'Releases' },
  { id: 'events', label: 'Events' },
  { id: 'ticket_sales', label: 'Ticket sales' },
  { id: 'audio_sales', label: 'Audio sales' },
  { id: 'sponsorships', label: 'Sponsorships' },
  { id: 'merchandise', label: 'Merchandise' }
] as const;

export type PerformerEarningMode = typeof PERFORMER_EARNING_MODE_OPTIONS[number]['id'];

export const PERFORMER_CAPABILITY_OPTIONS = [
  { id: 'profile_publication', label: 'Publish my profile', gateNote: 'Requires a complete, eligible profile and a separate visibility choice.' },
  { id: 'public_discovery', label: 'Appear in discovery', gateNote: 'Requires explicit publication plus search and policy eligibility.' },
  { id: 'non_money_inquiries', label: 'Receive inquiries', gateNote: 'Request only. Inquiry and abuse-control gates still apply.' },
  { id: 'live_rooms', label: 'Run Live Rooms', gateNote: 'Requires an owned active room and current server authorization.' },
  { id: 'live_money', label: 'Receive live money', gateNote: 'Does not enable money. KYC, payout, payment, and release gates remain separate.' },
  { id: 'event_publication', label: 'Publish events', gateNote: 'Requires organizer or venue authority and moderation eligibility.' },
  { id: 'external_ticket_links', label: 'Share external ticket links', gateNote: 'External links are not Sway ticket sales.' },
  { id: 'native_ticket_sales', label: 'Sell native tickets', gateNote: 'Does not enable ticket sales. Inventory, payment, refund, and reconciliation gates remain separate.' },
  { id: 'private_collaboration', label: 'Collaborate privately', gateNote: 'Private grants remain project- and file-scoped.' },
  { id: 'release_preparation', label: 'Prepare releases', gateNote: 'Working storage remains bounded; validated release count is not capped.' },
  { id: 'audio_publication', label: 'Publish audio', gateNote: 'Rights, moderation, durable media, and publication evidence are required.' },
  { id: 'audio_sales', label: 'Sell audio', gateNote: 'Request only. Audio sales are not live.' },
  { id: 'dsp_delivery', label: 'Deliver to music services', gateNote: 'Request only. Provider-backed delivery is not live.' },
  { id: 'royalty_processing', label: 'Process royalties', gateNote: 'Request only. Legal, accounting, split, and payout gates are required.' },
  { id: 'partnership_inquiries', label: 'Receive partnership inquiries', gateNote: 'Interest is not a completed or guaranteed deal.' },
  { id: 'service_inquiries', label: 'Receive service inquiries', gateNote: 'Interest is not a completed or guaranteed booking.' }
] as const;

export type PerformerCapability = typeof PERFORMER_CAPABILITY_OPTIONS[number]['id'];

export const PROFESSIONAL_IDENTITY_KINDS = PROFESSIONAL_IDENTITY_OPTIONS.map((option) => option.id);
export const PERFORMER_EARNING_MODES = PERFORMER_EARNING_MODE_OPTIONS.map((option) => option.id);
export const PERFORMER_CAPABILITIES = PERFORMER_CAPABILITY_OPTIONS.map((option) => option.id);

export function professionalIdentityLabel(kind: ProfessionalIdentityKind, customLabel?: string | null) {
  if (kind === 'other' && customLabel?.trim()) return customLabel.trim();
  return PROFESSIONAL_IDENTITY_OPTIONS.find((option) => option.id === kind)?.label ?? 'Professional';
}
