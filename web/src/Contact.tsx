import { useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { api, write } from './api';
import { useLive } from './useLive';

export function EnterpriseContact() {
  const contact = useLive<{ email: string | null }>('/contact', true, 300_000);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');
  const attempt = useRef<{ id: string; body: string } | null>(null);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError('');
    const fields = new FormData(event.currentTarget);
    const payload = { name: fields.get('name'), email: fields.get('email'), organization: fields.get('organization'), message: fields.get('message') };
    const body = JSON.stringify(payload);
    if (attempt.current?.body !== body) attempt.current = { id: crypto.randomUUID(), body };
    try {
      await api('/contact', { method: 'POST', body: JSON.stringify({ ...payload, request_id: attempt.current!.id }) });
      setSent(true);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  return <section className="enterprise-contact">
    <div className="enterprise-intro"><img src="/brand/collective.png" alt="" width="1536" height="1024" /><p className="eyebrow">DEDICATED / BUSINESS & ENTERPRISE</p><h1>Your application.<br />A dedicated setup.</h1><p>Tell us what you want to test and where the agents should run. We’ll discuss a separate installation for your organization.</p><p>Agreed operator access, isolated Kali environments, private model inference and report storage.</p></div>
    <div className="panel contact-form"><p className="eyebrow">LET’S TALK</p><h2>Plan your network.</h2>
      {sent ? <div role="status"><h3>Inquiry received.</h3><p>Your message is saved in our private staff inbox. We’ll review it and use your email to get back to you. This does not create an account or start a test.</p><a className="text-button" href="#/home">Back to Patchriot →</a></div> : <form onSubmit={submit}>
        <label>Your name<input name="name" autoComplete="name" maxLength={80} required disabled={busy} /></label>
        <label>Work email<input name="email" type="email" autoComplete="email" maxLength={254} required disabled={busy} /></label>
        <label>Company or team<input name="organization" autoComplete="organization" maxLength={160} required disabled={busy} /></label>
        <label>What do you need?<textarea name="message" minLength={20} maxLength={3000} rows={5} required disabled={busy} placeholder="Your systems, preferred hosting, and the checks your team needs." /></label>
        <p className="fine">Only Patchriot staff can read this inquiry. Leave out passwords, private keys and confidential findings.</p>
        {error && <p className="notice error" role="alert">{error}</p>}
        <button className="primary full" disabled={busy}>{busy ? 'Saving inquiry…' : 'Send inquiry →'}</button>
      </form>}
      {contact.data?.email && <p className="contact-email">Prefer email? <a href={`mailto:${encodeURIComponent(contact.data.email)}`}>{contact.data.email}</a></p>}
    </div>
  </section>;
}

type Inquiry = { id: string; name: string; email: string; organization: string; message: string; state: 'open' | 'handled'; created_at: string; updated_at: string };

export function ContactInbox({ csrf }: { csrf: string }) {
  const inbox = useLive<Inquiry[]>('/admin/inquiries');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  async function decide(item: Inquiry) {
    setBusy(item.id); setError('');
    try { await write(`/admin/inquiries/${item.id}`, csrf, { handled: item.state === 'open' }); inbox.refresh(); }
    catch (e) { setError((e as Error).message); } finally { setBusy(null); }
  }
  return <section className="contact-inbox"><div className="section-heading"><div><p className="eyebrow">ADMINISTRATION / ENTERPRISE</p><h1 className="page-title">Contact inbox.</h1><p>Up to 100 inquiries, with open requests first. Replies are handled outside this inbox.</p></div><button className="quiet" onClick={inbox.refresh}>Refresh ↻</button></div>
    {(inbox.error || error) && <p className="notice error" role="alert">{error || inbox.error}</p>}
    {!inbox.data && !inbox.error && <p role="status">Loading inquiries…</p>}
    {inbox.data?.length === 0 && <p className="panel empty">No enterprise inquiries yet.</p>}
    {inbox.data?.map(item => <article className="panel inquiry" key={item.id}>
      <div className="section-heading"><div><p className="eyebrow">{item.state === 'open' ? 'NEEDS A REPLY' : 'HANDLED'} · {new Date(item.created_at).toLocaleDateString()}</p><h2>{item.organization}</h2><p>{item.name} · <a href={`mailto:${encodeURIComponent(item.email)}`}>{item.email}</a></p></div><button className="quiet" disabled={Boolean(busy) || Boolean(inbox.error)} onClick={() => void decide(item)}>{busy === item.id ? 'Saving…' : item.state === 'open' ? 'Mark handled' : 'Reopen'}</button></div>
      <p className="inquiry-message">{item.message}</p>
    </article>)}
  </section>;
}
