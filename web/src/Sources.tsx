import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { write } from './api';
import { useLive } from './useLive';
import { useDialog } from './useDialog';
import { WebsiteReviewSetup } from './WebsiteReview';
import type { Deposit } from './Checkout';

type FileInput = { path: string; text: string };
type Source = { id: string; title: string; objective: string; permission_note: string; state: string; bundle_sha256: string; files: { path: string; bytes: number; sha256: string }[]; created_at: number; expires_at: number; decision_note: string | null; can_delete: boolean };
const labels: Record<string, string> = { pending_approval: 'Awaiting approval', approved: 'Ready for review', rejected: 'Not approved', deleted: 'Files deleted', expired: 'Files expired' };
const label = (state: string) => labels[state] ?? state;
const extensions = '.rs,.py,.js,.ts,.jsx,.tsx,.sol,.go,.java,.c,.h,.cpp,.cs,.rb,.php,.vue,.svelte,.html,.css,.json,.toml,.yaml,.yml,.md,.txt,.sh';

function NewSource({ csrf, onCreated, onClose }: { csrf: string; onCreated: (id: string) => void; onClose: () => void }) {
  const dialog = useDialog('input[name="title"]');
  const requestId = useRef(crypto.randomUUID());
  const [files, setFiles] = useState<FileInput[]>([]);
  const [busy, setBusy] = useState(false);
  const [reading, setReading] = useState(false);
  const [error, setError] = useState('');
  const active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  async function choose(selected: FileList | null) {
    setFiles([]); setError(''); setReading(true); requestId.current = crypto.randomUUID();
    try {
      const picked = Array.from(selected ?? []);
      if (!picked.length || picked.length > 12) throw new Error('Choose 1–12 source files.');
      if (picked.some(file => file.size > 16 * 1024) || picked.reduce((sum, file) => sum + file.size, 0) > 48 * 1024) throw new Error('Use at most 16 KiB per file and 48 KiB altogether. Start with the code relevant to your question.');
      if (new Set(picked.map(file => file.name.toLowerCase())).size !== picked.length) throw new Error('Each filename must be different.');
      const data = await Promise.all(picked.map(async file => {
        if (!/^[a-zA-Z0-9_-][a-zA-Z0-9._-]*\.[a-zA-Z0-9]+$/.test(file.name) || !extensions.split(',').includes(`.${file.name.split('.').at(-1)?.toLowerCase()}`)) throw new Error('Choose plain source files with simple filenames. Archives, hidden files and key files are not accepted.');
        let text: string;
        try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(await file.arrayBuffer()); }
        catch { throw new Error(`${file.name} is not valid UTF-8 text.`); }
        return { path: file.name, text };
      }));
      if (active.current) setFiles(data);
    } catch (error) { if (active.current) setError((error as Error).message); }
    finally { if (active.current) setReading(false); }
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!files.length || reading) return;
    const form = new FormData(event.currentTarget); setBusy(true); setError('');
    try {
      const source = await write<Source>('/sources', csrf, { request_id: requestId.current, title: form.get('title'), objective: form.get('objective'), permission_note: form.get('permission'), accepts_private_storage: form.get('storage') === 'on', files });
      if (active.current) { onCreated(source.id); onClose(); }
    } catch (error) { if (active.current) setError((error as Error).message); }
    finally { if (active.current) setBusy(false); }
  }
  return <dialog ref={dialog} aria-labelledby="new-source-title" onCancel={event => { if (busy) event.preventDefault(); else onClose(); }}>
    <button className="close" aria-label="Close source upload" disabled={busy} onClick={onClose}>×</button>
    <p className="eyebrow">PRIVATE SOURCE REVIEW</p><h2 id="new-source-title">Bring the relevant code.</h2><p>Start with a small module and a clear question. Files are stored privately for seven days; they are not installed or run.</p>
    <form className="site-form" onSubmit={submit} onChange={() => { requestId.current = crypto.randomUUID(); }}><fieldset disabled={busy}>
      <label>Title<input name="title" required maxLength={120} placeholder="For example: record access rules" /></label>
      <label>What should the agents check?<textarea name="objective" required maxLength={1200} rows={3} placeholder="Describe the behavior and what you want checked." /></label>
      <label>Your permission to share this code<textarea name="permission" required maxLength={1500} rows={2} placeholder="I wrote this code, or have permission from…" /></label>
      <label>Source files<input type="file" aria-label="Source files" multiple accept={extensions} disabled={reading} onChange={event => void choose(event.target.files)} /><small>1–12 UTF-8 files. At most 16 KiB each, 48 KiB total. No ZIPs, binaries, hidden files or credentials.</small></label>
      {reading && <p role="status">Reading selected files…</p>}
      {files.length > 0 && <ul className="source-files">{files.map(file => <li key={file.path}><code>{file.path}</code><span>{new TextEncoder().encode(file.text).length.toLocaleString()} bytes</span></li>)}</ul>}
      <label className="check"><input type="checkbox" name="storage" required /><span>I have permission to share these files with Patchriot staff, and have removed secrets and unrelated personal data. I will confirm the agent team separately.</span></label>
      <p className="fine">Manual scope approval comes first. The review uses source excerpts; long files may be shortened and that limit stays visible. This version does not build, run or test the code. Reports may retain short quotations after the upload is removed.</p>
      {error && <div className="notice error" role="alert">{error}</div>}
      <button className="primary full" disabled={busy || reading || !files.length}>{busy ? 'Uploading…' : 'Upload for approval →'}</button>
    </fieldset></form>
  </dialog>;
}

