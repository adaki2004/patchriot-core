import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { api, sessionChanged, write, type Session } from './api';
import { useDialog } from './useDialog';
import { openWallet } from './wallet';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from './components/ui/dialog';
import { Button } from './components/ui/button';
import { Input } from './components/ui/input';
import { useLive } from './useLive';
import { CouponRequests } from './Coupons';
import { UIIcon } from './UIIcon';

type LoginMode = 'password' | 'activate' | 'legacy';

type Provider = 'github' | 'google';
type Providers = Record<Provider, boolean> & { wallet: boolean };
const destinations = { github: 'https://github.com/login/oauth/authorize', google: 'https://accounts.google.com/o/oauth2/v2/auth' };

/** Only the server's configured provider and our exact callback can be opened. */
export function signInDestination(provider: Provider, value: string): string {
  const url = new URL(value);
  if (`${url.origin}${url.pathname}` !== destinations[provider] || url.username || url.password || url.hash || url.searchParams.get('redirect_uri') !== `${window.location.origin}/api/auth/${provider}/callback` || url.searchParams.get('response_type') !== 'code' || !/^[a-f0-9]{64}$/i.test(url.searchParams.get('state') ?? '')) throw new Error('Sign-in could not be started. Please try again.');
  return url.href;
}

function ProviderIcon({ provider }: { provider: Provider }) {
  return <svg width="20" height="20" viewBox="0 0 24 24" className="signin-provider-icon" aria-hidden="true">{provider === 'github' ? <path fill="currentColor" d="M12 .9a11.1 11.1 0 0 0-3.51 21.63c.55.1.76-.24.76-.54v-2.13c-3.09.67-3.74-1.31-3.74-1.31-.51-1.29-1.24-1.63-1.24-1.63-1.01-.69.08-.68.08-.68 1.12.08 1.7 1.15 1.7 1.15.99 1.69 2.59 1.2 3.22.92.1-.72.39-1.2.71-1.48-2.47-.28-5.07-1.24-5.07-5.49 0-1.21.43-2.2 1.14-2.98-.11-.28-.49-1.41.11-2.94 0 0 .94-.3 3.05 1.14a10.6 10.6 0 0 1 5.56 0c2.12-1.44 3.05-1.14 3.05-1.14.61 1.53.23 2.66.12 2.94.71.78 1.14 1.77 1.14 2.98 0 4.26-2.6 5.2-5.08 5.48.4.35.75 1.02.75 2.06v3.11c0 .3.2.65.77.54A11.1 11.1 0 0 0 12 .9Z" /> : <><path fill="#4285F4" d="M21.6 12.23c0-.71-.06-1.39-.18-2.05H12v3.88h5.38a4.6 4.6 0 0 1-1.99 3.01v2.5h3.23c1.89-1.74 2.98-4.3 2.98-7.34Z" /><path fill="#34A853" d="M12 22c2.7 0 4.96-.9 6.62-2.43l-3.23-2.5c-.9.6-2.05.97-3.39.97-2.61 0-4.83-1.76-5.62-4.12H3.04v2.58A10 10 0 0 0 12 22Z" /><path fill="#FBBC05" d="M6.38 13.92a6 6 0 0 1 0-3.84V7.5H3.04a10 10 0 0 0 0 9l3.34-2.58Z" /><path fill="#EA4335" d="M12 5.96c1.47 0 2.79.5 3.83 1.5l2.87-2.87A9.62 9.62 0 0 0 12 2a10 10 0 0 0-8.96 5.5l3.34 2.58C7.17 7.72 9.39 5.96 12 5.96Z" /></>}</svg>;
}

