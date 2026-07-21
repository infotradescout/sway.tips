/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { BadgeCheck, Lock, Plus, RefreshCw, Search, ShieldAlert, X } from 'lucide-react';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { StatusBanner } from '../components/TalentAuthStatus';

function claimCodeFromLink(claimLink: string) {
  try {
    return new URL(claimLink, 'https://app.sway.tips').searchParams.get('code')?.trim() || claimLink;
  } catch {
    return claimLink;
  }
}

type AdminAccountRole = 'patron' | 'performer' | 'admin' | 'support';

type AdminAccount = {
  id: string;
  email: string | null;
  displayName: string | null;
  role: AdminAccountRole;
  passwordSetupRequired: boolean;
  emailVerifiedAt: string | null;
  createdAt: string;
  performerId: string | null;
  handle: string | null;
  performerDisplayName: string | null;
  isActive: boolean | null;
  onboardingStatus: string | null;
  paymentAccountStatus: string | null;
  payoutsEnabled: boolean | null;
  chargesEnabled: boolean | null;
  payoutHoldReason: string | null;
  partnerKind: string | null;
  partnerEntitlementId: string | null;
  partnerTermsVersion: string | null;
  partnerTermsHash: string | null;
  partnerGrantedAt: string | null;
  partnerAcceptedAt: string | null;
  partnerStatus: string | null;
  partnerStatusReason: string | null;
};

const ONBOARDING_STATUSES = [
  'created',
  'profile_started',
  'gig_ready',
  'payments_limited',
  'verification_required',
  'verified',
  'payouts_enabled',
  'restricted',
  'suspended'
];

const ROLES: AdminAccountRole[] = ['patron', 'performer', 'admin', 'support'];

async function parseJsonResponse(response: Response) {
  return response.json().catch(() => null);
}

function inputClass() {
  return 'w-full rounded-xl border border-white/10 bg-slate-950 px-3 py-2 text-sm text-white outline-none transition focus:border-fuchsia-500 focus:ring-1 focus:ring-fuchsia-500';
}

function labelClass() {
  return 'text-[11px] font-semibold uppercase tracking-[0.2em] text-slate-400';
}