function SourceDetail({ id, csrf, admin, onClose, onChange, onReview, onCheckout }: { id: string; csrf: string; admin: boolean; onClose: () => void; onChange: () => void; onReview: (id: string) => void; onCheckout: (quote: Deposit) => void }) {
  const panel = useRef<HTMLElement>(null);
  const detail = useLive<Source>(`/sources/${id}`);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [decision, setDecision] = useState('');
  const [reviewing, setReviewing] = useState(false);
  const source = detail.data;
  useEffect(() => { panel.current?.focus({ preventScroll: true }); panel.current?.scrollIntoView({ block: 'start' }); }, [id]);
  useEffect(() => { if (source) onChange(); }, [source?.state, onChange]);
  async function decide(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = new FormData(event.currentTarget); setBusy(true); setError('');
    try { await write(`/sources/${id}/decision`, csrf, { approve: decision === 'approve', note: form.get('note') }); detail.refresh(); onChange(); }
    catch (error) { setError((error as Error).message); } finally { setBusy(false); }
  }
  async function remove() {
    if (!window.confirm('Delete the uploaded files and stop unfinished reviews? Existing reports and quotations remain. Data already seen by an operator cannot be recalled.')) return;
    setBusy(true); setError('');
    try { await write(`/sources/${id}/delete`, csrf, {}); setReviewing(false); detail.refresh(); onChange(); }
    catch (error) { setError((error as Error).message); } finally { setBusy(false); }
  }
  const retained = source && ['pending_approval', 'approved'].includes(source.state) && source.expires_at * 1000 > Date.now();
  return <section ref={panel} tabIndex={-1} className="review-detail panel" aria-label="Source upload">
    <div className="section-heading"><div><p className="eyebrow">PRIVATE SOURCE</p><h2>{source?.title ?? (detail.error ? 'Upload unavailable' : 'Loading upload…')}</h2>{source && <span className="pill">{label(source.state)}</span>}</div><button className="quiet" onClick={onClose}>Close upload ×</button></div>
    {(error || detail.error) && <div className="notice error" role="alert">{error || detail.error}<button className="inline" onClick={detail.refresh}>Retry upload</button></div>}
    {source && <>
      <dl className="site-scope"><dt>Requested check</dt><dd>{source.objective}</dd><dt>Permission supplied</dt><dd>{source.permission_note}</dd>{source.decision_note && <><dt>Admin decision</dt><dd>{source.decision_note}</dd></>}</dl>
      <ul className="source-files">{source.files.map(file => <li key={file.path}><code>{file.path}</code><span>{file.bytes.toLocaleString()} bytes</span></li>)}</ul>
      <div className="review-actions"><button className="quiet" onClick={detail.refresh}>Refresh upload ↻</button>{retained && <a className="text-button" href={`/api/sources/${id}/evidence`} download>Download source JSON ↓</a>}{retained && source.can_delete && <button className="quiet" disabled={busy} onClick={() => void remove()}>Delete uploaded files</button>}</div>
      {source.state === 'pending_approval' && <p className="notice">Awaiting manual scope approval. No agent has received these files.</p>}
      {retained && <p className="fine">Files expire {new Date(source.expires_at * 1000).toLocaleString()}. Your request, decision and report history remain.</p>}
      {source.state === 'approved' && source.can_delete && retained && <div className="site-review-cta"><h3>Choose whether to share with the proposed team.</h3><p>Three agents inspect the saved source in sequence. Check their operators and models before confirming.</p><button className="primary" onClick={() => setReviewing(true)}>Prepare source review →</button></div>}
      {admin && source.state === 'pending_approval' && <form className="site-form" onSubmit={decide}><fieldset disabled={busy}><label>Decision<select required value={decision} onChange={event => setDecision(event.target.value)}><option value="" disabled>Choose a decision</option><option value="approve">Approve this exact source</option><option value="reject">Reject and delete files</option></select></label><label>Decision note<textarea name="note" required minLength={8} maxLength={1200} rows={2} /></label><label className="check"><input type="checkbox" required /><span>I checked the requested scope and permission to share this code.</span></label><button className="primary" disabled={busy || !decision}>Record source decision</button></fieldset></form>}
      <details className="execution-details"><summary>Saved fingerprint</summary><code>{source.bundle_sha256}</code><p className="fine">This binds the exact files and objective. Changing either requires a new upload.</p></details>
    </>}
    {reviewing && <WebsiteReviewSetup sourceId={id} csrf={csrf} onCreated={onReview} onCheckout={onCheckout} onClose={() => setReviewing(false)} />}
  </section>;
}

