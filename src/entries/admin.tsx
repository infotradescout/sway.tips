import AdminOpsShell from '../shells/AdminOpsShell';
import AdminLoginPage from '../shells/AdminLoginPage';
import { mountSwayShell } from './mount';

if (window.location.pathname === '/admin/login') {
  mountSwayShell(<AdminLoginPage />);
} else {
  mountSwayShell(<AdminOpsShell />);
}
