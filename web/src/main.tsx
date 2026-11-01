import { StrictMode, useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { api, write, sessionChanged, sessionExpiredEvent, SessionExpiredError, SessionChangedError } from './api';
import type { Account, Device, Fleet, Session } from './api';
import './style.css';
import { useLive } from './useLive';
import { useDialog } from './useDialog';
import { Reviews } from './Reviews';
import { Orders } from './Orders';
import { PaymentDesk } from './PaymentDesk';
import { Sites } from './Sites';
import type { Deposit } from './Checkout';
import { IncidentDesk, IncidentLog } from './Incidents';
import { useNavigation } from './navigation';
import type { View } from './navigation';
import { Login, RequestAccess, AccessDesk } from './Access';

function Mark() {
  return <svg viewBox="0 0 32 36" aria-hidden="true"><path d="M3 3h26v17L16 33 3 20V3Z" fill="none" stroke="currentColor" strokeWidth="3" /><path d="m10 19 5-9h7l-5 7h6L12 28l3-9h-5Z" fill="currentColor" /></svg>;
}

function Notice({ children, error = false }: { children: ReactNode; error?: boolean }) {
  return <div className={`notice ${error ? 'error' : ''}`} role={error ? 'alert' : 'status'}>{children}</div>;
}

function Pair({ account, csrf, onPaired, onClose }: { account: Account; csrf: string; onPaired: () => void; onClose: () => void }) {
  const dialog = useDialog('input[name="code"]');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(''); setBusy(true);
    const values = new FormData(event.currentTarget);
    try {
      await write('/pairings/claim', csrf, {
        user_code: String(values.get('code')).trim(), display_name: String(values.get('name')).trim(),
        hosting: values.get('hosting'), accepts_private_work_rules: values.get('rules') === 'on',
      });
      onPaired(); onClose();
    } catch (error) { setError((error as Error).message); } finally { setBusy(false); }
  }
  return <dialog ref={dialog} onCancel={event => { if (busy) event.preventDefault(); else onClose(); }} aria-labelledby="pair-title">
    <button className="close" onClick={onClose} disabled={busy} aria-label="Close pairing">×</button>
    <p className="eyebrow">CONNECT YOUR MACHINE</p><h2 id="pair-title">Bring a relay online.</h2>
    <p>Run the relay’s <code>pair</code> command, then enter its five-minute code here. Approval is a separate step.</p>
    <form onSubmit={submit}>
      <label>Pairing code<input name="code" placeholder="ABCD-EF01-2345" autoComplete="off" maxLength={14} minLength={14} disabled={busy} required spellCheck={false} /></label>
      <label>Operator name<input name="name" defaultValue={account.display_name} maxLength={80} disabled={busy} required /></label>
      <label>Where does it run?<select name="hosting" disabled={busy}><option value="own_machine">My own computer</option><option value="vps">A VPS I control</option></select></label>
      <label className="check"><input type="checkbox" name="rules" disabled={busy} required /><span>I will use assigned data only for its review, keep it private and follow the agreed scope.</span></label>
      {error && <Notice error>{error}</Notice>}
      <button className="primary full" disabled={busy}>{busy ? 'Pairing…' : 'Pair relay →'}</button>
    </form>
    <p className="fine">Pairing enables presence only. Private website reviews need separate approval, operator opt-in and the requester’s permission.</p>
  </dialog>;
}