function CreateAccountPanel({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [email, setEmail] = useState('');
  const [handle, setHandle] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [isActive, setIsActive] = useState(true);
  const [isPartner, setIsPartner] = useState(false);
  const [partnerNote, setPartnerNote] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [claimLink, setClaimLink] = useState<string | null>(null);

  const hasEmail = email.trim().length > 0;

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    setClaimLink(null);

    try {
      if (hasEmail) {
        const response = await fetch('/api/admin/accounts/onboard', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, handle, displayName, isActive, isPartner, partnerNote })
        });
        const data = await parseJsonResponse(response);
        if (!response.ok) {
          throw new Error(typeof data?.error === 'string' ? data.error : 'Could not create account.');
        }
        onCreated();
        return;
      }

      // No email: create a bare performer slot and hand back a claim link instead --
      // no invitation email is sent (there's nothing to send it to). The artist
      // supplies their own email/password/phone when they redeem the link.
      const response = await fetch('/api/admin/performers/claim-link', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ handle, displayName })
      });
      const data = await parseJsonResponse(response);
      if (!response.ok) {
        throw new Error(typeof data?.error === 'string' ? data.error : 'Could not create account.');
      }
      setClaimLink(typeof data?.claimLink === 'string' ? data.claimLink : null);
      onCreated();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : 'Could not create account.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="rounded-2xl border border-white/10 bg-slate-900 p-5">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-black uppercase tracking-widest text-white">Manually onboard performer</h2>
        <button type="button" onClick={onClose} className="text-slate-400 hover:text-white">
          <X className="h-4 w-4" />
        </button>
      </div>

      {error ? <StatusBanner tone="rose" message={error} /> : null}
      {claimLink ? (
        <div className="mt-3 space-y-2">
          <div className="flex items-center gap-2 rounded-xl border border-cyan-400/30 bg-cyan-400/10 px-3 py-2">
            <code className="flex-1 break-all text-xs text-cyan-100">{claimCodeFromLink(claimLink)}</code>
            <button
              type="button"
              onClick={() => navigator.clipboard?.writeText(claimCodeFromLink(claimLink) || claimLink)}
              className="shrink-0 rounded-lg border border-cyan-300/30 px-2 py-1 text-[11px] font-bold text-cyan-100 hover:bg-cyan-400/10"
            >
              Copy code
            </button>
          </div>
          <p className="text-[11px] text-slate-500">They enter that code on Create account → I have a code.</p>
        </div>
      ) : null}

      <form className="mt-4 grid gap-3 sm:grid-cols-2" onSubmit={handleSubmit}>
        <div className="space-y-1">
          <label className={labelClass()}>Display name</label>
          <input className={inputClass()} value={displayName} onChange={(event) => setDisplayName(event.target.value)} required />
        </div>
        <div className="space-y-1">
          <label className={labelClass()}>Handle</label>
          <input className={inputClass()} value={handle} onChange={(event) => setHandle(event.target.value)} required />
        </div>
        <div className="space-y-1">
          <label className={labelClass()}>Email — optional</label>
          <input type="email" className={inputClass()} value={email} onChange={(event) => setEmail(event.target.value)} placeholder="Leave blank to generate a claim link instead" />
        </div>
        <div className="flex items-end gap-2 pb-2">
          <input id="create-active" type="checkbox" checked={isActive} onChange={(event) => setIsActive(event.target.checked)} className="h-4 w-4" />
          <label htmlFor="create-active" className="text-sm text-slate-300">Activate after owner setup</label>
        </div>
        <div className="sm:col-span-2 rounded-xl border border-cyan-300/20 bg-cyan-300/5 p-4 text-xs leading-5 text-cyan-100/80">
          {hasEmail
            ? 'Sway sends a one-time invitation to the owner. The owner chooses the password and accepts account terms; administrators never receive or set either one.'
            : 'No email is sent. You’ll get a one-time code to hand to the artist — they enter it on Create account, set email/password, and take the prepared profile.'}
        </div>

        <div className="sm:col-span-2 rounded-xl border border-amber-300/20 bg-amber-300/5 p-4">
          <label className={`flex min-h-11 items-center gap-3 text-sm font-bold text-amber-100 ${hasEmail ? 'cursor-pointer' : 'cursor-not-allowed opacity-50'}`}>
            <input type="checkbox" checked={isPartner} disabled={!hasEmail} onChange={(event) => setIsPartner(event.target.checked)} className="h-5 w-5" />
            Grant Sway Brand Partner status
          </label>
          <p className="mt-2 text-xs leading-5 text-amber-100/70">
            {hasEmail
              ? 'This is an append-only grandfather grant. It preserves the Sway-controlled pricing documented in the current Brand Partner terms and cannot be removed through routine account editing.'
              : 'Not available on the claim-link path yet — add an email above to grant Brand Partner status at creation, or grant it after the artist claims their account.'}
          </p>
          {isPartner && hasEmail ? (
            <label className="mt-3 block space-y-1">
              <span className={labelClass()}>Internal partner note — optional</span>
              <input className={inputClass()} maxLength={280} value={partnerNote} onChange={(event) => setPartnerNote(event.target.value)} placeholder="Influencer, strategic partnership, or relationship context" />
            </label>
          ) : null}
        </div>

        <div className="sm:col-span-2">
          <button
            type="submit"
            disabled={submitting}
            className="inline-flex min-h-10 items-center justify-center rounded-xl bg-fuchsia-600 px-5 py-2 text-sm font-black text-white transition hover:bg-fuchsia-500 disabled:cursor-not-allowed disabled:opacity-70"
          >
            {submitting ? 'Creating...' : hasEmail ? 'Create account and send owner invitation' : 'Create account and generate claim link'}
          </button>
        </div>
      </form>
    </div>
  );
}

