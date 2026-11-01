import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { write } from './api';
import { useLive } from './useLive';
import { useDialog } from './useDialog';
import { WebsiteReviewSetup } from './WebsiteReview';
import type { Deposit } from './Checkout';
import { SiteComparison } from './SiteComparison';

type Scope = { homepage: string; script_origins: string[] };
type Summary = { homepage_sha256: string; external_scripts: number; inline_scripts: number; skipped_scripts: number; script_limit_reached: boolean; captured_response_bytes: number; requests_made: number; finished_at: number };
type Site = { id: string; request_id: string; requester_id: string; scope: Scope; scope_sha256: string; authority_note: string; state: string; created_at: number; deadline_at: number; decision_note: string | null; attempts: number; error: string | null; summary: Summary | null; evidence_available: boolean; evidence_expires_at: number | null };
const states: Record<string, string> = { pending_approval: 'Awaiting approval', queued: 'Approved · waiting', collecting: 'Collecting evidence', collected: 'Snapshot ready', failed: 'Collection incomplete', cancelled: 'Cancelled', rejected: 'Not approved' };
const active = (state: string) => ['pending_approval', 'queued', 'collecting'].includes(state);
const label = (state: string) => states[state] ?? state.replaceAll('_', ' ');
const date = (value: number) => new Date(value * 1000).toLocaleString();

function origin(raw: string): string {
  const url = new URL(raw.trim());
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.pathname !== '/' || url.search || url.hash || !url.hostname.includes('.') || url.hostname.endsWith('.')) {
    throw new Error('Use an HTTPS origin, such as https://your-site.com, without a path, query, login or custom port.');
  }
  return url.origin;
}

function NewSite({ csrf, onCreated, onClose }: { csrf: string; onCreated: (site: Site) => void; onClose: () => void }) {
  const dialog = useDialog('input[name="homepage"]');
  const requestId = useRef(crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError('');
    const form = new FormData(event.currentTarget);
    try {
      const homepage = origin(String(form.get('homepage') ?? ''));
      const script_origins = String(form.get('origins') ?? '').split('\n').map(value => value.trim()).filter(Boolean).map(origin);
      if (script_origins.length > 3) throw new Error('List at most three additional script origins.');
      setBusy(true);
      const site = await write<Site>('/site-checks', csrf, { request_id: requestId.current, scope: { homepage, script_origins }, authorized: form.get('authorized') === 'on', authority_note: String(form.get('authority') ?? '').trim() });
      onCreated(site); onClose();
    } catch (error) { setError(error instanceof TypeError ? 'Enter a complete HTTPS address for each origin.' : (error as Error).message); }
    finally { setBusy(false); }
  }
  return <dialog ref={dialog} aria-labelledby="new-site-title" onCancel={event => { if (busy) event.preventDefault(); else onClose(); }}>
    <button className="close" aria-label="Close website setup" onClick={onClose} disabled={busy}>×</button>
    <p className="eyebrow">WEBSITE EVIDENCE / PRIVATE ALPHA</p><h2 id="new-site-title">Start with a snapshot.</h2>
    <p>An admin checks your permission and scope first. Submitting this form does not start collection.</p>
    <form className="site-form" onSubmit={submit} onChange={() => { requestId.current = crypto.randomUUID(); }}>
      <fieldset disabled={busy}>
        <label>Website origin<input type="url" name="homepage" placeholder="https://your-site.com" required maxLength={2048} /></label>
        <label>Additional script origins <span className="subtle">(optional)</span><textarea name="origins" rows={3} maxLength={6150} placeholder="https://cdn.your-site.com" /><small>One per line, up to three. Only scripts referenced by the homepage can be fetched.</small></label>
        <label>Your permission to review this site<textarea name="authority" minLength={12} maxLength={1200} rows={2} placeholder="I operate this website, or…" required /></label>
        <label className="check"><input type="checkbox" name="authorized" required /><span>I own this site or have permission to review the listed scope.</span></label>
        <details className="execution-details"><summary>What gets collected?</summary><p>The public homepage and up to four external scripts. No JavaScript execution, login, redirects or active attacks. Evidence is private to you and admins and downloadable for seven days. This pilot is free.</p></details>
        {error && <div className="notice error" role="alert">{error}</div>}
        <button className="primary full" disabled={busy}>{busy ? 'Submitting…' : 'Request approval →'}</button>
      </fieldset>
    </form>
  </dialog>;
}

