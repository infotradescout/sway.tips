/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { Lock } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { StatusBanner } from '../components/TalentAuthStatus';

type LoginStatus = 'idle' | 'submitting' | 'error';

export default function AdminLoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [status, setStatus] = useState<LoginStatus>('idle');
  const [message, setMessage] = useState<string | null>(null);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (status === 'submitting') return;

    setStatus('submitting');
    setMessage(null);

    try {
      const response = await fetch('/api/admin/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ email, password })
      });

      const data = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(typeof data?.error === 'string' ? data.error : 'Admin login failed.');
      }

      const redirectPath = typeof data?.redirectPath === 'string' ? data.redirectPath : '/admin';
      window.location.assign(redirectPath);
    } catch (error) {
      setStatus('error');
      setMessage(error instanceof Error ? error.message : 'We could not log you in right now.');
    }
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex items-center justify-center px-4 py-8">
      <div className="w-full max-w-md rounded-3xl border border-white/10 bg-slate-900 p-6 shadow-2xl">
        <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-2xl border border-fuchsia-500/25 bg-fuchsia-500/10 text-fuchsia-300">
          <Lock className="h-5 w-5" />
        </div>
        <p className="text-[10px] font-black uppercase tracking-[0.3em] text-fuchsia-300">Operator Access</p>
        <h1 className="mt-3 font-display text-3xl font-black tracking-tight text-white">Sign in to Sway Admin</h1>
        <p className="mt-3 text-sm leading-6 text-slate-300">
          Restricted to authorized admin and support accounts.
        </p>

        {message ? <StatusBanner tone="rose" message={message} /> : null}

        <form className="mt-6 space-y-4" onSubmit={handleSubmit}>
          <div className="space-y-1.5">
            <label className="text-xs font-semibold uppercase tracking-[0.24em] text-slate-400" htmlFor="admin-login-email">
              Email
            </label>
            <input
              id="admin-login-email"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="admin@example.com"
              required
              className="w-full rounded-2xl border border-white/10 bg-slate-950 px-4 py-3 text-sm text-white outline-none transition focus:border-fuchsia-500 focus:ring-1 focus:ring-fuchsia-500"
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-semibold uppercase tracking-[0.24em] text-slate-400" htmlFor="admin-login-password">
              Password
            </label>
            <input
              id="admin-login-password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="Enter your password"
              required
              className="w-full rounded-2xl border border-white/10 bg-slate-950 px-4 py-3 text-sm text-white outline-none transition focus:border-fuchsia-500 focus:ring-1 focus:ring-fuchsia-500"
            />
          </div>

          <button
            type="submit"
            disabled={status === 'submitting'}
            className="inline-flex min-h-12 w-full items-center justify-center rounded-2xl bg-fuchsia-600 px-5 py-3 text-sm font-black text-white transition hover:bg-fuchsia-500 disabled:cursor-not-allowed disabled:opacity-70"
          >
            {status === 'submitting' ? 'Signing you in...' : 'Sign in'}
          </button>
        </form>
      </div>
    </div>
  );
}
