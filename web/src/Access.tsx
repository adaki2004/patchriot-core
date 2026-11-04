import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { api, sessionChanged, write } from './api';
import { useDialog } from './useDialog';
import { useLive } from './useLive';

type LoginMode = 'password' | 'activate' | 'legacy';

type Provider = 'github' | 'google';
type Providers = Record<Provider, boolean>;
const destinations = { github: 'https://github.com/login/oauth/authorize', google: 'https://accounts.google.com/o/oauth2/v2/auth' };

/** Only the server's configured provider and our exact callback can be opened. */
export function signInDestination(provider: Provider, value: string): string {
  const url = new URL(value);
  if (`${url.origin}${url.pathname}` !== destinations[provider] || url.username || url.password || url.hash || url.searchParams.get('redirect_uri') !== `${window.location.origin}/api/auth/${provider}/callback` || url.searchParams.get('response_type') !== 'code' || !/^[a-f0-9]{64}$/i.test(url.searchParams.get('state') ?? '')) throw new Error('Sign-in could not be started. Please try again.');
  return url.href;
}

export function AccessPanel({ initialCode = '', onLogin, onBusyChange }: { initialCode?: string; onLogin: () => Promise<void>; onBusyChange?: (busy: boolean) => void }) {
  const panel = useRef<HTMLElement>(null);
  const [providers, setProviders] = useState<Providers | null>(null);
  const [busy, setBusy] = useState(false);
  const [legacyOpen, setLegacyOpen] = useState<boolean | null>(initialCode ? true : null);
  const [error, setError] = useState('');
  function changeBusy(value: boolean) { setBusy(value); onBusyChange?.(value); }
  useEffect(() => {
    let active = true;
    api<Providers>('/auth/providers').then(value => { if (active) setProviders({ github: value.github === true, google: value.google === true }); }).catch(() => { if (active) { setProviders({ github: false, google: false }); setError('Sign-in providers are unavailable. Existing pilot accounts can still use their password.'); } });
    return () => { active = false; };
  }, []);
  const enabled = providers?.github || providers?.google;
  const showLegacy = legacyOpen ?? (providers !== null && !enabled);
  useEffect(() => {
    const dialog = panel.current?.closest('dialog');
    if (providers && dialog?.open && document.activeElement?.classList.contains('close')) panel.current?.querySelector<HTMLElement>(enabled && !initialCode ? '.sso-buttons button:not(:disabled)' : 'input')?.focus();
  }, [providers, enabled, initialCode]);
  async function start(provider: Provider) {
    changeBusy(true); setError('');
    try {
      const result = await api<{ authorization_url: string }>(`/auth/${provider}/start`, { method: 'POST', body: '{}' });
      window.location.assign(signInDestination(provider, result.authorization_url));
    } catch (error) { setError((error as Error).message); changeBusy(false); }
  }
  return <section ref={panel} className="access-panel-inline" id="access" aria-label="Account access">
    <div className="access-form sso-entry">
      <p className="eyebrow">YOUR PRIVATE WORKSPACE</p><h2>Sign in to Patchriot.</h2>
      <p>Use your account. Verify your web application before any testing starts.</p>
      {!providers && <p role="status">Loading sign-in options…</p>}
      {enabled ? <><div className="sso-buttons">{(['github', 'google'] as const).filter(provider => providers?.[provider]).map(provider => <button className="quiet full" key={provider} disabled={busy} onClick={() => void start(provider)}>Continue with {provider === 'github' ? 'GitHub' : 'Google'} <span aria-hidden="true">↗</span></button>)}</div><p className="fine">Sign-in shares your name and verified email. It does not grant repository access.</p></> : providers && <p className="fine">Google and GitHub sign-in are being configured. Existing pilot accounts can sign in below.</p>}
      {error && <p className="notice error" role="alert">{error}</p>}
      <button className="text-button legacy-toggle" disabled={busy} aria-expanded={showLegacy} onClick={() => setLegacyOpen(!showLegacy)}>Existing pilot account</button>
    </div>
    {showLegacy && <Login initialCode={initialCode} onLogin={onLogin} onBusy={changeBusy} />}
  </section>;
}