function SiteDetail({ id, csrf, admin, accountId, sites, onReview, onCheckout, onClose, onChange }: { id: string; csrf: string; admin: boolean; accountId: string; sites: Site[]; onReview: (id: string) => void; onCheckout: (quote: Deposit) => void; onClose: () => void; onChange: () => void }) {
  const panel = useRef<HTMLElement>(null);
  const detail = useLive<Site>(`/site-checks/${id}`);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const site = detail.data;
  useEffect(() => { panel.current?.focus({ preventScroll: true }); panel.current?.scrollIntoView({ block: 'start' }); }, [id]);
  useEffect(() => { if (site) onChange(); }, [site?.state, site?.evidence_available, onChange]);
  async function decide(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!site) return;
    const form = new FormData(event.currentTarget);
    setBusy(true); setError('');
    try {
      await write(`/site-checks/${id}/decision`, csrf, { action: form.get('decision'), scope_sha256: site.scope_sha256, reason: String(form.get('reason') ?? '').trim() });
      detail.refresh(); onChange();
    } catch (error) { setError((error as Error).message); } finally { setBusy(false); }
  }
  async function cancel() {
    if (!window.confirm('Cancel this collection? Some approved requests may already have been made.')) return;
    setBusy(true); setError('');
    try { await write(`/site-checks/${id}/cancel`, csrf, {}); detail.refresh(); onChange(); }
    catch (error) { setError((error as Error).message); } finally { setBusy(false); }
  }
  return <section ref={panel} tabIndex={-1} className="review-detail panel site-detail" aria-label="Website evidence">
    <div className="section-heading"><div><p className="eyebrow">LIMITED WEBSITE SNAPSHOT</p><h2>{site ? label(site.state) : detail.error ? 'Snapshot unavailable' : 'Loading scope…'}</h2><p className="fine">{id}</p></div><button className="quiet" onClick={onClose}>Close snapshot ×</button></div>
    {(detail.error || error) && <div className="notice error" role="alert">{detail.error || error} {detail.error && <button className="inline" onClick={detail.refresh}>Retry snapshot</button>}</div>}
    {site && <>
      <dl className="site-scope"><dt>Homepage</dt><dd><code>{site.scope.homepage}</code></dd><dt>Additional script origins</dt><dd>{site.scope.script_origins.length ? site.scope.script_origins.map(origin => <code key={origin}>{origin}<br /></code>) : 'None — homepage origin only'}</dd><dt>Permission supplied by requester</dt><dd>{site.authority_note}</dd>{admin && <><dt>Requester</dt><dd><code>{site.requester_id}</code></dd></>}{site.decision_note && <><dt>Admin decision</dt><dd>{site.decision_note}</dd></>}</dl>
      <div className="review-actions"><button className="quiet" onClick={detail.refresh}>Refresh snapshot ↻</button>{site.evidence_available && <a className="text-button" href={`/api/site-checks/${id}/evidence`} download>Download snapshot JSON ↓</a>}{active(site.state) && <button className="quiet" disabled={busy} onClick={() => void cancel()}>Cancel collection</button>}</div>
      {site.state === 'pending_approval' && <p className="notice">No website requests have been made. Approval is needed by {date(site.deadline_at)}.</p>}
      {['queued', 'collecting'].includes(site.state) && <p className="notice">Approved scope expires at {date(site.deadline_at)}. Only one collection runs at a time; each collection has a 30-second limit.</p>}
      {site.error && <p className="notice error">Collection stopped: {site.error.replaceAll('_', ' ')}. No security verdict was produced.</p>}
      {site.summary && <>
        <div className="site-metrics" aria-label="Snapshot coverage"><div><strong>{site.summary.external_scripts}</strong><span>External scripts</span></div><div><strong>{site.summary.inline_scripts}</strong><span>Inline scripts</span></div><div><strong>{site.summary.skipped_scripts}</strong><span>Skipped scripts</span></div><div><strong>{Math.ceil(site.summary.captured_response_bytes / 1024)} KiB</strong><span>Saved responses</span></div></div>
        <p className="notice"><strong>Collected does not mean safe.</strong> This is saved HTTP evidence, with no browser execution. Scripts loaded later by the page are outside this snapshot. The download lists fetched and skipped scripts, their hashes and selected response headers.{site.summary.script_limit_reached ? ' The page exceeded the 40-script reference limit.' : ''}</p>
        <p className="fine">Captured {date(site.summary.finished_at)} · {site.summary.requests_made} HTTP requests{site.evidence_available && site.evidence_expires_at ? ` · Download until ${date(site.evidence_expires_at)}` : ' · Saved bodies have expired'}</p>
        <details className="execution-details"><summary>Evidence fingerprint</summary><p className="fine">Homepage SHA-256: <code>{site.summary.homepage_sha256}</code></p><p className="fine">Approved scope SHA-256: <code>{site.scope_sha256}</code></p></details>
        {site.evidence_available && <SiteComparison siteId={site.id} candidates={sites.filter(other => other.id !== site.id && other.requester_id === site.requester_id && other.scope_sha256 === site.scope_sha256 && other.state === 'collected' && other.evidence_available && other.summary && other.summary.finished_at <= site.summary!.finished_at).map(other => ({ id: other.id, finished_at: other.summary!.finished_at }))} />}
        {site.evidence_available && site.requester_id === accountId && <div className="site-review-cta"><h3>Have agents review the snapshot.</h3><p>Choose three approved devices and consent to sharing this evidence. Reports appear under Reviews.</p><button className="primary" onClick={() => setReviewing(true)}>Choose review agents →</button></div>}
      </>}
      {admin && site.state === 'pending_approval' && <form className="site-form site-decision" onSubmit={decide}><fieldset disabled={busy}><h3>Check authority before allowing requests.</h3><label>Decision<select name="decision" defaultValue="approve"><option value="approve">Approve this exact scope</option><option value="reject">Reject this request</option></select></label><label>Decision note<textarea name="reason" minLength={12} maxLength={1200} rows={2} required placeholder="How was permission checked, or why is it refused?" /></label><label className="check"><input type="checkbox" required /><span>I reviewed the listed origins and the requester’s authority.</span></label><button className="primary" disabled={busy}>{busy ? 'Recording…' : 'Record decision'}</button></fieldset></form>}
    </>}
    {reviewing && <WebsiteReviewSetup siteId={id} csrf={csrf} onCreated={onReview} onCheckout={onCheckout} onClose={() => setReviewing(false)} />}
  </section>;
}

