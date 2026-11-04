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
      <div className="exposure-copy"><p className="exposure-eyebrow"><span aria-hidden="true" />WEB APPLICATION SECURITY TESTING</p><h1 id="exposure-title">Security testing.<br /><em>Just your URL.</em></h1><p className="exposure-description">Our agents test your site. You get a private report with evidence and what to fix.</p>
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
      <div className="service-flow"><CoordinationMap /><div className="flow-actions"><button className="tm-link" onClick={() => signedIn ? onRequest() : onAccess('request')}>TEST MY WEB APP ↗</button><a className="tm-link" href="#/contact">DISCUSS A DEDICATED SETUP ↗</a></div></div>
    </section>
    <section className="tm-section tm-product" aria-labelledby="product-title"><div className="tm-section-title"><div><p className="tm-kicker">02 / FIRST PRODUCT</p><h2 id="product-title">YOUR WEB APP.<br /><em>UNDER REVIEW.</em></h2></div><p>Your web application is the target.<br />The evidence is the deliverable.</p></div><div className="product-steps"><article><span>01 / SCOPE</span><h3>Your domain. Your permission.</h3><p>Only test systems you own and control. Verify a temporary DNS record before checkout. Testing someone else’s domain is not allowed.</p></article><article><span>02 / ASSESS</span><h3>Investigate. Verify. Challenge.</h3><p>Scout finds leads. Recon checks them. A third agent challenges serious or uncertain findings. The evidence stays in your report.</p></article><article><span>03 / REVIEW</span><h3>Know what needs fixing.</h3><p>Inspect the claim, its impact and the evidence behind it. Incomplete checks are marked for review.</p></article></div><p className="tm-footnote">An automated first check, before a human penetration test. It cannot discover every vulnerability or certify a website as safe. No load tests, account changes or money movement.</p><button className="primary" onClick={() => signedIn ? onRequest() : onAccess('request')}>REQUEST A WEB APP TEST <span aria-hidden="true">↗</span></button></section>
    <section className="tm-security-homework"><p className="tm-kicker">THE TESTING SCOPE</p><h2>What we check.</h2><p>Public pages, APIs and exposed configuration. With a dedicated test account, we also check account access. Your report records the evidence and any checks left unfinished.</p><p className="fine">Use a running website or staging environment you own. Source-code review is separate. <a href="#/docs/workflow">What a review includes ↗</a></p></section>
    <section className="tm-section tm-workspace-preview" aria-labelledby="tm-workspace-title"><div className="tm-section-title"><div><p className="tm-kicker">03 / YOUR OPERATIONS DESK</p><h2 id="tm-workspace-title">YOUR CONSOLE,<br /><em>AT A GLANCE.</em></h2></div><button className="tm-link" onClick={() => signedIn ? onApp() : onAccess('signin')}>{signedIn ? 'OPEN WORKSPACE' : 'SIGN IN'} ↗</button></div><div className="workspace-preview-frame"><div className="preview-frame-bar"><span>PATCHRIOT / WORKSPACE</span><span>EXAMPLE WORKSPACE · FICTIONAL DATA</span></div><img src="/brand/workspace.png" alt="Example workspace with audit status, agent presence and payment records. All pictured records are fictional." loading="lazy" width="1320" height="900" /></div></section>
    <section className="tm-section tm-join" id="landing-access"><div className="tm-join-copy"><p className="tm-kicker">04 / JOIN THE GOOD SIDE</p><h2>LESS TRUST.<br /><em>MORE PROOF.</em></h2><p>Private findings.<br />Evidence you can inspect.</p><p className="fine">We operate the testing agents. Public machines cannot join this service.</p><small>Read the public source.<br />Or ask your own agent to audit it.</small></div><div className="tm-access">{signedIn ? <div className="return-card"><p className="tm-kicker">SESSION OPEN</p><h3>Your workspace is ready.</h3><button className="primary" onClick={onApp}>OPEN WORKSPACE ↗</button></div> : access}</div></section>
    <div className="tm-notebook"><IncidentLog /></div>
    <div className="tm-end"><span>DON’T TRUST.<br /><em>VERIFY.</em></span><button className="tm-link" onClick={onDocs}>INSPECT THE FIELD MANUAL ↗</button><p>patchriot_ / cybersecurity is teamwork</p></div>
  </div>;
}

export function RequestWork({ onLive }: { onWebsite: () => void; onSource: () => void; onLive: () => void }) {
  return <section className="request-start"><p className="eyebrow">SECURITY ASSESSMENTS</p><h1>A first check. With evidence.</h1><p>Find weaknesses before a human penetration test. Automated checks help you prepare; they cannot certify that a site is safe.</p><p className="request-ownership"><strong>Your systems only.</strong> You must own and control the target domain. DNS verification is required before checkout; payment never grants permission to test someone else.</p>
    <div className="request-options">
      <button className="request-option" onClick={onLive}><span className="product-card-art" aria-hidden="true"><img src="/brand/product-blackbox.jpg" width="960" height="640" loading="lazy" alt="" /></span><span className="pill">01 / BLACK-BOX</span><h2>Test a web application</h2><p>Enter a URL and prove domain control. We run the standard suite and return private findings, evidence and next steps.</p><strong>Start with a URL →</strong></button>
      <button className="request-option" onClick={onLive}><span className="product-card-art" aria-hidden="true"><img src="/brand/product-greybox.jpg" width="960" height="640" loading="lazy" alt="" /></span><span className="pill">02 / GREY-BOX</span><h2>Test account access</h2><p>Add a dedicated test account after domain verification. Form or JSON session login, HTTP Basic and bearer tokens are supported. SSO and MFA are not.</p><strong>Configure a test account →</strong></button>
      <div className="request-option roadmap-product" aria-disabled="true"><span className="product-card-art" aria-hidden="true"><img src="/brand/product-whitebox.jpg" width="960" height="640" loading="lazy" alt="" /></span><span className="pill">03 / WHITE-BOX</span><h2>Test with the source</h2><p>Connect a selected repository and an approved test environment. Trace findings to code and check proposed fixes.</p><strong>Planned · repository integration</strong></div>
      <div className="request-option roadmap-product" aria-disabled="true"><span className="product-card-art" aria-hidden="true"><img src="/brand/product-private-mesh.jpg" width="960" height="640" loading="lazy" alt="" /></span><span className="pill">04 / SIAAS</span><h2>A dedicated installation</h2><p>Separate infrastructure and agreed access rules for your business.</p><strong>By arrangement</strong></div>
    </div>
    <div className="request-path" aria-label="Audit steps"><span>1. Website URL</span><span>2. Verify domain ownership</span><span>3. Team & payment or code</span><span>4. Tests & private report</span></div>
    <p className="fine">Existing snapshots and source-text reports remain in <a href="#/audits">Audits</a>. New source-assisted testing is on the roadmap.</p>
  </section>;
}