export function AccessPanel({ initialCode = '', onLogin, onBusyChange }: { initialCode?: string; onLogin: () => Promise<void>; onBusyChange?: (busy: boolean) => void }) {
  const panel = useRef<HTMLElement>(null);
  const [providers, setProviders] = useState<Providers | null>(null);
  const [busy, setBusy] = useState(false);
  const [legacyOpen, setLegacyOpen] = useState<boolean | null>(initialCode ? true : null);
  const [error, setError] = useState('');
  const [walletAccepted,setWalletAccepted] = useState(false);
  function changeBusy(value: boolean) { setBusy(value); onBusyChange?.(value); }
  useEffect(() => {
    let active = true;
    api<Providers>('/auth/providers').then(value => { if (active) setProviders({ github: value.github === true, google: value.google === true, wallet: value.wallet === true }); }).catch(() => { if (active) { setProviders({ github: false, google: false, wallet: false }); setError('Sign-in providers are unavailable. Existing password accounts can still use their password.'); } });
    return () => { active = false; };
  }, []);
  const enabled = providers?.github || providers?.google || providers?.wallet;
  const showLegacy = legacyOpen ?? (providers !== null && !enabled);
  useEffect(() => {
    const dialog = panel.current?.closest('[role=dialog]');
    if (providers && dialog?.contains(document.activeElement)) panel.current?.querySelector<HTMLElement>(enabled && !initialCode ? '.sso-buttons button:not(:disabled)' : 'input')?.focus();
  }, [providers, enabled, initialCode]);
  async function start(provider: Provider) {
    changeBusy(true); setError('');
    try {
      const result = await api<{ authorization_url: string }>(`/auth/${provider}/start`, { method: 'POST', body: '{}' });
      window.location.assign(signInDestination(provider, result.authorization_url));
    } catch (error) { setError((error as Error).message); changeBusy(false); }
  }
  async function walletSignIn() {
    changeBusy(true); setError('');
    try { if(!walletAccepted) { const session=await api<Session>('/session'); if(!session.account) await openWallet('signin'); setWalletAccepted(true); } sessionChanged(); await onLogin(); }
    catch (error) { setError((error as Error).message); }
    finally { changeBusy(false); }
  }
  return <section ref={panel} className="access-panel-inline" id="access" aria-label="Account access">
    <div className="access-form sso-entry">
      <p className="eyebrow">YOUR PRIVATE WORKSPACE</p><h2>Sign in to Patchriot.</h2>
      <p>Everyone can sign in. Verify your web application before any testing starts.</p>
      {!providers && <p role="status">Loading sign-in options…</p>}
      {enabled ? <><div className="sso-buttons">{(['github', 'google'] as const).filter(provider => providers?.[provider]).map(provider => <Button className="quiet full" key={provider} disabled={busy} onClick={() => void start(provider)}><ProviderIcon provider={provider} />Continue with {provider === 'github' ? 'GitHub' : 'Google'} <span aria-hidden="true">↗</span></Button>)}{providers?.wallet && <Button className="quiet full" disabled={busy} onClick={() => void walletSignIn()}><UIIcon name="wallet" className="signin-provider-icon" />{walletAccepted ? 'Open my workspace' : 'Connect wallet'}</Button>}</div><p className="fine">Google/GitHub share your verified profile, not repository access. Wallet sign-in uses a signed message.</p></> : providers && <p className="fine">Google and GitHub sign-in are being configured. Existing password accounts can sign in below.</p>}
      {error && <p className="notice error" role="alert">{error}</p>}
      <Button className="text-button legacy-toggle" disabled={busy} aria-expanded={showLegacy} onClick={() => setLegacyOpen(!showLegacy)}>Existing password account</Button>
    </div>
    {showLegacy && <fieldset className="legacy-login-fields" disabled={busy}><Login initialCode={initialCode} onLogin={onLogin} onBusy={changeBusy} /></fieldset>}
  </section>;
}

/** Radix keeps keyboard focus inside the current sign-in/wallet layer. */
export function AccessDialog({ onClose, ...props }: Parameters<typeof AccessPanel>[0] & { onClose: () => void }) {
  const [busy,setBusy]=useState(false);
  return <Dialog open onOpenChange={open => { if(!open && !busy) onClose(); }}>
    <DialogContent className="access-modal" canClose={!busy} onEscapeKeyDown={event=>{if(busy)event.preventDefault();}} onInteractOutside={event=>{if(busy)event.preventDefault();}}>
      <DialogTitle className="sr-only">Sign in</DialogTitle><DialogDescription className="sr-only">Choose a sign-in method for your private workspace.</DialogDescription>
      <div className="access-dialog-brand"><img src="/brand/white-hat.png" width="52" height="52" alt=""/><span>PATCHRIOT</span></div>
      <AccessPanel {...props} onBusyChange={value=>{setBusy(value);props.onBusyChange?.(value);}}/>
    </DialogContent>
  </Dialog>;
}

function Login({ initialCode = '', onLogin, onBusy }: { initialCode?: string; onLogin: () => Promise<void>; onBusy: (value: boolean) => void }) {
  const [mode] = useState<LoginMode>(initialCode ? 'activate' : 'password');
  const [code, setCode] = useState(initialCode);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [accepted, setAccepted] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
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
        {mode !== 'password' && <label>Invitation code<Input type="password" autoComplete="one-time-code" value={code} onChange={e => setCode(e.target.value)} disabled={busy} required minLength={64} maxLength={64} spellCheck={false} /></label>}
        {mode !== 'legacy' && <>
          <label>Username<Input autoComplete="username" autoCapitalize="none" spellCheck={false} value={username} onChange={e => setUsername(e.target.value)} disabled={busy} required minLength={3} maxLength={40} pattern="[A-Za-z0-9][A-Za-z0-9_.\-]{2,39}" /></label>
          <label>Password<Input type="password" autoComplete={mode === 'activate' ? 'new-password' : 'current-password'} value={password} onChange={e => setPassword(e.target.value)} disabled={busy} required minLength={mode === 'activate' ? 15 : 1} maxLength={256} /></label>
          {mode === 'activate' && <p className="fine">Use at least 15 characters. A password manager can generate and save one.</p>}
        </>}
      </>}
      {error && <p className="notice error" role="alert">{error}</p>}
      <Button className="primary full" disabled={busy}>{busy ? 'Opening workspace…' : accepted ? 'Retry opening workspace' : mode === 'activate' ? 'Create password and sign in' : 'Open workspace →'}</Button>
    </form>
    <p className="fine">Need a password reset? Contact Patchriot support.</p>
  </div>;
}

