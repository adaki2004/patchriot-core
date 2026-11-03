import { useState } from 'react';
import { useLive } from './useLive';

const key = 'patchriot.analytics-choice.v1';
type Choice = 'allow' | 'decline' | null;
const noPolling = () => false;
function savedChoice(): Choice {
  try {
    const saved = JSON.parse(localStorage.getItem(key) || 'null');
    return saved?.expires > Date.now() && ['allow', 'decline'].includes(saved.choice) ? saved.choice : null;
  } catch { return null; }
}

/** The frame receives only one of three fixed public page names. Destroying it
 * removes third-party code before private navigation; removing a script tag
 * from the application document would not unload that script's listeners. */
export function Analytics({ page }: { page: 'home' | 'docs' | 'events' | null }) {
  const config = useLive<{ enabled: boolean }>('/analytics', page !== null, 60_000, noPolling);
  const [choice, setChoice] = useState<Choice>(savedChoice);
  const [settings, setSettings] = useState(false);
  function choose(value: Exclude<Choice, null>) {
    setChoice(value); setSettings(false);
    try { localStorage.setItem(key, JSON.stringify({ choice: value, expires: Date.now() + 180 * 86400000 })); } catch { /* A blocked store keeps this visit's choice only. */ }
  }
  if (!page || config.error || !config.data?.enabled) return null;
  return <>
    {choice === 'allow' && <iframe key={page} title="Optional public page counts" className="analytics-frame" src={`/api/analytics/frame/${page}`} sandbox="allow-scripts" referrerPolicy="no-referrer" aria-hidden="true" tabIndex={-1} onLoad={event => event.currentTarget.contentWindow?.postMessage('patchriot-public-page-count-v1', '*')} />}
    <button className="quiet analytics-choice" onClick={() => setSettings(value => !value)}>Privacy choices</button>
    {(choice === null || settings) && <aside className="analytics-consent" aria-label="Optional analytics">
      <div><strong>Help us understand public page visits?</strong><p>Optional Google Analytics counts the home, docs and events pages. Google receives your IP and basic browser information. Private work, sign-in and payment pages are excluded. No analytics cookies are used.</p></div>
      <div className="analytics-actions"><button className="quiet" onClick={() => choose('decline')}>No thanks</button><button className="primary" onClick={() => choose('allow')}>Allow page counts</button></div>
    </aside>}
  </>;
}