export function Sites({ csrf, admin, accountId, selected, onSelect, onReview, onCheckout }: { csrf: string; admin: boolean; accountId: string; selected: string | null; onSelect: (id: string | null) => void; onReview: (id: string) => void; onCheckout: (quote: Deposit) => void }) {
  const sites = useLive<Site[]>('/site-checks');
  const [creating, setCreating] = useState(false);
  return <>
    <section className="section-heading fleet-heading"><div><p className="eyebrow">PRIVATE WORKSPACE</p><h1 className="page-title">Website checks</h1><p className="subtle">Capture an approved site’s homepage and scripts. Inspect what was actually collected.</p></div><button className="primary" onClick={() => setCreating(true)}>New website snapshot +</button></section>
    {sites.error && <div className="notice error" role="alert">{sites.error} <button className="inline" onClick={sites.refresh}>Retry</button></div>}
    {selected && <SiteDetail key={selected} id={selected} csrf={csrf} admin={admin} accountId={accountId} sites={sites.data ?? []} onReview={onReview} onCheckout={onCheckout} onClose={() => onSelect(null)} onChange={sites.refresh} />}
    <section className="panel"><div className="table-toolbar"><strong>{sites.data ? `${sites.data.length} recent ${sites.data.length === 1 ? 'snapshot' : 'snapshots'}` : 'Loading snapshots…'}</strong><button className="quiet" onClick={sites.refresh}>Refresh websites ↻</button></div>
      {sites.data?.length === 0 && <div className="empty"><h2>Know what your site serves.</h2><p>Start with the public homepage and the scripts it includes. Permission comes first; a snapshot gives you evidence to review.</p></div>}
      {sites.data?.map(site => <button className={`review-item site-item ${selected === site.id ? 'selected' : ''}`} key={site.id} onClick={() => onSelect(site.id)}><span><strong>{site.scope.homepage}</strong><small>{date(site.created_at)} · {site.id.slice(0, 8)}</small></span><span>{label(site.state)} <span aria-hidden="true">↗</span></span></button>)}
    </section>
    <p className="fine">Snapshot collection is free during the pilot. Up to two pending/active snapshots and three submissions per day per account. Agent-review pricing is shown before you start. Raw evidence expires after seven days; scope and status remain in your history.</p>
    {creating && <NewSite csrf={csrf} onCreated={site => { sites.refresh(); onSelect(site.id); }} onClose={() => setCreating(false)} />}
  </>;
}