/** One account form at a time; the native dialog contains focus and Escape. */
export function AccessDialog({ onClose, ...props }: Parameters<typeof AccessPanel>[0] & { onClose: () => void }) {
  const dialog = useDialog();
  const [busy, setBusy] = useState(false);
  return <dialog ref={dialog} className="access-dialog" aria-label="Sign in" onCancel={event => { if (busy) event.preventDefault(); else onClose(); }}>
    <div className="access-dialog-brand"><img src="/brand/white-hat.png" width="52" height="52" alt="" /><span>PATCHRIOT</span><button className="close" aria-label="Close account access" disabled={busy} onClick={onClose}>×</button></div>
    <AccessPanel {...props} onBusyChange={setBusy} />
  </dialog>;
}

function Login({ initialCode = '', onLogin, onBusy }: { initialCode?: string; onLogin: () => Promise<void>; onBusy: (value: boolean) => void }) {
  const [mode, setMode] = useState<LoginMode>(initialCode ? 'activate' : 'password');
  const [code, setCode] = useState(initialCode);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [accepted, setAccepted] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  function changeMode(next: LoginMode) { setMode(next); setError(''); setPassword(''); }
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); onBusy(true); setError(''); sessionChanged();
    try {
      if (!accepted) {
        const path = mode === 'legacy' ? '/auth/redeem' : mode === 'activate' ? '/auth/activate' : '/auth/login';
        const body = mode === 'legacy' ? { code: code.trim() } : { username, password, ...(mode === 'activate' ? { code: code.trim() } : {}) };
        await api(path, { method: 'POST', body: JSON.stringify(body) });
        setAccepted(true); setCode(''); setPassword('');
      }
      // A failed session read must not spend a one-use invitation again.
      await onLogin();
    } catch (error) { setError((error as Error).message); } finally { setBusy(false); onBusy(false); }
  }
  return <div className="access-form" aria-labelledby="login-title">
    <h2 id="login-title">{mode === 'activate' ? 'Set up your account' : 'Welcome back.'}</h2>
    <p>{accepted ? 'You’re signed in. Retry opening your workspace.' : mode === 'activate' ? 'Use your invitation and choose a password.' : mode === 'legacy' ? 'For pilot accounts with a one-use login code.' : 'Your work stays in your workspace.'}</p>
    <form onSubmit={submit}>
      {!accepted && <>
        {mode !== 'password' && <label>Invitation code<input type="password" autoComplete="one-time-code" value={code} onChange={e => setCode(e.target.value)} disabled={busy} required minLength={64} maxLength={64} spellCheck={false} /></label>}
        {mode !== 'legacy' && <>
          <label>Username<input autoComplete="username" autoCapitalize="none" spellCheck={false} value={username} onChange={e => setUsername(e.target.value)} disabled={busy} required minLength={3} maxLength={40} pattern="[A-Za-z0-9][A-Za-z0-9_.\-]{2,39}" /></label>
          <label>Password<input type="password" autoComplete={mode === 'activate' ? 'new-password' : 'current-password'} value={password} onChange={e => setPassword(e.target.value)} disabled={busy} required minLength={mode === 'activate' ? 15 : 1} maxLength={256} /></label>
          {mode === 'activate' && <p className="fine">Use at least 15 characters. A password manager can generate and save one.</p>}
        </>}
      </>}
      {error && <p className="notice error" role="alert">{error}</p>}
      <button className="primary full" disabled={busy}>{busy ? 'Opening workspace…' : accepted ? 'Retry opening workspace' : mode === 'activate' ? 'Create password and sign in' : 'Open workspace →'}</button>
    </form>
    {!accepted && <details className="access-alternatives" open={mode !== 'password'}><summary>Invitation or pilot code?</summary><div className="access-options">
      {mode !== 'password' && <button className="text-button" disabled={busy} onClick={() => changeMode('password')}>Use a password</button>}
      {mode !== 'activate' && <button className="text-button" disabled={busy} onClick={() => changeMode('activate')}>I have a setup invitation</button>}
      {mode !== 'legacy' && <button className="text-button" disabled={busy} onClick={() => changeMode('legacy')}>Use a pilot login code</button>}
    </div></details>}
    <p className="fine">Need a password reset? Ask the person who invited you.</p>
  </div>;
}