type DecisionAction = 'approve' | 'revoke' | 'approve_private' | 'revoke_private';
const decisionLabels: Record<DecisionAction, string> = { approve: 'Approve relay', revoke: 'Revoke relay', approve_private: 'Allow private reviews', revoke_private: 'Remove private access' };
function Decision({ device, action, csrf, onDone, onClose }: { device: Device; action: DecisionAction; csrf: string; onDone: () => void; onClose: () => void }) {
  const dialog = useDialog();
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault(); setError(''); setBusy(true);
    try {
      await write(`/devices/${device.id}/decision`, csrf, { action, reason: reason.trim() || null });
      onDone(); onClose();
    } catch (error) { setError((error as Error).message); } finally { setBusy(false); }
  }
  return <dialog ref={dialog} onCancel={event => { if (busy) event.preventDefault(); else onClose(); }} aria-labelledby="decision-title">
    <button className="close" onClick={onClose} disabled={busy} aria-label="Close decision">×</button>
    <p className="eyebrow">DEVICE ACCESS</p><h2 id="decision-title">{decisionLabels[action]}: {device.label}?</h2>
    <p>{action === 'approve_private' ? 'Permit this device to handle private website snapshots. Check the operator and isolation setup first. The requester must still agree to share their data with the proposed team.' : action === 'revoke_private' ? 'Stop private reviews involving this device and remove its evidence access. It can still run owned examples. Data already seen by its operator cannot be recalled.' : action === 'approve' ? 'Allow this device to join the prototype fleet. This does not verify its model, sandbox or operator identity.' : 'Its key will stop being accepted. Reconnecting will require a new device key and approval.'}</p>
    <form onSubmit={submit}>
      <label>{action === 'approve_private' ? 'What did you check?' : 'Reason (optional)'}<textarea value={reason} onChange={e => setReason(e.target.value)} disabled={busy} required={action === 'approve_private'} minLength={action === 'approve_private' ? 12 : undefined} maxLength={300} rows={3} /></label>
      {action === 'approve_private' && <label className="check"><input type="checkbox" disabled={busy} required /><span>I reviewed this operator and the isolated runtime for this private pilot.</span></label>}
      {error && <Notice error>{error}</Notice>}
      <button className={action.startsWith('revoke') ? 'danger full' : 'primary full'} disabled={busy}>{busy ? 'Saving…' : decisionLabels[action]}</button>
    </form>
  </dialog>;
}

function Guide() {
  const [agent, setAgent] = useState(false);
  const relay = './target/release/patchriot-relay';
  const state = agent ? '~/.patchriot-agent' : '~/.patchriot-fixture';
  const connect = `${relay} connect --state-dir ${state}${agent ? ' \\\n  --agents --agent-config .local/agent.json' : ' --fixtures'}`;
  return <section className="guide panel" aria-labelledby="setup-title">
    <p className="eyebrow">A MACHINE. A RELAY. YOUR CHOICE.</p><h2 id="setup-title">Start with a small contribution.</h2>
    <p>Read the <a href="https://github.com/adaki2004/patchriot-relay#readme" target="_blank" rel="noreferrer">relay source and setup instructions ↗</a> yourself—or ask your own security agent to review them. Pairing connects a device; it does not prove its safety.</p>
    <fieldset className="review-mode"><legend>What will this relay run?</legend>
      <label><input type="radio" name="setup-mode" checked={!agent} onChange={() => setAgent(false)} /><span><strong>Quick fixture check</strong><small>Start here. Built-in tests, no model or Docker needed.</small></span></label>
      <label><input type="radio" name="setup-mode" checked={agent} onChange={() => setAgent(true)} /><span><strong>Local agent with Hermes</strong><small>Your local model and a pinned, isolated runtime.</small></span></label>
    </fieldset>
    <ol className="steps">
      <li><strong>Build and check locally.</strong><span>Use Rust 1.94.1 on Linux or macOS. Keep the core and relay repositories beside each other, then run these commands from the relay repository.</span><pre>cargo build --release --locked</pre>{agent && <span>First follow the relay README to build the container image, configure your local model and save its pinned settings in <code>.local/agent.json</code>. Do not put keys or private settings in Git.</span>}<pre>{agent ? `${relay} agent-check --config .local/agent.json` : `${relay} demo`}</pre><span>{agent ? 'Continue after the tool check passes and container cleanup is confirmed. This tests a supplied example, not independent security expertise.' : 'The original flaw should be reproduced, with the supplied fix and clean control passing.'}</span></li>
      <li><strong>Create a separate device identity.</strong><span>Replace the placeholders with your dispatcher URL and deployment audience{agent ? ', inspected Hermes version and installed model name' : ''}. Use a new state directory for each device and the same compute group for devices sharing a machine.</span><pre>{`${relay} init --state-dir ${state} \\\n  --dispatcher https://YOUR-DISPATCHER \\\n  --audience YOUR-DEPLOYMENT \\\n  --label ${agent ? 'my-agent' : 'my-fixture'} --compute-group my-machine${agent ? ' \\\n  --runtime hermes --runtime-version YOUR-HERMES-VERSION \\\n  --model YOUR-LOCAL-MODEL' : ''}`}</pre></li>
      <li><strong>Pair, get approval, then connect.</strong><span>Enter the five-minute code under “Pair a relay”. An administrator approves the device under “Fleet & approvals”. Keep the connection running in a terminal.</span><pre>{`${relay} pair --state-dir ${state}\n${connect}`}</pre></li>
      <li><strong>Stay in control.</strong><span>Use a second terminal under the same Unix account to inspect, pause or resume your relay. Use that account for a systemd service too. Keep the state directory private; it contains your device key.</span><pre>{`${relay} status --state-dir ${state}\n${relay} pause --state-dir ${state}\n${relay} resume --state-dir ${state}`}</pre></li>
    </ol>
    <Notice>A review needs three approved devices in this mode. Once they are connected, choose <strong>Reviews → New example review → {agent ? 'Local agent check' : 'Quick fixture check'}</strong>. Shared machines run one role at a time. Three devices on one VPS are still one shared machine.</Notice>
    {agent && <details className="execution-details"><summary>Opt in to private website reviews</summary><p>After testing, stop the connection and restart it with <code>--website-reviews</code>. An admin must separately allow private reviews, and a requester must confirm the proposed team and consent to sharing their saved snapshot. You can see that plaintext.</p><pre>{`${connect} --website-reviews`}</pre></details>}
  </section>;
}