export function Sources({ startNew = false, onStarted, csrf, admin, selected, onSelect, onReview, onCheckout }: { startNew?: boolean; onStarted?: () => void; csrf: string; admin: boolean; selected: string | null; onSelect: (id: string | null) => void; onReview: (id: string) => void; onCheckout: (quote: Deposit) => void }) {
  const sources = useLive<Source[]>('/sources?scope=mine'); const [creating, setCreating] = useState(false);
  useEffect(() => { if (startNew) { setCreating(true); onStarted?.(); } }, [startNew, onStarted]);
  return <>
    <section className="section-heading fleet-heading"><div><p className="eyebrow">PRIVATE WORKSPACE</p><h1 className="page-title">Source reviews</h1><p className="subtle">Share a small module. Ask a precise question. Inspect the evidence.</p></div><button className="primary" onClick={() => setCreating(true)}>Upload source files +</button></section>
    {sources.error && <div className="notice error" role="alert">{sources.error}<button className="inline" onClick={sources.refresh}>Retry</button></div>}
    {selected && <SourceDetail key={selected} id={selected} csrf={csrf} admin={admin} onClose={() => onSelect(null)} onChange={sources.refresh} onReview={onReview} onCheckout={onCheckout} />}
    <section className="panel"><div className="table-toolbar"><strong>{sources.data ? `${sources.data.length} recent uploads` : 'Loading uploads…'}</strong><button className="quiet" onClick={sources.refresh}>Refresh sources ↻</button></div>
      {sources.data?.length === 0 && <div className="empty"><h2>Start with the part that matters.</h2><p>Upload source text and describe what needs checking. Your files stay private.</p></div>}
      {sources.data?.map(source => <button className={`review-item ${selected === source.id ? 'selected' : ''}`} key={source.id} onClick={() => onSelect(source.id)}><span><strong>{source.title}</strong><small>{source.files.length} files · {new Date(source.created_at * 1000).toLocaleString()}</small></span><span>{label(source.state)} ↗</span></button>)}
    </section>
    {creating && <NewSource csrf={csrf} onCreated={id => { sources.refresh(); onSelect(id); }} onClose={() => setCreating(false)} />}
  </>;
}
