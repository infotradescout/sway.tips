import AdminOpsShell from '../shells/AdminOpsShell';
import { mountSwayShell } from './mount';

if (
  window.location.pathname === '/admin/login' ||
  window.location.pathname === '/admin/dashboard'
) {
  window.history.replaceState({}, '', '/admin');
}
mountSwayShell(<AdminOpsShell />);
