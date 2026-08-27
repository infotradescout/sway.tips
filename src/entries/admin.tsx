import AdminOpsShell from '../shells/AdminOpsShell';
import AdminLoginPage from '../shells/AdminLoginPage';
import AdminAccountsPage from '../shells/AdminAccountsPage';
import DiscoveryObservatoryPage from '../shells/DiscoveryObservatoryPage';
import AdminReleaseReportsPage from '../shells/AdminReleaseReportsPage';
import { mountSwayShell } from './mount';

if (window.location.pathname === '/admin/login') {
  mountSwayShell(<AdminLoginPage />);
} else if (window.location.pathname === '/admin/accounts') {
  mountSwayShell(<AdminAccountsPage />);
} else if (window.location.pathname === '/admin/discovery-observatory') {
  mountSwayShell(<DiscoveryObservatoryPage />);
} else if (window.location.pathname === '/admin/release-reports') {
  mountSwayShell(<AdminReleaseReportsPage />);
} else {
  mountSwayShell(<AdminOpsShell />);
}
