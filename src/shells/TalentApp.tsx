import { Lock, Users } from 'lucide-react';
import { motion } from 'motion/react';
import TalentDashboard from '../components/TalentDashboard';
import VictoryScreen from '../components/VictoryScreen';
import { LoadingState, ShellMessage, postJson, useSwayState } from './shared';

function isTalentLogin(pathname: string) {
  return pathname === '/talent/login';
}

export default function TalentApp() {
  const { bState, isLoading, setBState } = useSwayState();

  const handleStartSession = async (setupData: {
    talentName: string;
    talentRole: 'DJ' | 'Bartender' | 'Performer';
    feeType: 'talent' | 'patron';
    minimumTip: number;
  }) => {
    try {
      const data = await postJson('/api/session/start', setupData);
      setBState(data.state);
    } catch (e) {
      console.error(e);
    }
  };

  const handleEndSession = async () => {
    try {
      const data = await postJson('/api/session/end');
      setBState(data.state);
    } catch (e) {
      console.error(e);
    }
  };

  const handleCloseout = async () => {
    try {
      const data = await postJson('/api/session/closeout');
      setBState(data.state);
    } catch (e) {
      console.error(e);
    }
  };

  const handleTriageRequest = async (requestId: string, action: 'approve' | 'deny') => {
    try {
      const data = await postJson('/api/request/triage', { requestId, action });
      setBState(data.state);
    } catch (e) {
      console.error(e);
    }
  };

  const handleFulfillRequest = async (requestId: string) => {
    try {
      const data = await postJson('/api/request/fulfill', { requestId });
      setBState(data.state);
    } catch (e) {
      console.error(e);
    }
  };

  const resetInactiveSession = () => {
    handleStartSession({
      talentName: 'Sway Performer',
      talentRole: 'DJ',
      feeType: 'patron',
      minimumTip: 5
    });
  };

  if (isTalentLogin(window.location.pathname)) {
    return (
      <ShellMessage
        icon={<Lock className="h-5 w-5" />}
        title="Talent Login"
        body="Account authentication is the next production milestone. This route is separated now so talent-only screens are no longer reachable through the patron surface."
        actions={
          <a className="rounded-xl bg-fuchsia-600 px-4 py-2 text-center text-sm font-bold text-white hover:bg-fuchsia-500" href="/talent/gigs">
            Continue to gigs
          </a>
        }
      />
    );
  }

  if (isLoading) return <LoadingState />;

  const { session, requests } = bState;

  if (session.status === 'closed') {
    return <VictoryScreen session={session} onRestart={resetInactiveSession} />;
  }

  return (
    <div className="min-h-screen flex flex-col bg-slate-950 text-slate-100">
      <div className="border-b border-white/10 bg-slate-900 px-4 py-3">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <div className="rounded bg-fuchsia-500/10 p-1 text-fuchsia-400">
              <Users className="h-4 w-4" />
            </div>
            <div>
              <span className="font-display text-xs font-black uppercase tracking-widest text-white">Sway Talent</span>
              <p className="text-[9px] text-slate-400">Gig setup, queue triage, fulfillment, and closeout</p>
            </div>
          </div>
        </div>
      </div>

      <main className="flex-1">
        <motion.div initial={{ opacity: 0, y: 15 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3 }}>
          <TalentDashboard
            session={session}
            requests={requests}
            onStartSession={handleStartSession}
            onEndSession={handleEndSession}
            onCloseout={handleCloseout}
            onTriage={handleTriageRequest}
            onFulfill={handleFulfillRequest}
          />
        </motion.div>
      </main>
    </div>
  );
}
