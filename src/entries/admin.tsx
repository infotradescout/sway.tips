import AdminOpsShell from '../shells/AdminOpsShell';
import AdminLoginPage from '../shells/AdminLoginPage';
import AdminAccountsPage from '../shells/AdminAccountsPage';
import { mountSwayShell } from './mount';

if (window.location.pathname === '/admin/login') {
  mountSwayShell(<AdminLoginPage />);
} else if (window.location.pathname === '/admin/accounts') {
  mountSwayShell(<AdminAccountsPage />);
} else {
  mountSwayShell(<AdminOpsShell />);
}