function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [sessionError, setSessionError] = useState('');
  const [initialCode, setInitialCode] = useState(() => window.location.pathname === '/activate' && /^[0-9a-f]{64}$/i.test(window.location.hash.slice(1)) ? window.location.hash.slice(1) : '');
  const [login, setLogin] = useState(Boolean(initialCode));
  const [accessRequest, setAccessRequest] = useState(false);
  useEffect(() => { if (window.location.pathname === '/activate') window.history.replaceState(null, '', '/'); }, []);
  const [pairing, setPairing] = useState(false);
  const [checkout, setCheckout] = useState<Deposit | null>(null);
  const { route, navigate } = useNavigation();
  const view = route.view;
  const setView = useCallback((next: View) => navigate(next), [navigate]);
  const [decision, setDecision] = useState<{ device: Device; action: DecisionAction } | null>(null);
  const [notice, setNotice] = useState('');
  const workspaceNav = useRef<HTMLElement>(null);
  const fleet = useLive<Fleet>('/fleet');
  const devices = useLive<Device[]>('/devices', Boolean(session?.account));
  const account = session?.account;
  const isAdmin = account?.role === 'admin';
  const privateView = !['overview', 'guide', 'incidents'].includes(view);
  const adminView = view === 'incident-desk' || view === 'payment-desk' || view === 'access-desk';
  useEffect(() => {
    const nav = workspaceNav.current;
    const active = nav?.querySelector<HTMLButtonElement>('button.active');
    if (!nav || !active) return;
    const reveal = () => {
      const frame = nav.getBoundingClientRect(), tab = active.getBoundingClientRect();
      // Reveal the selected tab without moving the page's vertical scroll position.
      if (tab.left < frame.left) nav.scrollLeft -= frame.left - tab.left;
      else if (tab.right > frame.right) nav.scrollLeft += tab.right - frame.right;
    };
    reveal();
    window.addEventListener('resize', reveal);
    return () => window.removeEventListener('resize', reveal);
  }, [view, account?.id, isAdmin]);
  const endSession = useCallback((message = '') => {
    sessionChanged();
    setSession({ account: null, csrf_token: null }); navigate('overview', null, false, true);
    setPairing(false); setDecision(null); setLogin(false); setCheckout(null); setSessionError(''); setNotice(message);
  }, [navigate]);
  useEffect(() => {
    const expired = () => endSession('Your session has ended. Sign in again to continue.');
    window.addEventListener(sessionExpiredEvent, expired);
    return () => window.removeEventListener(sessionExpiredEvent, expired);
  }, [endSession]);
  const loadSession = useCallback(async () => {
    try { const value = await api<Session>('/session'); sessionChanged(); setSession(value); setSessionError(''); if (value.account) setNotice(''); }
    catch (error) { if (!(error instanceof SessionChangedError)) setSessionError((error as Error).message); throw error; }
  }, []);
  useEffect(() => { void loadSession().catch(() => {}); }, [loadSession]);
  async function logout() {
    try { await write('/auth/logout', session!.csrf_token!); endSession(); }
    catch (error) { if (!(error instanceof SessionExpiredError || error instanceof SessionChangedError)) setSessionError((error as Error).message); }
  }
  function changed(message: string) { devices.refresh(); fleet.refresh(); setNotice(message); }
  return <>
    <a className="skip" href="#main" onClick={event => { event.preventDefault(); document.getElementById('main')?.focus(); }}>Skip to content</a>
    <header>
      <button className="brand" aria-label="Patchriot home" onClick={() => setView('overview')}><Mark /><span>patchriot<span className="brand-dot">.</span></span></button>
      <div className="header-right"><span className="version">v0.0.1 / PRIVATE ALPHA</span>{account ? <><span className="account-name">{account.display_name}</span><button className="quiet" onClick={() => void logout()}>Sign out</button></> : <><button className="quiet" onClick={() => setAccessRequest(true)}>Request access</button><button className="primary small" onClick={() => setLogin(true)}>Sign in ↗</button></>}</div>
    </header>
    <main id="main" tabIndex={-1}>
      <nav ref={workspaceNav} aria-label="Workspace"><button className={view === 'overview' ? 'active' : ''} onClick={() => setView('overview')}>Overview</button>{account && <button className={view === 'reviews' ? 'active' : ''} onClick={() => setView('reviews')}>Reviews</button>}{account && <button className={view === 'sites' ? 'active' : ''} onClick={() => setView('sites')}>Website checks</button>}{account && <button className={view === 'orders' ? 'active' : ''} onClick={() => setView('orders')}>Orders</button>}{account && <button className={view === 'devices' ? 'active' : ''} onClick={() => setView('devices')}>{isAdmin ? 'Fleet & approvals' : 'My relays'}</button>}<button className={view === 'incidents' ? 'active' : ''} onClick={() => setView('incidents')}>Watch log</button>{isAdmin && <button className={view === 'payment-desk' ? 'active' : ''} onClick={() => setView('payment-desk')}>Payment desk</button>}{isAdmin && <button className={view === 'incident-desk' ? 'active' : ''} onClick={() => setView('incident-desk')}>Incident desk</button>}<button className={view === 'guide' ? 'active' : ''} onClick={() => setView('guide')}>Relay setup</button>{isAdmin && <button className={view === 'access-desk' ? 'active' : ''} onClick={() => setView('access-desk')}>Access & users</button>}<span className="nav-note">DON’T TRUST. VERIFY.</span></nav>
      {sessionError && <Notice error>{sessionError} <button className="inline" onClick={() => void loadSession().catch(() => {})}>Retry</button></Notice>}
      {notice && <Notice>{notice}<button className="inline" onClick={() => setNotice('')}>Dismiss</button></Notice>}
      {privateView && !account && <section className="panel empty" aria-label="Private workspace access"><h1 className="page-title">{session ? 'This page is private.' : 'Checking your session…'}</h1><p>{session ? 'Sign in with the account that has access. A saved link does not share its contents.' : 'Your workspace will open after your session is checked.'}</p>{session && <button className="primary" onClick={() => setLogin(true)}>Sign in to open this page →</button>}</section>}
      {adminView && account && !isAdmin && <section className="panel empty"><h1 className="page-title">Administrator access required.</h1><p>This account cannot open the admin desk.</p></section>}
      {view === 'overview' && <>
        <section className="hero">
          <div className="hero-copy"><p className="eyebrow"><span className="tiny-mark">+</span> A SWARM OF REBELS. A SAFER INTERNET.</p><h1>More defenders.<br /><span>Fewer blind spots.</span></h1><p className="hero-description">One weak link can put everyone at risk. Bring a website you’re authorized to assess, collect evidence and confirm the proposed review team.</p>
            <div className="hero-actions">
              <button className="primary" onClick={() => setView('sites')}>Review a website <span>↗</span></button>
              <button className="text-button" onClick={() => account ? setPairing(true) : setView('guide')}>{account ? 'Pair a relay' : 'Contribute an agent'} <span>{account ? '↗' : '→'}</span></button>
            </div><p className="fine hero-footnote">Start with an approved snapshot. See who will review it before sharing.</p>
          </div>
          <div className="watch-card"><div className="watch-top"><span>FLEET / LIVE STATUS</span><span className={`dot ${fleet.error ? 'disconnected' : ''}`} /></div><div className="watch-art" aria-hidden="true"><div className="orbit orbit-a" /><div className="orbit orbit-b" /><div className="orbit orbit-c" /><div className="center-mark"><Mark /></div><span className="node node-a" /><span className="node node-b" /><span className="node node-c" /></div><div className="watch-bottom"><span>{fleet.error ? 'Connection interrupted' : fleet.data ? `${fleet.data.online_devices} approved relays online` : 'Connecting to dispatcher…'}</span><small>{fleet.updated ? `Updated ${fleet.updated.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : 'Waiting for a response'}</small></div></div>
        </section>
        {fleet.error && <Notice error>{fleet.error} <button className="inline" onClick={fleet.refresh}>Retry</button></Notice>}
        <section className="stats" aria-label="Live fleet counts"><div><span className="stat-value">{fleet.data?.online_devices ?? '—'}</span><span>Online relays</span></div><div><span className="stat-value">{fleet.data?.online_operators ?? '—'}</span><span>Distinct operators</span></div><div><span className="stat-value">{fleet.data?.online_compute_groups ?? '—'}</span><span>Declared compute groups</span></div><p>Live counts, not a decentralization claim. Several relays can belong to one operator or share one machine.</p></section>
        <section className="section-heading"><div><p className="eyebrow">EVIDENCE OVER ASSURANCES</p><h2>Find it. Reproduce it. Challenge it.</h2></div><span className="subtle">The review workflow we’re building</span></section>
        <div className="roles"><article><span className="role-number">01 / INVESTIGATE</span><h3>Follow the weak link.</h3><p>Inspect authorized code and websites. Turn a suspicion into a precise claim with evidence.</p></article><article><span className="role-number">02 / REPRODUCE</span><h3>Make the finding stand up.</h3><p>Run the same conditions against the same target. A confident answer is not a reproduction.</p></article><article><span className="role-number">03 / CHALLENGE</span><h3>Check the fix, too.</h3><p>Question the assumptions. Test the proposed patch and keep disagreements in the report.</p></article></div>
        <section className="pilot-note"><span className="pill">WORKING NOW</span><p><strong>Evidence you can inspect.</strong> Pair an agent, run an owned example or review an approved website snapshot. Private access is explicit; active penetration tests follow.</p><button className="text-button" onClick={() => setView('guide')}>Try the relay →</button></section>
        <IncidentLog />
      </>}
      {view === 'devices' && account && <>
        <section className="section-heading fleet-heading"><div><p className="eyebrow">{isAdmin ? 'OPERATOR CONSOLE' : 'YOUR CONTRIBUTION'}</p><h1 className="page-title">{isAdmin ? 'Fleet & approvals' : 'Your relays'}</h1><p className="subtle">Pairing proves a device key. Approval is a separate decision.</p></div><button className="primary" onClick={() => setPairing(true)}>Pair a relay +</button></section>
        {devices.error && <Notice error>{devices.error} <button className="inline" onClick={devices.refresh}>Retry</button></Notice>}
        <section className="panel fleet-panel"><div className="table-toolbar"><strong>{devices.data ? `${devices.data.length} ${isAdmin ? 'registered' : 'paired'} relays` : 'Loading relays…'}</strong><button className="quiet" onClick={devices.refresh}>Refresh ↻</button></div>
          {devices.data?.length === 0 && <div className="empty"><Mark /><h2>Your first relay starts here.</h2><p>Initialize the relay on a computer you control. Enter its pairing code, then wait for approval.</p><button className="text-button" onClick={() => setView('guide')}>Open setup instructions →</button></div>}
          {Boolean(devices.data?.length) && <div className="table-scroll"><table><thead><tr><th>Relay / operator</th><th>Agent / model</th><th>Access</th><th>Presence</th><th><span className="sr-only">Actions</span></th></tr></thead><tbody>{devices.data!.map(device => <tr key={device.id}><td><strong>{device.label}</strong><small>{device.operator_name}</small><small>Reports received: {device.reports_received == null ? "—" : device.reports_received.toLocaleString()}</small></td><td><strong>{device.runtime === 'owned_fixture' ? 'Owned fixture' : 'Hermes'}</strong><small>Version {device.runtime_version}</small>{device.declared_model && <small className="model-name">Declared model: {device.declared_model}</small>}<small>Compute: {device.compute_group}</small></td><td><span className={`badge ${device.approval}`}>{device.approval === 'pending' ? 'Awaiting approval' : device.approval}</span>{device.runtime === 'hermes' && <small>{device.private_work_approved ? 'Private reviews allowed' : 'Demo work only'} · {device.website_reviews ? 'Website opt-in on' : 'Website opt-in off'}</small>}</td><td><span className={`presence ${device.state}`} >{device.state.replaceAll('_', ' ')}</span><small>{device.last_seen_at ? new Date(device.last_seen_at * 1000).toLocaleTimeString() : 'No heartbeat yet'}</small></td><td className="row-actions">{isAdmin && device.approval === 'pending' && <button className="approve" onClick={() => setDecision({ device, action: 'approve' })}>Approve</button>}{device.approval === 'approved' && device.runtime === 'hermes' && (device.private_work_approved ? <button className="quiet" onClick={() => setDecision({ device, action: 'revoke_private' })}>Remove private access</button> : isAdmin && <button className="quiet" onClick={() => setDecision({ device, action: 'approve_private' })}>Allow private reviews</button>)}{device.approval !== 'revoked' && <button className="quiet" onClick={() => setDecision({ device, action: 'revoke' })}>Revoke</button>}</td></tr>)}</tbody></table></div>}
        </section><p className="fine">Online means the relay sent a recent heartbeat. Agent versions and model names are operator declarations. Pause and resume from the machine; presence expires after 30 seconds. Counts cover received role reports, including incomplete results. They do not measure verified findings or earnings.</p>
      </>}
      {view === 'reviews' && account && session?.csrf_token && <Reviews csrf={session.csrf_token} selected={route.id} onSelect={id => navigate('reviews', id)} onOpenOrders={() => setView('orders')} />}
      {view === 'orders' && account && session?.csrf_token && <Orders csrf={session.csrf_token} selected={route.id} onSelect={id => navigate('orders', id)} report={route.report} onReport={open => navigate('orders', route.id, open)} initialQuote={checkout} onClearQuote={() => setCheckout(null)} />}
      {view === 'sites' && account && session?.csrf_token && <Sites csrf={session.csrf_token} admin={isAdmin} accountId={account.id} selected={route.id} onSelect={id => navigate('sites', id)} onReview={id => navigate('reviews', id)} onCheckout={quote => { setCheckout(quote); navigate('orders', quote.order_id); }} />}
      {view === 'guide' && <Guide />}
      {view === 'incidents' && <IncidentLog />}
      {view === 'incident-desk' && isAdmin && session?.csrf_token && <IncidentDesk csrf={session.csrf_token} />}
      {view === 'payment-desk' && isAdmin && <PaymentDesk />}
      {view === 'access-desk' && isAdmin && session?.csrf_token && <AccessDesk csrf={session.csrf_token} />}
    </main>
    <footer><span>patchriot. <span className="subtle">A swarm of rebels. A safer internet.</span></span><span>Inspect the code. Question the evidence.</span></footer>
    {login && <Login initialCode={initialCode} onLogin={loadSession} onClose={() => { setLogin(false); setInitialCode(''); }} />}
    {accessRequest && <RequestAccess onClose={() => setAccessRequest(false)} />}
    {pairing && account && session?.csrf_token && <Pair account={account} csrf={session.csrf_token} onPaired={() => { setView('devices'); changed('Relay paired. Check its approval and connection status below.'); }} onClose={() => setPairing(false)} />}
    {decision && session?.csrf_token && <Decision {...decision} csrf={session.csrf_token} onDone={() => changed(`${decisionLabels[decision.action]}: saved.`)} onClose={() => setDecision(null)} />}
  </>;
}

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
