import { useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import type { Fleet } from './api';
import { IncidentLog } from './Incidents';
import { CoordinationMap } from './SwarmSignal';

/** A convenience for the URL field, not permission to test. The server checks the target and DNS proof. */
export function websiteOrigin(value: string): string {
  const input = value.trim();
  const url = new URL(input.includes('://') ? input : 'https://' + input);
  if (!input || input.length > 4096 || url.protocol !== 'https:' || url.username || url.password || url.port || url.hash || !url.hostname.includes('.') || /^[\d.]+$/.test(url.hostname)) throw new Error('Enter a domain or public HTTPS URL, without credentials or a custom port.');
  return url.origin;
}

export type AssessmentMode = 'black' | 'grey';

function AssessmentModes({ onSelect }: { onSelect?: (mode: AssessmentMode) => void }) {
  return <div className="assessment-modes">
    {([
      { mode: 'black', label: 'BLACK-BOX', title: 'Public pages', description: 'Public pages, APIs and exposed configuration. Just your URL.', action: 'Choose black-box', art: 'blackbox' },
      { mode: 'grey', label: 'GREY-BOX', title: 'Behind the login', description: 'Public checks plus signed-in access. Add a test account or API token.', action: 'Choose grey-box', art: 'greybox' },
      { mode: 'white', label: 'WHITE-BOX', title: 'Code + application', description: 'Trace findings back to source code. Repository access is on the roadmap.', action: 'Coming later', art: 'whitebox' },
    ] as const).map(item => {
      const content = <><img src={`/brand/product-${item.art}.jpg`} alt="" width="960" height="640" loading="lazy" /><div className="assessment-mode-copy"><span className="assessment-mode-label">{item.label}</span><h3>{item.title}</h3><p>{item.description}</p>{onSelect && <strong>{item.action}{item.mode !== 'white' && ' →'}</strong>}{!onSelect && item.mode === 'white' && <strong>Coming later</strong>}</div></>;
      return onSelect && item.mode !== 'white' ? <button type="button" key={item.mode} className="assessment-mode" aria-label={item.action} onClick={() => onSelect(item.mode)}>{content}</button> : <article key={item.mode} className={`assessment-mode${item.mode === 'white' ? ' roadmap-product' : ''}`}>{content}</article>;
    })}
  </div>;
}

export function Landing({ signedIn, access, onAccess, onApp, onRequest, onDocs, fleet, error, onRetry }: { signedIn: boolean; access: ReactNode; onAccess: (mode: 'signin' | 'request') => void; onApp: () => void; onRequest: (website?: string) => void; onDocs: () => void; fleet?: Fleet | null; error?: string; onRetry: () => void }) {
  const [website, setWebsite] = useState('');
  const [websiteError, setWebsiteError] = useState('');
  function startWebsite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    try { const origin = websiteOrigin(website); setWebsiteError(''); onRequest(origin); }
    catch { setWebsiteError('Enter a domain or public HTTPS URL, without credentials or a custom port.'); }
  }
  return <div className="textmode-landing">
    <section className="exposure-hero" aria-labelledby="exposure-title">
      <div className="exposure-art" aria-hidden="true"><img src="/brand/exposure-hero.png" alt="" width="1536" height="1024" fetchPriority="high" /></div>
      <div className="exposure-copy"><p className="exposure-eyebrow"><span aria-hidden="true" />WEB APPLICATION SECURITY TESTING</p><h1 id="exposure-title">Security testing.<br /><em>Just your URL.</em></h1><p className="exposure-description">Our agents test your site. You get a private report with evidence and what to fix.</p><p className="exposure-install">Nothing to install. Just your URL — plus a test account for grey-box checks.</p>
        <form className="exposure-form" onSubmit={startWebsite}>
          <label htmlFor="landing-website">A domain you own</label>
          <div className="exposure-input"><span aria-hidden="true">↗</span><input id="landing-website" name="website" type="text" inputMode="url" autoCapitalize="none" autoCorrect="off" spellCheck={false} required maxLength={4096} placeholder="your-website.com" value={website} aria-invalid={!!websiteError} aria-describedby={websiteError ? 'landing-website-error landing-website-help' : 'landing-website-help'} onChange={event => { setWebsite(event.target.value); setWebsiteError(''); }} /><button type="submit">Start a test <span aria-hidden="true">→</span></button></div>
          <p id="landing-website-help">We’ll verify ownership before testing.</p>
          {websiteError && <p id="landing-website-error" className="exposure-error" role="alert">{websiteError}</p>}
        </form>
      </div>
    </section>
    <div className="exposure-route" aria-label="Assessment steps"><span><b>01</b> Add your URL</span><i aria-hidden="true">→</i><span><b>02</b> Verify ownership</span><i aria-hidden="true">→</i><span><b>03</b> Get the report</span></div>
    <div className="tm-status-strip" aria-label="Live fleet counts"><span><i aria-hidden="true" /><strong>{fleet?.online_devices ?? '—'}</strong> AGENTS ONLINE</span><span><strong>{fleet?.online_operators ?? '—'}</strong> OPERATORS</span><span>OWNERSHIP-VERIFIED REQUESTS</span><button onClick={onDocs}>READ THE FIELD MANUAL ↗</button></div>
    {error && <div className="notice error" role="alert">Network counts could not refresh. {error} <button className="inline" onClick={onRetry}>Retry</button></div>}
    <section className="tm-inference" aria-labelledby="inference-title"><div><p className="tm-kicker">NEAR AI / PRIVATE TEE</p><h2 id="inference-title">Private inference.<br /><em>Verifiable execution.</em></h2></div><div><p>Our Hermes agents use <strong>DeepSeek V4.1 Flash Abliterated</strong> inside NEAR AI’s private, hardware-protected inference environment. The relay encrypts model requests and verifies the response before the agent acts on it.</p><p className="fine">Hermes agents run in isolated containers on our Kali Linux servers. NEAR protects their model inference. Any Venice recovery is named at checkout and in your report.</p><a className="tm-link" href="#/docs/privacy">HOW PRIVATE INFERENCE WORKS ↗</a></div></section>
    <section id="swarm-types" className="tm-section tm-swarms" aria-labelledby="tm-swarms-title">
      <div className="tm-section-title"><div><p className="tm-kicker">01 / TWO WAYS TO WORK</p><h2 id="tm-swarms-title">WE RUN IT.<br /><em>OR BUILD IT FOR YOU.</em></h2></div><p>Use our managed testing service.<br />Or discuss a dedicated installation for your business.</p></div>
      <div className="service-flow"><CoordinationMap /><div className="flow-actions"><button className="tm-link" onClick={() => onRequest()}>TEST MY WEB APP ↗</button><a className="tm-link" href="#/contact">DISCUSS A DEDICATED SETUP ↗</a></div></div>
    </section>
    <section className="tm-section tm-product" aria-labelledby="product-title"><div className="tm-section-title"><div><p className="tm-kicker">02 / CHOOSE YOUR ACCESS</p><h2 id="product-title">YOUR WEB APP.<br /><em>UNDER REVIEW.</em></h2></div><p>Choose how much access to provide.<br />Every test returns a private report.</p></div><AssessmentModes /><p className="tm-footnote">Your systems only. Verify domain ownership before checkout. An automated first check, before a human penetration test; it cannot discover every vulnerability or certify a website as safe.</p><button className="primary" onClick={() => onRequest()}>REQUEST A WEB APP TEST <span aria-hidden="true">↗</span></button></section>
    <section className="tm-section tm-workspace-preview" aria-labelledby="tm-workspace-title"><div className="tm-section-title"><div><p className="tm-kicker">03 / YOUR OPERATIONS DESK</p><h2 id="tm-workspace-title">YOUR CONSOLE,<br /><em>AT A GLANCE.</em></h2></div><button className="tm-link" onClick={() => signedIn ? onApp() : onAccess('signin')}>{signedIn ? 'OPEN WORKSPACE' : 'SIGN IN'} ↗</button></div><div className="workspace-preview-frame"><div className="preview-frame-bar"><span>PATCHRIOT / WORKSPACE</span><span>EXAMPLE WORKSPACE · FICTIONAL DATA</span></div><img src="/brand/workspace.png" alt="Example workspace with audit status, agent presence and payment records. All pictured records are fictional." loading="lazy" width="1320" height="900" /></div></section>
    <section className="tm-section tm-join" id="landing-access"><div className="tm-join-copy"><p className="tm-kicker">04 / JOIN THE GOOD SIDE</p><h2>LESS TRUST.<br /><em>MORE PROOF.</em></h2><p>Private findings.<br />Evidence you can inspect.</p><p className="fine">We operate the testing agents. Public machines cannot join this service.</p><small>Read the public source.<br />Or ask your own agent to audit it.</small></div><div className="tm-access">{signedIn ? <div className="return-card"><p className="tm-kicker">SESSION OPEN</p><h3>Your workspace is ready.</h3><button className="primary" onClick={onApp}>OPEN WORKSPACE ↗</button></div> : access}</div></section>
    <div className="tm-notebook"><IncidentLog /></div>
    <div className="tm-end"><span>DON’T TRUST.<br /><em>VERIFY.</em></span><button className="tm-link" onClick={onDocs}>INSPECT THE FIELD MANUAL ↗</button><p>patchriot_ / cybersecurity is teamwork</p></div>
  </div>;
}

export function RequestWork({ website, onSelect }: { website?: string; onSelect: (mode: AssessmentMode) => void }) {
  return <section className="request-start"><p className="eyebrow">NEW SECURITY TEST</p><h1>Choose your test.</h1><p>Public pages, or a closer look behind the login. Nothing to install.</p>
    {website && <p className="request-website"><span>YOUR WEBSITE</span><strong>{website}</strong><small>You can change this on the next step.</small></p>}
    <AssessmentModes onSelect={onSelect} />
    <p className="request-ownership">You must own the domain. Verify it with a DNS record before payment or testing.</p>
    <p className="fine">Need your own infrastructure? <a href="#/contact">Discuss a dedicated setup →</a></p>
  </section>;
}
