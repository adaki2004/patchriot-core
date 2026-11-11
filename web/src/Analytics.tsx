import { useState } from 'react';
import { useLive } from './useLive';

const key = 'patchriot.workspace-analytics-choice.v2';
type Choice = 'allow' | 'decline' | null;
const noPolling = () => false;
function savedChoice(): Choice {
  try {
    const saved = JSON.parse(localStorage.getItem(key) || 'null');
    return saved?.expires > Date.now() && ['allow', 'decline'].includes(saved.choice) ? saved.choice : null;
  } catch { return null; }
}

function isolatedOrigin(value?: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    const local = url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    return (url.protocol === 'https:' || local) && url.origin === value && url.hostname !== location.hostname ? value : null;
  } catch { return null; }
}

/** The frame receives only one of fixed workspace page names. Destroying it
 * removes third-party code on sign-out or public navigation; removing a script tag
 * from the application document would not unload that script's listeners. */
export function Analytics({ page }: { page: 'dashboard' | 'audits' | 'setup' | 'report' | 'account' | 'orders' | 'agents' | null }) {
  const config = useLive<{ enabled: boolean; frame_origin?: string | null }>('/analytics', page !== null, 60_000, noPolling);
  const [choice, setChoice] = useState<Choice>(savedChoice);
  const [settings, setSettings] = useState(false);
  function choose(value: Exclude<Choice, null>) {
    setChoice(value); setSettings(false);
    try { localStorage.setItem(key, JSON.stringify({ choice: value, expires: Date.now() + 180 * 86400000 })); } catch { /* A blocked store keeps this visit's choice only. */ }
  }
  const frameOrigin = isolatedOrigin(config.data?.frame_origin);
  if (!page || config.error || !config.data?.enabled || !frameOrigin) return null;
  return <>
    {choice === 'allow' && <iframe key={page} title="Optional workspace page counts" className="analytics-frame" src={frameOrigin + '/api/analytics/frame/' + page} sandbox="allow-scripts allow-same-origin" referrerPolicy="no-referrer" aria-hidden="true" tabIndex={-1} onLoad={event => event.currentTarget.contentWindow?.postMessage('patchriot-workspace-page-count-v1', frameOrigin)} />}
    <button className="quiet analytics-choice" onClick={() => setSettings(value => !value)}>Privacy choices</button>
    {(choice === null || settings) && <aside className="analytics-consent" aria-label="Optional analytics">
      <div><strong>Help us improve your workspace?</strong><p>Optional Google Analytics counts signed-in workspace screens. Google receives your IP and basic browser information. We send screen categories, never target URLs, account details, reports, coupon codes or payment values. Public pages are excluded. No analytics cookies are used.</p></div>
      <div className="analytics-actions"><button className="quiet" onClick={() => choose('decline')}>No thanks</button><button className="primary" onClick={() => choose('allow')}>Allow page counts</button></div>
    </aside>}
  </>;
}
