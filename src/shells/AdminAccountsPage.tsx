/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { Lock, Plus, RefreshCw, Search, ShieldAlert, X } from 'lucide-react';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { StatusBanner } from '../components/TalentAuthStatus';

type AdminAccountRole = 'patron' | 'performer' | 'admin' | 'support';

type AdminAccount = {
  id: string;
  email: string | null;
  displayName: string | null;
  role: AdminAccountRole;
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
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [isActive, setIsActive] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError(null);

    try {
      const response = await fetch('/api/admin/accounts/onboard', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, handle, displayName, password, confirmPassword, isActive })
      });
      const data = await parseJsonResponse(response);
      if (!response.ok) {
        throw new Error(typeof data?.error === 'string' ? data.error : 'Could not create account.');
      }
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
          <label className={labelClass()}>Email</label>
          <input type="email" className={inputClass()} value={email} onChange={(event) => setEmail(event.target.value)} required />
        </div>
        <div className="flex items-end gap-2 pb-2">
          <input id="create-active" type="checkbox" checked={isActive} onChange={(event) => setIsActive(event.target.checked)} className="h-4 w-4" />
          <label htmlFor="create-active" className="text-sm text-slate-300">Activate immediately</label>
        </div>
        <div className="space-y-1">
          <label className={labelClass()}>Temporary password</label>
          <input type="text" className={inputClass()} value={password} onChange={(event) => setPassword(event.target.value)} required />
        </div>
        <div className="space-y-1">
          <label className={labelClass()}>Confirm password</label>
          <input type="text" className={inputClass()} value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} required />
        </div>

        <div className="sm:col-span-2">
          <button
            type="submit"
            disabled={submitting}
            className="inline-flex min-h-10 items-center justify-center rounded-xl bg-fuchsia-600 px-5 py-2 text-sm font-black text-white transition hover:bg-fuchsia-500 disabled:cursor-not-allowed disabled:opacity-70"
          >
            {submitting ? 'Creating...' : 'Create account'}
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
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const [newPassword, setNewPassword] = useState('');
  const [confirmNewPassword, setConfirmNewPassword] = useState('');
  const [resettingPassword, setResettingPassword] = useState(false);
  const [resetError, setResetError] = useState<string | null>(null);
  const [resetMessage, setResetMessage] = useState<string | null>(null);

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

  const handleResetPassword = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (resettingPassword) return;
    setResettingPassword(true);
    setResetError(null);
    setResetMessage(null);

    try {
      const response = await fetch(`/api/admin/accounts/${account.id}/reset-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: newPassword, confirmPassword: confirmNewPassword })
      });
      const data = await parseJsonResponse(response);
      if (!response.ok) {
        throw new Error(typeof data?.error === 'string' ? data.error : 'Could not reset password.');
      }
      setResetMessage('Password reset. All existing sessions were signed out.');
      setNewPassword('');
      setConfirmNewPassword('');
    } catch (resetErr) {
      setResetError(resetErr instanceof Error ? resetErr.message : 'Could not reset password.');
    } finally {
      setResettingPassword(false);
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
          Reset password
        </div>
        {resetError ? <StatusBanner tone="rose" message={resetError} /> : null}
        {resetMessage ? <StatusBanner tone="emerald" message={resetMessage} /> : null}
        <form className="mt-3 grid gap-3 sm:grid-cols-2" onSubmit={handleResetPassword}>
          <div className="space-y-1">
            <label className={labelClass()}>New password</label>
            <input type="text" className={inputClass()} value={newPassword} onChange={(event) => setNewPassword(event.target.value)} required />
          </div>
          <div className="space-y-1">
            <label className={labelClass()}>Confirm new password</label>
            <input type="text" className={inputClass()} value={confirmNewPassword} onChange={(event) => setConfirmNewPassword(event.target.value)} required />
          </div>
          <div className="sm:col-span-2">
            <button
              type="submit"
              disabled={resettingPassword}
              className="inline-flex min-h-10 items-center justify-center rounded-xl border border-fuchsia-500/30 bg-fuchsia-500/10 px-5 py-2 text-sm font-black text-fuchsia-100 transition hover:bg-fuchsia-500/20 disabled:cursor-not-allowed disabled:opacity-70"
            >
              {resettingPassword ? 'Resetting...' : 'Reset password'}
            </button>
          </div>
        </form>
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
                <th className="px-4 py-3">Payment status</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={7} className="px-4 py-6 text-center text-slate-400">Loading accounts...</td>
                </tr>
              ) : accounts.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-6 text-center text-slate-400">No accounts match this search.</td>
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
