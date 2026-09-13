import { createRoot } from 'react-dom/client';
import CollaboratorInbox from '../../src/components/CollaboratorInbox';
import '../../src/index.css';

createRoot(document.getElementById('root')!).render(<CollaboratorInbox embedded />);
