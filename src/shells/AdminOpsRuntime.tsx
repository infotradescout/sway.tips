import AdminApp from './AdminApp';
import { createAdminOpsRuntimeCompat } from './admin/AdminOpsRuntimeCompat';

export const LEGACY_RUNTIME_DELEGATE = createAdminOpsRuntimeCompat(AdminApp);

const AdminOpsRuntime = LEGACY_RUNTIME_DELEGATE;

export default AdminOpsRuntime;
