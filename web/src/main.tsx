import { Analytics } from './Analytics';
import { StrictMode, useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { api, write, sessionChanged, sessionExpiredEvent, SessionExpiredError, SessionChangedError } from './api';
import type { Account, Device, Fleet, Session } from './api';
import './fonts.css';
import './style.css';
import './redesign.css';
import './workspace.css';
import './textmode.css';
import './collective.css';
import { UIIcon } from './UIIcon';
import { Dashboard } from './Dashboard';
import { Pentests } from './Pentests';
import { Audits } from './Audits';
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
import { AccessPanel, AccessDialog, AccessDesk } from './Access';
import { Guide, AgentList, PairingClosed } from './Pairing';
import { Landing, RequestWork } from './Product';
import { Docs } from './Docs';
import { Sources } from './Sources';
import { Earnings } from './Earnings';
import { EnterpriseContact, ContactInbox } from './Contact';

function Mark() {
  return <img className="brand-mark" src="/brand/white-hat.png" alt="" width="44" height="44" />;
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
    <p>{action === 'approve_private' ? 'Permit this device to handle private customer reviews, including live tests when it explicitly opts in. Check the operator and isolation setup first. The requester must still agree to share their data with the proposed team.' : action === 'revoke_private' ? 'Stop private reviews involving this device and remove its evidence access. It can still run owned examples. Data already seen by its operator cannot be recalled.' : action === 'approve' ? 'Allow this device to join the prototype fleet. This does not verify its model, sandbox or operator identity.' : 'Its key will stop being accepted. Reconnecting will require a new device key and approval.'}</p>
    <form onSubmit={submit}>
      <label>{action === 'approve_private' ? 'What did you check?' : 'Reason (optional)'}<textarea value={reason} onChange={e => setReason(e.target.value)} disabled={busy} required={action === 'approve_private'} minLength={action === 'approve_private' ? 12 : undefined} maxLength={300} rows={3} /></label>
      {action === 'approve_private' && <label className="check"><input type="checkbox" disabled={busy} required /><span>I reviewed this operator and the isolated runtime for this private pilot.</span></label>}
      {error && <Notice error>{error}</Notice>}
      <button className={action.startsWith('revoke') ? 'danger full' : 'primary full'} disabled={busy}>{busy ? 'Saving…' : decisionLabels[action]}</button>
    </form>
  </dialog>;
}


function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [sessionError, setSessionError] = useState('');
  const [initialCode, setInitialCode] = useState(() => window.location.pathname === '/activate' && /^[0-9a-f]{64}$/i.test(window.location.hash.slice(1)) ? window.location.hash.slice(1) : '');
  const [signinFailed] = useState(() => new URLSearchParams(window.location.search).get('signin') === 'failed');
  const [accessOpen, setAccessOpen] = useState(Boolean(initialCode) || signinFailed);
  useEffect(() => { if (signinFailed) { const url = new URL(window.location.href); url.searchParams.delete('signin'); window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`); } }, [signinFailed]);
  const [startAudit, setStartAudit] = useState<'sites' | 'sources' | null>(null);
  useEffect(() => { if (window.location.pathname === '/activate') window.history.replaceState(null, '', `/${window.location.search}`); }, []);
  const [pairing, setPairing] = useState(false);
  const [checkout, setCheckout] = useState<Deposit | null>(null);
  const { route, navigate } = useNavigation();
  const view = route.view;
  const setView = useCallback((next: View) => navigate(next), [navigate]);
  const [decision, setDecision] = useState<{ device: Device; action: DecisionAction } | null>(null);
  const [notice, setNotice] = useState(signinFailed ? 'Sign-in was not completed. Please try again.' : '');
  const workspaceNav = useRef<HTMLElement>(null);
  const fleet = useLive<Fleet>('/fleet');
  const devices = useLive<Device[]>('/devices', Boolean(session?.account));
  const account = session?.account;
  const isAdmin = account?.role === 'admin';
  const privateView = !['home', 'overview', 'incidents', 'docs', 'contact'].includes(view);
  const appView = Boolean(account) && !['home', 'docs', 'incidents', 'contact'].includes(view);
  const adminView = ['audit-desk', 'incident-desk', 'payment-desk', 'access-desk', 'contact-inbox'].includes(view);
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
    setPairing(false); setDecision(null); setAccessOpen(false); setCheckout(null); setSessionError(''); setNotice(message);
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
  function openAccess() { setAccessOpen(true); }
  async function signedIn() {
    await loadSession(); setInitialCode(''); setAccessOpen(false);
    if (!privateView || view === 'home') setView('overview');
  }
  const access = <AccessPanel initialCode={initialCode} onLogin={signedIn} />;
  const landingAccess = <section className="access-invitation"><p className="tm-kicker">YOUR PRIVATE WORKSPACE</p><h3>Bring something<br />worth protecting.</h3><p>Request a test for a domain you control.</p><button className="primary" onClick={() => openAccess()}>Get started <span aria-hidden="true">↗</span></button><button className="text-button" onClick={() => openAccess()}>Sign in →</button></section>;
  const auditView = ['audits', 'sites', 'pentests', 'sources', 'reviews', 'request'].includes(view);
  const publicPage = view === 'home' || (view === 'overview' && ['', '#/', '#/overview'].includes(window.location.hash)) ? 'home' : view === 'docs' ? 'docs' : view === 'incidents' ? 'events' : null;
  const analyticsPage = session && !account && !accessOpen && !initialCode && window.location.pathname === '/' ? publicPage : null;
  return <>
    <a className="skip" href="#main" onClick={event => { event.preventDefault(); document.getElementById('main')?.focus(); }}>Skip to content</a>
    <header className="site-header">
      <button className="brand" aria-label="Patchriot home" onClick={() => setView('home')}><Mark /><span>patchriot<span className="brand-dot">_</span></span></button>
      <nav className="site-navigation" aria-label="Website">
        <button aria-current={view === 'home' ? 'page' : undefined} onClick={() => setView('home')}>Home</button>
        <button aria-current={view === 'incidents' ? 'page' : undefined} onClick={() => setView('incidents')}>Recent events</button>
        <button aria-current={view === 'docs' ? 'page' : undefined} onClick={() => navigate('docs', 'start')}>Docs</button>
        <button className="dashboard-destination" aria-current={view === 'overview' && account ? 'page' : undefined} onClick={() => account ? setView('overview') : openAccess()}>App <span aria-hidden="true">↗</span></button>
      </nav>
      {account && <div className="header-account"><span className="account-name">{account.display_name}</span><button className="quiet" onClick={() => void logout()}>Sign out</button></div>}
    </header>
    <main id="main" tabIndex={-1} className={appView ? 'app-main' : 'public-main'}>
      {account && appView && <nav ref={workspaceNav} className="workspace-nav" aria-label="Workspace">
        <span className="workspace-nav-label">WORKSPACE</span>
        <button className={view === 'overview' ? 'active' : ''} onClick={() => setView('overview')}><UIIcon name="grid" className="nav-icon" />Overview</button>
        <button className={auditView ? 'active' : ''} onClick={() => setView('audits')}><UIIcon name="folder" className="nav-icon" />Audits</button>
        {isAdmin && <button className={view === 'guide' ? 'active' : ''} onClick={() => setView('guide')}><UIIcon name="plus" className="nav-icon" />Pair an agent</button>}
        <button className={view === 'devices' ? 'active' : ''} onClick={() => setView('devices')}><UIIcon name="agent" className="nav-icon" />{isAdmin ? 'Agent approvals' : 'My agents'}</button>
        <button className={view === 'agents' ? 'active' : ''} aria-current={view === 'agents' ? 'page' : undefined} onClick={() => setView('agents')}>Network agents</button>
        <button className={view === 'orders' ? 'active' : ''} aria-current={view === 'orders' ? 'page' : undefined} onClick={() => setView('orders')}>Orders</button>
        <button className={view === 'earnings' ? 'active' : ''} aria-current={view === 'earnings' ? 'page' : undefined} onClick={() => setView('earnings')}>Earnings</button>
        {isAdmin && <details className="admin-navigation" open={adminView}><summary>Administration</summary><button className={view === 'audit-desk' ? 'active' : ''} onClick={() => setView('audit-desk')}>Audit activity</button><button className={view === 'access-desk' ? 'active' : ''} onClick={() => setView('access-desk')}>Access & users</button><button className={view === 'payment-desk' ? 'active' : ''} onClick={() => setView('payment-desk')}>Payment desk</button><button className={view === 'incident-desk' ? 'active' : ''} onClick={() => setView('incident-desk')}>Incident desk</button><button className={view === 'contact-inbox' ? 'active' : ''} onClick={() => setView('contact-inbox')}>Contact inbox</button></details>}
        <div className="workspace-nav-bottom"><span className="workspace-avatar" aria-hidden="true">{account.display_name.slice(0, 1).toUpperCase()}</span><div><strong>{account.display_name}</strong><small>Your private workspace</small></div></div>
      </nav>}
      <div className="page-content">
      {sessionError && <Notice error>{sessionError} <button className="inline" onClick={() => void loadSession().catch(() => {})}>Retry</button></Notice>}
      {notice && <Notice>{notice}<button className="inline" onClick={() => setNotice('')}>Dismiss</button></Notice>}
      {privateView && !account && <section className="private-entry"><div><p className="eyebrow">PRIVATE WORKSPACE</p><h1>{session ? 'Sign in to continue.' : 'Checking your session…'}</h1><p>A saved link does not share its contents. Use the account that owns this work.</p></div>{session && !accessOpen && access}</section>}
      {adminView && account && !isAdmin && <section className="panel empty"><h1 className="page-title">Administrator access required.</h1><p>This account cannot open the admin desk.</p></section>}
      {(view === 'home' || (view === 'overview' && !account)) && <Landing fleet={fleet.data} error={fleet.error} onRetry={fleet.refresh} signedIn={Boolean(account)} access={landingAccess} onAccess={openAccess} onApp={() => setView('overview')} onRequest={() => setView('request')} onDocs={() => navigate('docs', 'start')} />}
      {view === 'overview' && account && <><Dashboard csrf={session?.csrf_token ?? ''} key={account.id} name={account.display_name} fleet={fleet.data} onOpen={navigate} />{fleet.error && <Notice error>{fleet.error} <button className="inline" onClick={fleet.refresh}>Retry</button></Notice>}</>}
      {view === 'audits' && account && <Audits key={account.id} onOpen={navigate} />}
      {view === 'audit-desk' && isAdmin && <Audits key={`admin:${account.id}`} admin csrf={session?.csrf_token ?? undefined} onOpen={navigate} />}
      {['sites', 'sources', 'reviews'].includes(view) && account && <div className="audit-breadcrumb"><button className="text-button" onClick={() => setView('audits')}>← Your audits</button><span>{view === 'sites' ? 'Website snapshots' : view === 'sources' ? 'Source uploads' : 'Reports'}</span></div>}
      {['orders', 'earnings', 'agents'].includes(view) && account && <div className="audit-breadcrumb"><button className="text-button" onClick={() => setView('overview')}>← Dashboard</button></div>}
      {view === 'request' && account && <RequestWork onLive={() => navigate('pentests')} onWebsite={() => { setStartAudit('sites'); setView('sites'); }} onSource={() => { setStartAudit('sources'); setView('sources'); }} />}
      {view === 'docs' && <Docs page={route.id} onPage={page => navigate('docs', page)} />}
      {view === 'contact' && <EnterpriseContact />}
      {view === 'devices' && account && <>
        <section className="section-heading fleet-heading"><div><p className="eyebrow">{isAdmin ? 'OPERATOR CONSOLE' : 'YOUR CONTRIBUTION'}</p><h1 className="page-title">{isAdmin ? 'Agent approvals' : 'Your agents'}</h1><p className="subtle">Pairing proves a device key. Approval is a separate decision.</p></div>{isAdmin && <button className="primary" onClick={() => setPairing(true)}>Pair a relay +</button>}</section>
        {devices.error && <Notice error>{devices.error} <button className="inline" onClick={devices.refresh}>Retry</button></Notice>}
        <section className="panel fleet-panel"><div className="table-toolbar"><strong>{devices.data ? `${devices.data.length} ${isAdmin ? 'registered' : 'paired'} relays` : 'Loading relays…'}</strong><button className="quiet" onClick={devices.refresh}>Refresh ↻</button></div>
          {devices.data?.length === 0 && <div className="empty"><Mark /><h2>{isAdmin ? 'Your first relay starts here.' : 'Agent pairing is staff-only.'}</h2><p>{isAdmin ? 'Initialize the relay on a computer you control. Enter its pairing code, then wait for approval.' : 'Patchriot operates the agents in this beta. Existing approved agents can continue their work.'}</p><button className="text-button" onClick={() => setView('guide')}>Open setup instructions →</button></div>}
          {Boolean(devices.data?.length) && <div className="table-scroll"><table><thead><tr><th>Relay / operator</th><th>Agent / model</th><th>Access</th><th>Presence</th><th><span className="sr-only">Actions</span></th></tr></thead><tbody>{devices.data!.map(device => <tr key={device.id}><td><strong>{device.label}</strong><small>{device.operator_name}</small><small>Reports received: {device.reports_received == null ? "—" : device.reports_received.toLocaleString()}</small></td><td><strong>{device.runtime === 'owned_fixture' ? 'Owned fixture' : 'Hermes'}</strong><small>Runner {device.runtime_version}</small><small>{device.system ? [device.system.os_name, device.system.os_version, device.system.architecture].filter(Boolean).join(" · ") : device.reported_os ?? "OS not reported"}</small>{device.system && <small>Relay {device.system.relay_version}</small>}{device.declared_model && <small className="model-name">Declared model: {device.declared_model}</small>}<small>Compute: {device.compute_group}</small></td><td><span className={`badge ${device.approval}`}>{device.approval === 'pending' ? 'Awaiting approval' : device.approval}</span>{device.runtime === 'hermes' && <small>{device.private_work_approved ? 'Private reviews allowed' : 'Demo work only'} · {device.live_tests ? 'Live test opt-in on' : device.website_reviews ? 'Snapshot opt-in on' : 'Snapshot opt-in off'}</small>}</td><td><span className={`presence ${device.state}`} >{device.state.replaceAll('_', ' ')}</span><small>{device.last_seen_at ? new Date(device.last_seen_at * 1000).toLocaleTimeString() : 'No heartbeat yet'}</small></td><td className="row-actions">{isAdmin && device.approval === 'pending' && <button className="approve" onClick={() => setDecision({ device, action: 'approve' })}>Approve</button>}{device.approval === 'approved' && device.runtime === 'hermes' && (device.private_work_approved ? <button className="quiet" onClick={() => setDecision({ device, action: 'revoke_private' })}>Remove private access</button> : isAdmin && <button className="quiet" onClick={() => setDecision({ device, action: 'approve_private' })}>Allow private reviews</button>)}{device.approval !== 'revoked' && <button className="quiet" onClick={() => setDecision({ device, action: 'revoke' })}>Revoke</button>}</td></tr>)}</tbody></table></div>}
        </section><p className="fine">Online means the relay sent a recent heartbeat. Agent versions and model names are operator declarations. Pause and resume from the machine; presence expires after 30 seconds. Counts cover received role reports, including incomplete results. They do not measure verified findings or earnings.</p>
      </>}
      {view === 'reviews' && account && session?.csrf_token && <Reviews key={account.id} admin={account.role === 'admin'} csrf={session.csrf_token} selected={route.id} onSelect={id => navigate('reviews', id)} onOpenOrders={() => setView('orders')} />}
      {view === 'orders' && account && session?.csrf_token && <Orders csrf={session.csrf_token} selected={route.id} onSelect={id => navigate('orders', id)} report={route.report} onReport={open => navigate('orders', route.id, open)} onOpenReview={id => navigate('reviews', id)} initialQuote={checkout} onClearQuote={() => setCheckout(null)} />}
      {view === 'sites' && account && session?.csrf_token && <Sites key={account.id} startNew={startAudit === 'sites'} onStarted={() => setStartAudit(null)} csrf={session.csrf_token} admin={isAdmin} accountId={account.id} selected={route.id} onSelect={id => navigate('sites', id)} onReview={id => navigate('reviews', id)} onCheckout={quote => { setCheckout(quote); navigate('orders', quote.order_id); }} />}
      {view === 'pentests' && account && session?.csrf_token && <Pentests key={account.id} onBack={() => navigate('audits')} csrf={session.csrf_token} admin={isAdmin} selected={route.id} onSelect={id => navigate('pentests', id)} onReview={id => navigate('reviews', id)} onCheckout={quote => { setCheckout(quote); navigate('orders', quote.order_id); }} />}
      {view === 'sources' && account && session?.csrf_token && <Sources key={account.id} startNew={startAudit === 'sources'} onStarted={() => setStartAudit(null)} csrf={session.csrf_token} admin={isAdmin} selected={route.id} onSelect={id => navigate('sources', id)} onReview={id => navigate('reviews', id)} onCheckout={quote => { setCheckout(quote); navigate('orders', quote.order_id); }} />}
      {view === 'guide' && account && (isAdmin ? <Guide onPair={() => setPairing(true)} /> : <PairingClosed />)}
      {view === 'earnings' && account && session?.csrf_token && <Earnings csrf={session.csrf_token} />}
      {view === 'agents' && account && <AgentList />}
      {view === 'incidents' && <IncidentLog />}
      {view === 'incident-desk' && isAdmin && session?.csrf_token && <IncidentDesk csrf={session.csrf_token} />}
      {view === 'payment-desk' && isAdmin && <PaymentDesk />}
      {view === 'access-desk' && isAdmin && session?.csrf_token && <AccessDesk csrf={session.csrf_token} />}
      {view === 'contact-inbox' && isAdmin && session?.csrf_token && <ContactInbox key={account?.id} csrf={session.csrf_token} />}
      </div>
    </main>
    <Analytics page={analyticsPage} />
    <footer><span>patchriot. <span className="subtle">Shared intelligence. Practical defence.</span></span><span>Inspect the code. Question the evidence.</span></footer>
    {!account && accessOpen && <AccessDialog initialCode={initialCode} onLogin={signedIn} onClose={() => setAccessOpen(false)} />}
    {pairing && isAdmin && account && session?.csrf_token && <Pair account={account} csrf={session.csrf_token} onPaired={() => { setView('devices'); changed('Relay paired. Check its approval and connection status below.'); }} onClose={() => setPairing(false)} />}
    {decision && session?.csrf_token && <Decision {...decision} csrf={session.csrf_token} onDone={() => changed(`${decisionLabels[decision.action]}: saved.`)} onClose={() => setDecision(null)} />}
  </>;
}

if (location.pathname === '/wallet') void import('./WalletPage').then(module => module.mountWallet());
else createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
