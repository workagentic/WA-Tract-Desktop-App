import { createRoot } from 'react-dom/client';
import { PairingScreen } from './PairingScreen';
import { TaskPicker } from './TaskPicker';
import { TimerWidget } from './TimerWidget';
import './styles.css';

/**
 * Each BrowserWindow main.ts creates loads this same bundle with a different
 * URL hash (#/pairing, #/tasks, #/timer) — a lightweight router so a single
 * Vite renderer build serves all three screens/windows.
 */
function Router() {
  const route = window.location.hash.replace(/^#/, '') || '/pairing';

  if (route.startsWith('/tasks')) return <TaskPicker />;
  if (route.startsWith('/timer')) return <TimerWidget />;
  return <PairingScreen />;
}

const container = document.getElementById('root');
if (container) {
  createRoot(container).render(<Router />);
}