type Coupon = { id: string; code: string; expires_at: string };
type Grant = { account_id: string; invitation: string; expires_at: string; coupon: Coupon | null };
type RequestRow = { id: string; display_name: string; email: string; note: string; status: string; created_at: string; account_id: string | null };
type UserRow = { id: string; display_name: string; contact_email: string | null; username: string | null; auth_method?: 'password' | 'invite' | 'github' | 'google'; role: 'member' | 'admin'; disabled: boolean; unused_coupons: number };
type Desk = { requests: RequestRow[]; accounts: UserRow[] };
type Secret = { grant?: Grant; coupon?: Coupon };

function ShareAccess({ secret, onClose }: { secret: Secret; onClose: () => void }) {
  const dialog = useDialog();
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');
  const coupon = secret.grant?.coupon ?? secret.coupon;
  // The fragment is never part of the HTTP request. The activation page removes
  // it from browser history before sending any account API requests.
  const link = secret.grant ? `${window.location.origin}/activate#${secret.grant.invitation}` : '';
  const message = [link ? `Set up your Patchriot account (valid for 24 hours):\n${link}` : '', coupon ? `Your one-use review coupon (valid until ${new Date(coupon.expires_at).toLocaleString()}):\n${coupon.code}` : ''].filter(Boolean).join('\n\n');
  async function copy() {
    try { await navigator.clipboard.writeText(message); setCopied(true); setError(''); }
    catch { setError('Copy the text below manually. Clipboard access was unavailable.'); }
  }
  return <dialog ref={dialog} onCancel={onClose} aria-labelledby="share-title">
    <button className="close" onClick={onClose} aria-label="Close private access details">×</button>
    <h2 id="share-title">Share privately</h2>
    <p>Send this to the intended person. These codes are shown once. They choose their own password.</p>
    <label htmlFor="private-access-details">Private access details</label>
    <textarea id="private-access-details" readOnly rows={8} value={message} spellCheck={false} />
    {error && <p role="alert">{error}</p>}
    <button className="primary" onClick={() => void copy()}>{copied ? 'Copied' : 'Copy message'}</button>
    <p className="fine">Lost the message? Renew the setup link from Users. Issuing a replacement coupon cancels that user’s unused coupons; it does not cancel an existing review.</p>
  </dialog>;
}