type Coupon = { id: string; code: string; expires_at: string };
type Grant = { account_id: string; invitation: string; expires_at: string; coupon: Coupon | null };
type RequestRow = { id: string; display_name: string; email: string; note: string; status: string; created_at: string; account_id: string | null };
type UserRow = { id: string; display_name: string; contact_email: string | null; username: string | null; auth_method?: 'password' | 'invite' | 'github' | 'google' | 'wallet'; role: 'member' | 'admin'; disabled: boolean; unused_coupons: number };
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
    <Button className="close" onClick={onClose} aria-label="Close private access details">×</Button>
    <h2 id="share-title">Share privately</h2>
    <p>Send this to the intended person. This coupon is shown once. The recipient signs in to their own account.</p>
    <label htmlFor="private-access-details">Private access details</label>
    <textarea id="private-access-details" readOnly rows={8} value={message} spellCheck={false} />
    {error && <p role="alert">{error}</p>}
    <Button className="primary" onClick={() => void copy()}>{copied ? 'Copied' : 'Copy message'}</Button>
    <p className="fine">Issuing a replacement coupon cancels that user’s unused coupons; it does not cancel an existing review.</p>
  </dialog>;
}

export function AccessDesk({ csrf }: { csrf: string }) {
  const desk = useLive<Desk>('/admin/access');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [secret, setSecret] = useState<Secret | null>(null);
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
  return <section aria-labelledby="access-desk-title">
    <div className="section-heading"><div><h1 id="access-desk-title" className="page-title">Access & users</h1><p className="subtle">Sign-in is open. Manage accounts and approve free audits.</p></div><Button className="quiet" onClick={desk.refresh}>Refresh</Button></div>
    {(error || desk.error) && <p className="notice error" role="alert">{error || desk.error} Check the saved users before repeating a request.</p>}
    <CouponRequests csrf={csrf} />
    <section className="panel access-panel access-users"><h2>Users</h2><div className="table-scroll"><table><thead><tr><th>Person</th><th>Login</th><th>Access</th><th>Actions</th></tr></thead><tbody>{desk.data?.accounts.map(user => <tr key={user.id}><td><strong>{user.display_name}</strong><small>{user.contact_email ?? 'No contact email saved'}</small></td><td>{user.username ?? (user.auth_method === 'github' ? 'GitHub' : user.auth_method === 'google' ? 'Google' : user.auth_method === 'wallet' ? 'Wallet' : 'Password not set')}</td><td>{user.disabled ? 'Disabled' : user.role === 'admin' ? 'Administrator' : 'Member'}<small>{user.unused_coupons} unused coupon{user.unused_coupons === 1 ? '' : 's'}</small></td><td className="row-actions">{user.role === 'member' && !user.disabled && <><Button className="quiet" disabled={busy} onClick={() => void act(`/admin/accounts/${user.id}/coupon`, {}, 'coupon')}>Issue coupon</Button><Button className="quiet" disabled={busy} onClick={() => setDisable(user)}>Disable login</Button></>}</td></tr>)}</tbody></table></div><p className="fine">Latest 100 accounts. Disabling login ends browser sessions; manage relays separately in Agent approvals.</p></section>
    {disable && <DisableAccount user={disable} busy={busy} onClose={() => setDisable(null)} onConfirm={() => void act(`/admin/accounts/${disable.id}/disable`, {})} />}
    {secret && <ShareAccess secret={secret} onClose={() => setSecret(null)} />}
  </section>;
}

function DisableAccount({ user, busy, onClose, onConfirm }: { user: UserRow; busy: boolean; onClose: () => void; onConfirm: () => void }) {
  const dialog = useDialog();
  return <dialog ref={dialog} onCancel={event => { if (busy) event.preventDefault(); else onClose(); }} aria-labelledby="disable-title"><h2 id="disable-title">Disable {user.display_name}’s login?</h2><p>This ends their browser sessions and blocks sign-in. Their relays and existing work are managed separately.</p><div className="access-options"><Button className="danger" disabled={busy} onClick={onConfirm}>Disable login</Button><Button className="quiet" disabled={busy} onClick={onClose}>Cancel</Button></div></dialog>;
}
