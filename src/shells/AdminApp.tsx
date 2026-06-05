import { Lock } from 'lucide-react';
import { ShellMessage } from './shared';

export default function AdminApp() {
  return (
    <ShellMessage
      icon={<Lock className="h-5 w-5" />}
      title="Admin"
      body="Admin tools are intentionally separated from patron and talent routes. Operator features remain unavailable until authentication, audit logs, and persistent ledgers are implemented."
    />
  );
}