export function AccessDesk({ csrf }: { csrf: string }) {
  const desk = useLive<Desk>('/admin/access');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [secret, setSecret] = useState<Secret | null>(null);
  const [withCoupon, setWithCoupon] = useState(true);
  const [disable, setDisable] = useState<UserRow | null>(null);
  async function act(path: string, body: unknown, kind: 'grant' | 'coupon' | 'none' = 'none') {
    setBusy(true); setError('');
    try {
      const result = await write<Grant | Coupon | null>(path, csrf, body);
      if (result && kind === 'grant') setSecret({ grant: result as Grant });
      if (result && kind === 'coupon') setSecret({ coupon: result as Coupon });
      setDisable(null); desk.refresh(); return true;
    } catch (error) { setError((error as Error).message); return false; } finally { setBusy(false); }
  }
  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = event.currentTarget; const data = new FormData(form);
    if (await act('/admin/accounts', { display_name: data.get('name'), email: data.get('email'), with_coupon: data.get('coupon') === 'on' }, 'grant')) form.reset();
  }
  const pending = desk.data?.requests.filter(request => request.status === 'pending');
  return <section aria-labelledby="access-desk-title">
    <div className="section-heading"><div><h1 id="access-desk-title" className="page-title">Access & users</h1><p className="subtle">Approve requests, invite people and sponsor a review.</p></div><button className="quiet" onClick={desk.refresh}>Refresh</button></div>
    {(error || desk.error) && <p className="notice error" role="alert">{error || desk.error} Check the saved users before repeating a request.</p>}
    <div className="access-columns">
      <section className="panel access-panel"><h2>Access requests</h2><p className="fine">Contact details are supplied by the applicant; they are not identity verification.</p>
        <label className="check"><input type="checkbox" checked={withCoupon} onChange={e => setWithCoupon(e.target.checked)} disabled={busy} /><span>Include one review coupon when approving</span></label>
        {!desk.data && <p>Loading requests…</p>}{pending?.length === 0 && <p>No pending requests.</p>}
        {pending?.map(request => <article className="access-request" key={request.id}><h3>{request.display_name}</h3><p className="subtle">{request.email} · {new Date(request.created_at).toLocaleDateString()}</p><p>{request.note}</p><div className="access-options"><button className="primary small" disabled={busy} onClick={() => void act(`/admin/access/${request.id}/decision`, { decision: 'approve', with_coupon: withCoupon }, 'grant')}>Approve {request.display_name}</button><button className="quiet" disabled={busy} onClick={() => void act(`/admin/access/${request.id}/decision`, { decision: 'decline', with_coupon: false })}>Decline {request.display_name}</button></div></article>)}
      </section>
      <section className="panel access-panel"><h2>Invite someone</h2><p>For a teammate, contributor or judge who hasn’t requested access.</p><form onSubmit={create}>
        <label>Name<input name="name" maxLength={80} required disabled={busy} /></label><label>Email<input name="email" type="email" maxLength={254} required disabled={busy} /></label>
        <label className="check"><input name="coupon" type="checkbox" defaultChecked disabled={busy} /><span>Include one review coupon</span></label>
        <button className="primary" disabled={busy}>{busy ? 'Saving…' : 'Create invitation'}</button>
      </form></section>
    </div>
    <section className="panel access-panel access-users"><h2>Users</h2><div className="table-scroll"><table><thead><tr><th>Person</th><th>Login</th><th>Access</th><th>Actions</th></tr></thead><tbody>{desk.data?.accounts.map(user => <tr key={user.id}><td><strong>{user.display_name}</strong><small>{user.contact_email ?? 'No contact email saved'}</small></td><td>{user.username ?? (user.auth_method === 'github' ? 'GitHub' : user.auth_method === 'google' ? 'Google' : 'Password not set')}</td><td>{user.disabled ? 'Disabled' : user.role === 'admin' ? 'Administrator' : 'Member'}<small>{user.unused_coupons} unused coupon{user.unused_coupons === 1 ? '' : 's'}</small></td><td className="row-actions">{user.role === 'member' && !user.disabled && <><button className="quiet" disabled={busy} onClick={() => void act(`/admin/accounts/${user.id}/invite`, {}, 'grant')}>Renew setup link</button><button className="quiet" disabled={busy} onClick={() => void act(`/admin/accounts/${user.id}/coupon`, {}, 'coupon')}>Issue coupon</button><button className="quiet" disabled={busy} onClick={() => setDisable(user)}>Disable login</button></>}</td></tr>)}</tbody></table></div><p className="fine">Latest 100 accounts. Renewing a link replaces earlier unused invitations. Completing setup ends that user’s old sessions. Disabling login does not revoke their relays; manage those in Agent approvals.</p></section>
    {disable && <DisableAccount user={disable} busy={busy} onClose={() => setDisable(null)} onConfirm={() => void act(`/admin/accounts/${disable.id}/disable`, {})} />}
    {secret && <ShareAccess secret={secret} onClose={() => setSecret(null)} />}
  </section>;
}

function DisableAccount({ user, busy, onClose, onConfirm }: { user: UserRow; busy: boolean; onClose: () => void; onConfirm: () => void }) {
  const dialog = useDialog();
  return <dialog ref={dialog} onCancel={event => { if (busy) event.preventDefault(); else onClose(); }} aria-labelledby="disable-title"><h2 id="disable-title">Disable {user.display_name}’s login?</h2><p>This ends their browser sessions and blocks sign-in. Their relays and existing work are managed separately.</p><div className="access-options"><button className="danger" disabled={busy} onClick={onConfirm}>Disable login</button><button className="quiet" disabled={busy} onClick={onClose}>Cancel</button></div></dialog>;
}