function EditAccountPanel({
  account,
  onClose,
  onSaved
}: {
  account: AdminAccount;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [email, setEmail] = useState(account.email ?? '');
  const [displayName, setDisplayName] = useState(account.displayName ?? '');
  const [role, setRole] = useState<AdminAccountRole>(account.role);
  const [emailVerified, setEmailVerified] = useState(Boolean(account.emailVerifiedAt));
  const [handle, setHandle] = useState(account.handle ?? '');
  const [isActive, setIsActive] = useState(Boolean(account.isActive));
  const [onboardingStatus, setOnboardingStatus] = useState(account.onboardingStatus ?? 'created');
  const [payoutHoldReason, setPayoutHoldReason] = useState(account.payoutHoldReason ?? '');
  const [isPartner, setIsPartner] = useState(Boolean(account.partnerTermsVersion));
  const [partnerNote, setPartnerNote] = useState('');
  const [partnerSuspended, setPartnerSuspended] = useState(account.partnerStatus === 'suspended');
  const [partnerStatusReason, setPartnerStatusReason] = useState(account.partnerStatusReason ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const [resettingPassword, setResettingPassword] = useState(false);
  const [resetError, setResetError] = useState<string | null>(null);
  const [resetMessage, setResetMessage] = useState<string | null>(null);

  const [generatingClaimLink, setGeneratingClaimLink] = useState(false);
  const [claimLinkError, setClaimLinkError] = useState<string | null>(null);
  const [claimLink, setClaimLink] = useState<string | null>(null);

  const [deleteConfirmText, setDeleteConfirmText] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleted, setDeleted] = useState(false);
  const deleteConfirmTarget = account.email ?? account.handle ?? account.id;

  const handleSave = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    setError(null);
    setMessage(null);

    const body: Record<string, unknown> = {
      email,
      displayName,
      role,
      emailVerified
    };
    if (account.performerId) {
      body.handle = handle;
      body.isActive = isActive;
      body.onboardingStatus = onboardingStatus;
      body.payoutHoldReason = payoutHoldReason;
      body.isPartner = isPartner;
      if (!account.partnerTermsVersion && isPartner) body.partnerNote = partnerNote;
      if (account.partnerTermsVersion) {
        body.partnerSuspended = partnerSuspended;
        body.partnerStatusReason = partnerStatusReason;
      }
    }

    try {
      const response = await fetch(`/api/admin/accounts/${account.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      const data = await parseJsonResponse(response);
      if (!response.ok) {
        throw new Error(typeof data?.error === 'string' ? data.error : 'Could not save account.');
      }
      setMessage('Saved.');
      onSaved();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Could not save account.');
    } finally {
      setSaving(false);
    }
  };

  const handleSendOwnerAccessLink = async () => {
    if (resettingPassword) return;
    setResettingPassword(true);
    setResetError(null);
    setResetMessage(null);

    try {
      const endpoint = account.passwordSetupRequired
        ? `/api/admin/accounts/${account.id}/invite`
        : `/api/admin/accounts/${account.id}/reset-password`;
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(account.passwordSetupRequired
          ? { activateAfterSetup: true, onboardingStatus: 'gig_ready' }
          : {})
      });
      const data = await parseJsonResponse(response);
      if (!response.ok) {
        throw new Error(typeof data?.error === 'string' ? data.error : 'Could not send the owner access link.');
      }
      setResetMessage(account.passwordSetupRequired
        ? 'One-time setup invitation sent to the owner.'
        : 'One-time password reset link sent to the owner. The existing password is unchanged until the owner uses it.');
    } catch (resetErr) {
      setResetError(resetErr instanceof Error ? resetErr.message : 'Could not send the owner access link.');
    } finally {
      setResettingPassword(false);
    }
  };

  const handleGenerateClaimLink = async () => {
    if (generatingClaimLink || !account.performerId) return;
    setGeneratingClaimLink(true);
    setClaimLinkError(null);
    setClaimLink(null);

    try {
      const response = await fetch('/api/admin/performers/claim-link', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ performerId: account.performerId })
      });
      const data = await parseJsonResponse(response);
      if (!response.ok) {
        throw new Error(typeof data?.error === 'string' ? data.error : 'Could not generate a claim link.');
      }
      setClaimLink(typeof data?.claimLink === 'string' ? data.claimLink : null);
    } catch (claimErr) {
      setClaimLinkError(claimErr instanceof Error ? claimErr.message : 'Could not generate a claim link.');
    } finally {
      setGeneratingClaimLink(false);
    }
  };

  const handleDelete = async () => {
    if (deleting || deleteConfirmText !== deleteConfirmTarget) return;
    setDeleting(true);
    setDeleteError(null);

    try {
      const response = await fetch(`/api/admin/accounts/${account.id}`, { method: 'DELETE' });
      const data = await parseJsonResponse(response);
      if (!response.ok) {
        throw new Error(typeof data?.error === 'string' ? data.error : 'Could not delete account.');
      }
      setDeleted(true);
      onSaved();
    } catch (deleteErr) {
      setDeleteError(deleteErr instanceof Error ? deleteErr.message : 'Could not delete account.');
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="rounded-2xl border border-white/10 bg-slate-900 p-5">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-black uppercase tracking-widest text-white">Edit account</h2>
        <button type="button" onClick={onClose} className="text-slate-400 hover:text-white">
          <X className="h-4 w-4" />
        </button>
      </div>

      {error ? <StatusBanner tone="rose" message={error} /> : null}
      {message ? <StatusBanner tone="emerald" message={message} /> : null}

      <form className="mt-4 grid gap-3 sm:grid-cols-2" onSubmit={handleSave}>
        <div className="space-y-1">
          <label className={labelClass()}>Display name</label>
          <input className={inputClass()} value={displayName} onChange={(event) => setDisplayName(event.target.value)} required />
        </div>
        <div className="space-y-1">
          <label className={labelClass()}>Email</label>
          <input type="email" className={inputClass()} value={email} onChange={(event) => setEmail(event.target.value)} required />
        </div>
        <div className="space-y-1">
          <label className={labelClass()}>Role</label>
          <select className={inputClass()} value={role} onChange={(event) => setRole(event.target.value as AdminAccountRole)}>
            {ROLES.map((roleOption) => (
              <option key={roleOption} value={roleOption}>{roleOption}</option>
            ))}
          </select>
        </div>
        <div className="flex items-end gap-2 pb-2">
          <input id="edit-verified" type="checkbox" checked={emailVerified} onChange={(event) => setEmailVerified(event.target.checked)} className="h-4 w-4" />
          <label htmlFor="edit-verified" className="text-sm text-slate-300">Email verified</label>
        </div>

        {account.performerId ? (
          <>
            <div className="space-y-1">
              <label className={labelClass()}>Handle</label>
              <input className={inputClass()} value={handle} onChange={(event) => setHandle(event.target.value)} />
            </div>
            <div className="flex items-end gap-2 pb-2">
              <input id="edit-active" type="checkbox" checked={isActive} onChange={(event) => setIsActive(event.target.checked)} className="h-4 w-4" />
              <label htmlFor="edit-active" className="text-sm text-slate-300">Performer active</label>
            </div>
            <div className="space-y-1">
              <label className={labelClass()}>Onboarding status</label>
              <select className={inputClass()} value={onboardingStatus} onChange={(event) => setOnboardingStatus(event.target.value)}>
                {ONBOARDING_STATUSES.map((status) => (
                  <option key={status} value={status}>{status}</option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <label className={labelClass()}>Payout hold reason</label>
              <input
                className={inputClass()}
                value={payoutHoldReason}
                onChange={(event) => setPayoutHoldReason(event.target.value)}
                placeholder="Leave blank to clear"
              />
            </div>
            <div className="sm:col-span-2 rounded-xl border border-amber-500/20 bg-amber-500/5 p-3 text-xs text-amber-200">
              Payment/Stripe status (charges, payouts, KYC) is driven by Stripe and is intentionally not editable here to avoid drifting from the real account state.
            </div>
            <div className="sm:col-span-2 rounded-xl border border-amber-300/20 bg-amber-300/5 p-4">
              <label className={`flex min-h-11 items-center gap-3 text-sm font-bold text-amber-100 ${account.partnerTermsVersion ? 'cursor-default' : 'cursor-pointer'}`}>
                <input
                  type="checkbox"
                  checked={isPartner}
                  disabled={Boolean(account.partnerTermsVersion)}
                  onChange={(event) => setIsPartner(event.target.checked)}
                  className="h-5 w-5"
                />
                Sway Brand Partner
              </label>
              {account.partnerTermsVersion ? (
                <div className="mt-2 space-y-3 text-xs leading-5 text-amber-100/70">
                  <p>
                    Grant recorded under terms {account.partnerTermsVersion}. This append-only grant cannot be removed here.
                  </p>
                  <p>
                    Owner acceptance: {account.partnerAcceptedAt ? `recorded ${new Date(account.partnerAcceptedAt).toLocaleString()}` : 'pending — an administrator cannot accept for the owner'}.
                  </p>
                  <label className="flex min-h-11 items-center gap-3 rounded-xl border border-white/10 bg-slate-950/60 px-3 py-2 text-amber-100">
                    <input
                      type="checkbox"
                      checked={partnerSuspended}
                      onChange={(event) => setPartnerSuspended(event.target.checked)}
                      className="h-4 w-4"
                    />
                    Operationally suspend partner benefits without deleting history
                  </label>
                  {partnerSuspended !== (account.partnerStatus === 'suspended') ? (
                    <label className="block space-y-1">
                      <span className={labelClass()}>Status-event reason — optional</span>
                      <input className={inputClass()} maxLength={280} value={partnerStatusReason} onChange={(event) => setPartnerStatusReason(event.target.value)} />
                    </label>
                  ) : null}
                </div>
              ) : (
                <>
                  <p className="mt-2 text-xs leading-5 text-amber-100/70">
                    Granting creates an append-only offer. The authenticated performer owner must review and accept the exact version and hash before the pricing entitlement becomes effective.
                  </p>
                  {isPartner ? (
                    <label className="mt-3 block space-y-1">
                      <span className={labelClass()}>Internal partner note — optional</span>
                      <input className={inputClass()} maxLength={280} value={partnerNote} onChange={(event) => setPartnerNote(event.target.value)} />
                    </label>
                  ) : null}
                </>
              )}
            </div>
          </>
        ) : null}

        <div className="sm:col-span-2">
          <button
            type="submit"
            disabled={saving}
            className="inline-flex min-h-10 items-center justify-center rounded-xl bg-fuchsia-600 px-5 py-2 text-sm font-black text-white transition hover:bg-fuchsia-500 disabled:cursor-not-allowed disabled:opacity-70"
          >
            {saving ? 'Saving...' : 'Save changes'}
          </button>
        </div>
      </form>

      <div className="mt-5 rounded-xl border border-white/10 bg-slate-950/70 p-4">
        <div className="flex items-center gap-2 text-sm font-bold text-white">
          <ShieldAlert className="h-4 w-4 text-fuchsia-300" />
          Owner-controlled account access
        </div>
        <p className="mt-2 text-xs leading-5 text-slate-400">
          {account.passwordSetupRequired
            ? 'Send a fresh one-time setup invitation. The owner chooses the password and accepts account terms.'
            : 'Send a one-time password reset link. Administrators never see or choose the replacement password.'}
        </p>
        {resetError ? <StatusBanner tone="rose" message={resetError} /> : null}
        {resetMessage ? <StatusBanner tone="emerald" message={resetMessage} /> : null}
        <button
          type="button"
          onClick={handleSendOwnerAccessLink}
          disabled={resettingPassword}
          className="mt-3 inline-flex min-h-10 items-center justify-center rounded-xl border border-fuchsia-500/30 bg-fuchsia-500/10 px-5 py-2 text-sm font-black text-fuchsia-100 transition hover:bg-fuchsia-500/20 disabled:cursor-not-allowed disabled:opacity-70"
        >
          {resettingPassword ? 'Sending...' : account.passwordSetupRequired ? 'Resend owner setup invitation' : 'Send owner password reset link'}
        </button>
      </div>

      {account.performerId ? (
        <div className="mt-5 rounded-xl border border-white/10 bg-slate-950/70 p-4">
          <div className="flex items-center gap-2 text-sm font-bold text-white">
            <ShieldAlert className="h-4 w-4 text-cyan-300" />
            Claim code
          </div>
          <p className="mt-2 text-xs leading-5 text-slate-400">
            Generate a one-time code and send it to the artist. They open Create account, choose I have a code,
            enter the code, set email/password, and take over this profile — no handle onboarding.
          </p>
          {claimLinkError ? <StatusBanner tone="rose" message={claimLinkError} /> : null}
          {claimLink ? (
            <div className="mt-3 space-y-2">
              <div className="flex items-center gap-2 rounded-xl border border-cyan-400/30 bg-cyan-400/10 px-3 py-2">
                <code className="flex-1 break-all text-xs text-cyan-100">{claimCodeFromLink(claimLink)}</code>
                <button
                  type="button"
                  onClick={() => navigator.clipboard?.writeText(claimCodeFromLink(claimLink) || claimLink)}
                  className="shrink-0 rounded-lg border border-cyan-300/30 px-2 py-1 text-[11px] font-bold text-cyan-100 hover:bg-cyan-400/10"
                >
                  Copy code
                </button>
              </div>
            </div>
          ) : null}
          <button
            type="button"
            onClick={handleGenerateClaimLink}
            disabled={generatingClaimLink}
            className="mt-3 inline-flex min-h-10 items-center justify-center rounded-xl border border-cyan-400/30 bg-cyan-400/10 px-5 py-2 text-sm font-black text-cyan-100 transition hover:bg-cyan-400/20 disabled:cursor-not-allowed disabled:opacity-70"
          >
            {generatingClaimLink ? 'Generating...' : claimLink ? 'Generate a new code' : 'Generate code'}
          </button>
        </div>
      ) : null}

      <div className="mt-5 rounded-xl border border-rose-500/30 bg-rose-950/20 p-4">
        <div className="flex items-center gap-2 text-sm font-bold text-rose-200">
          <ShieldAlert className="h-4 w-4" />
          Delete account
        </div>
        <p className="mt-2 text-xs leading-relaxed text-rose-100/80">
          This scrubs email, name, and password and deactivates the profile — it does not erase payment, gig, or audit history
          (Sway&apos;s privacy policy commits to retaining those). The account can no longer log in and is removed from normal search.
        </p>
        {deleteError ? <StatusBanner tone="rose" message={deleteError} /> : null}
        {deleted ? (
          <StatusBanner tone="emerald" message="Account deleted." />
        ) : (
          <div className="mt-3 space-y-2">
            <label className={labelClass()}>
              Type <span className="font-mono text-rose-200">{deleteConfirmTarget}</span> to confirm
            </label>
            <input
              className={inputClass()}
              value={deleteConfirmText}
              onChange={(event) => setDeleteConfirmText(event.target.value)}
              placeholder={deleteConfirmTarget}
            />
            <button
              type="button"
              onClick={handleDelete}
              disabled={deleting || deleteConfirmText !== deleteConfirmTarget}
              className="inline-flex min-h-10 w-full items-center justify-center rounded-xl bg-rose-600 px-5 py-2 text-sm font-black text-white transition hover:bg-rose-500 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {deleting ? 'Deleting...' : 'Delete this account'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

export default function AdminAccountsPage() {
  const [accounts, setAccounts] = useState<AdminAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [isLocked, setIsLocked] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [roleFilter, setRoleFilter] = useState<AdminAccountRole | ''>('');
  const [creating, setCreating] = useState(false);
  const [editingAccount, setEditingAccount] = useState<AdminAccount | null>(null);

  const fetchAccounts = useCallback(async () => {
    setLoading(true);
    setLoadError(null);

    try {
      const params = new URLSearchParams();
      if (query.trim()) params.set('q', query.trim());
      if (roleFilter) params.set('role', roleFilter);

      const response = await fetch(`/api/admin/accounts?${params.toString()}`);
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          setIsLocked(true);
          return;
        }
        throw new Error('Unable to load accounts.');
      }

      const data = await parseJsonResponse(response);
      setAccounts(Array.isArray(data?.accounts) ? data.accounts : []);
      setIsLocked(false);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : 'Unable to load accounts.');
    } finally {
      setLoading(false);
    }
  }, [query, roleFilter]);

  useEffect(() => {
    void fetchAccounts();
  }, [fetchAccounts]);

  if (isLocked) {
    return (
      <div className="min-h-screen bg-slate-950 text-slate-100 flex items-center justify-center px-4">
        <div className="w-full max-w-md rounded-2xl border border-white/10 bg-slate-900 p-6 shadow-2xl text-center">
          <div className="mx-auto mb-4 flex h-11 w-11 items-center justify-center rounded-xl border border-fuchsia-500/25 bg-fuchsia-500/10 text-fuchsia-300">
            <Lock className="h-5 w-5" />
          </div>
          <h1 className="font-display text-xl font-black uppercase tracking-wide text-white">Session needed</h1>
          <p className="mt-2 text-sm leading-6 text-slate-400">
            Sign in as an admin to manage accounts. <a className="font-bold text-fuchsia-300 hover:text-fuchsia-200" href="/admin/login">Sign in</a>
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 px-4 py-8">
      <div className="mx-auto max-w-6xl">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-[10px] font-black uppercase tracking-[0.3em] text-fuchsia-300">Sway Admin</p>
            <h1 className="mt-1 font-display text-2xl font-black tracking-tight text-white">Accounts</h1>
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => void fetchAccounts()}
              className="inline-flex min-h-10 items-center gap-2 rounded-xl border border-white/10 bg-slate-900 px-4 py-2 text-xs font-black uppercase tracking-wide text-slate-200 transition hover:bg-slate-800"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              Refresh
            </button>
            <button
              type="button"
              onClick={() => {
                setEditingAccount(null);
                setCreating((current) => !current);
              }}
              className="inline-flex min-h-10 items-center gap-2 rounded-xl bg-fuchsia-600 px-4 py-2 text-xs font-black uppercase tracking-wide text-white transition hover:bg-fuchsia-500"
            >
              <Plus className="h-3.5 w-3.5" />
              Onboard performer
            </button>
          </div>
        </div>

        <div className="mt-5 flex flex-wrap items-center gap-3">
          <div className="relative flex-1 min-w-[220px]">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search email, handle, or name"
              className="w-full rounded-xl border border-white/10 bg-slate-900 py-2 pl-9 pr-3 text-sm text-white outline-none transition focus:border-fuchsia-500 focus:ring-1 focus:ring-fuchsia-500"
            />
          </div>
          <select
            value={roleFilter}
            onChange={(event) => setRoleFilter(event.target.value as AdminAccountRole | '')}
            className="rounded-xl border border-white/10 bg-slate-900 px-3 py-2 text-sm text-white outline-none"
          >
            <option value="">All roles</option>
            {ROLES.map((roleOption) => (
              <option key={roleOption} value={roleOption}>{roleOption}</option>
            ))}
          </select>
        </div>

        {loadError ? <StatusBanner tone="rose" message={loadError} /> : null}

        {creating ? (
          <div className="mt-5">
            <CreateAccountPanel
              onClose={() => setCreating(false)}
              onCreated={() => {
                setCreating(false);
                void fetchAccounts();
              }}
            />
          </div>
        ) : null}

        {editingAccount ? (
          <div className="mt-5">
            <EditAccountPanel
              account={editingAccount}
              onClose={() => setEditingAccount(null)}
              onSaved={() => void fetchAccounts()}
            />
          </div>
        ) : null}

        <div className="mt-5 overflow-x-auto rounded-2xl border border-white/10 bg-slate-900">
          <table className="w-full min-w-[860px] text-left text-sm">
            <thead>
              <tr className="border-b border-white/10 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                <th className="px-4 py-3">Account</th>
                <th className="px-4 py-3">Role</th>
                <th className="px-4 py-3">Handle</th>
                <th className="px-4 py-3">Verified</th>
                <th className="px-4 py-3">Active</th>
                <th className="px-4 py-3">Brand partner</th>
                <th className="px-4 py-3">Payment status</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={8} className="px-4 py-6 text-center text-slate-400">Loading accounts...</td>
                </tr>
              ) : accounts.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-4 py-6 text-center text-slate-400">No accounts match this search.</td>
                </tr>
              ) : (
                accounts.map((account) => (
                  <tr key={account.id} className="border-b border-white/5 last:border-b-0">
                    <td className="px-4 py-3">
                      <div className="font-semibold text-white">{account.displayName || '—'}</div>
                      <div className="text-xs text-slate-400">{account.email || '—'}</div>
                    </td>
                    <td className="px-4 py-3 text-slate-300">{account.role}</td>
                    <td className="px-4 py-3 text-slate-300">{account.handle || '—'}</td>
                    <td className="px-4 py-3 text-slate-300">{account.emailVerifiedAt ? 'Yes' : 'No'}</td>
                    <td className="px-4 py-3 text-slate-300">{account.performerId ? (account.isActive ? 'Yes' : 'No') : '—'}</td>
                    <td className="px-4 py-3 text-slate-300">
                      {account.partnerTermsVersion ? (
                        <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-300/20 bg-amber-300/10 px-2.5 py-1 text-[10px] font-black uppercase tracking-wide text-amber-100">
                          <BadgeCheck className="h-3.5 w-3.5" /> {account.partnerStatus === 'suspended' ? 'Suspended' : account.partnerAcceptedAt ? 'Brand' : 'Pending owner'}
                        </span>
                      ) : '—'}
                    </td>
                    <td className="px-4 py-3 text-slate-300">{account.paymentAccountStatus || '—'}</td>
                    <td className="px-4 py-3 text-right">
                      <button
                        type="button"
                        onClick={() => {
                          setCreating(false);
                          setEditingAccount(account);
                        }}
                        className="rounded-lg border border-white/10 bg-slate-950 px-3 py-1.5 text-xs font-bold text-fuchsia-200 transition hover:bg-slate-800"
                      >
                        Edit
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
