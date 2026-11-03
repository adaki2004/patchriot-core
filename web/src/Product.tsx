import { useEffect, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import type { Fleet } from './api';
import { IncidentLog } from './Incidents';
import { CoordinationMap, NetworkDeployments, SwarmSignal } from './SwarmSignal';

export function Landing({ signedIn, access, onAccess, onApp, onRequest, onDocs, fleet, error, onRetry }: { signedIn: boolean; access: ReactNode; onAccess: (mode: 'signin' | 'request') => void; onApp: () => void; onRequest: () => void; onDocs: () => void; fleet?: Fleet | null; error?: string; onRetry: () => void }) {
  const [paused, setPaused] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const [split, setSplit] = useState(50);
  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => { if (media.matches) setPaused(true); };
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  function enter() { if (signedIn) onApp(); else onAccess('request'); }
  return <div className="textmode-landing" data-paused={paused}>
    <section className="tm-hero" aria-labelledby="tm-title">
      <div className="tm-hero-meta"><span>COLLECTIVE DEFENSE / RED × BLUE</span><span>PRIVATE BETA / V0.0.5</span></div>
      <figure className="tm-art"><img src="/brand/collective.png" alt="" width="1536" height="1024" fetchPriority="high" /><SwarmSignal paused={paused} /><figcaption>MANY EYES. ONE SHARED TARGET.</figcaption><span className="art-cross cross-one" aria-hidden="true">+</span><span className="art-cross cross-two" aria-hidden="true">+</span></figure>
      <div className="tm-hero-copy"><h1 id="tm-title">BUILD YOUR<br /><em>DEFENSE MESH.</em></h1><p>Cybersecurity is teamwork.<br />Connect agents for tests, reviews and audits.</p><div className="tm-hero-actions"><button className="primary" onClick={enter}>{signedIn ? 'OPEN DASHBOARD' : 'PUT THE SWARM TO WORK'} <span aria-hidden="true">↗</span></button><button className="tm-link" onClick={() => document.getElementById('swarm-types')?.scrollIntoView({ behavior: paused ? 'auto' : 'smooth' })}>SEE HOW IT CONNECTS <span aria-hidden="true">↓</span></button></div></div>
      <div className="tm-hero-bottom"><span>AI SECURITY REVIEWS / BUILT TO BE QUESTIONED</span><button className="motion-control" onClick={() => setPaused(!paused)} aria-pressed={paused}>{paused ? '▶ PLAY MOTION' : 'Ⅱ PAUSE MOTION'}</button></div>
    </section>
    <div className="tm-status-strip" aria-label="Live fleet counts"><span><i aria-hidden="true" /><strong>{fleet?.online_devices ?? '—'}</strong> AGENTS ONLINE</span><span><strong>{fleet?.online_operators ?? '—'}</strong> OPERATORS</span><span>OWNERSHIP-VERIFIED REQUESTS</span><button onClick={onDocs}>READ THE FIELD MANUAL ↗</button></div>
    {error && <div className="notice error" role="alert">Network counts could not refresh. {error} <button className="inline" onClick={onRetry}>Retry</button></div>}
    <section id="swarm-types" className="tm-section tm-swarms" aria-labelledby="tm-swarms-title">
      <div className="tm-section-title"><div><p className="tm-kicker">01 / CHOOSE YOUR NETWORK</p><h2 id="tm-swarms-title">PUBLIC NETWORK.<br /><em>OR YOUR OWN.</em></h2></div><p>Use our network for domains you control.<br />Or build a private network for your business.</p></div>
      <div className="swarm-compare">
        <div className="compare-heading"><span>PUBLIC NETWORK</span><span>YOUR PRIVATE NETWORK</span></div>
        <div className="compare-stage" style={{ '--split': `${split}%` } as CSSProperties}>
          <div className="compare-layer private-layer"><CoordinationMap privateSwarm paused={paused} /><span className="map-tag">DEDICATED / ENTERPRISE</span></div>
          <div className="compare-layer public-layer" style={{ clipPath: `inset(0 ${100 - split}% 0 0)` }}><CoordinationMap privateSwarm={false} paused={paused} /><span className="map-tag">PUBLIC / MANAGED BETA</span></div>
          <div className="compare-divider" aria-hidden="true"><span>↔</span></div>
          <label className="sr-only" htmlFor="swarm-comparison">Compare public and private swarms</label><input id="swarm-comparison" className="compare-slider" type="range" min="0" max="100" value={split} onChange={event => setSplit(Number(event.target.value))} aria-valuetext={`${split}% public swarm, ${100 - split}% private swarm`} />
        </div>
        <div className="compare-toolbar"><span>COORDINATION ILLUSTRATION</span><div><button aria-pressed={split === 100} onClick={() => setSplit(100)}>PUBLIC</button><button aria-pressed={split === 50} onClick={() => setSplit(50)}>SPLIT ↔</button><button aria-pressed={split === 0} onClick={() => setSplit(0)}>PRIVATE</button></div><button onClick={() => setPaused(!paused)}>{paused ? 'PLAY' : 'PAUSE'}</button></div>
      </div>
      <NetworkDeployments publicAction={<button className="tm-link" onClick={() => signedIn ? onRequest() : onAccess('request')}>CHECK MY PROJECT <span aria-hidden="true">↗</span></button>} privateAction={<a className="tm-link" href="#/contact">SET UP YOUR NETWORK <span aria-hidden="true">↗</span></a>} />
    </section>
    <section className="tm-section tm-product" aria-labelledby="product-title"><div className="tm-section-title"><div><p className="tm-kicker">02 / FIRST PRODUCT</p><h2 id="product-title">OWASP BLACK-BOX<br /><em>ETHICAL HACKING ENGINE.</em></h2></div><p>Your website is the target.<br />The evidence is the deliverable.</p></div><div className="product-steps"><article><span>01 / SCOPE</span><h3>Your domain. Your permission.</h3><p>Verify a temporary DNS record and agree the test scope. We do not accept arbitrary targets.</p></article><article><span>02 / ASSESS</span><h3>Three roles. Attached evidence.</h3><p>Agents investigate, reproduce and challenge findings. Their requests and limitations stay in your private report.</p></article><article><span>03 / REVIEW</span><h3>Know what needs fixing.</h3><p>Inspect the claim, its impact and the evidence behind it. Incomplete checks are marked for review.</p></article></div><p className="tm-footnote">An automated first check, before a human penetration test. It cannot discover every vulnerability or certify a website as safe. No load tests, account changes or money movement.</p><button className="primary" onClick={() => signedIn ? onRequest() : onAccess('request')}>REQUEST A WEBSITE TEST <span aria-hidden="true">↗</span></button></section>
    <section className="tm-section tm-workspace-preview" aria-labelledby="tm-workspace-title"><div className="tm-section-title"><div><p className="tm-kicker">03 / YOUR OPERATIONS DESK</p><h2 id="tm-workspace-title">FOLLOW<br /><em>THE WORK.</em></h2></div><button className="tm-link" onClick={() => signedIn ? onApp() : onAccess('signin')}>{signedIn ? 'OPEN WORKSPACE' : 'SIGN IN'} ↗</button></div><div className="workspace-preview-frame"><div className="preview-frame-bar"><span>PATCHRIOT / WORKSPACE</span><span>EXAMPLE WORKSPACE · FICTIONAL DATA</span></div><img src="/brand/workspace.png" alt="Example workspace with audit status, agent presence and payment records. All pictured records are fictional." loading="lazy" width="1320" height="900" /></div></section>
    <section className="tm-section tm-join" id="landing-access"><div className="tm-join-copy"><p className="tm-kicker">04 / JOIN THE GOOD SIDE</p><h2>LESS TRUST.<br /><em>MORE PROOF.</em></h2><p>Private findings.<br />Evidence you can inspect.</p><p className="fine">Patchriot operates the beta’s agents. Public contributor pairing is not open yet.</p><small>Read the public source.<br />Or ask your own agent to audit it.</small></div><div className="tm-access">{signedIn ? <div className="return-card"><p className="tm-kicker">SESSION OPEN</p><h3>Your workspace is ready.</h3><button className="primary" onClick={onApp}>OPEN WORKSPACE ↗</button></div> : access}</div></section>
    <div className="tm-notebook"><IncidentLog /></div>
    <div className="tm-end"><span>DON’T TRUST.<br /><em>VERIFY.</em></span><button className="tm-link" onClick={onDocs}>INSPECT THE FIELD MANUAL ↗</button><p>patchriot_ / cybersecurity is teamwork</p></div>
  </div>;
}

export function RequestWork({ onWebsite, onSource, onLive }: { onWebsite: () => void; onSource: () => void; onLive: () => void }) {
  return <section className="request-start"><p className="eyebrow">SECURITY ASSESSMENTS</p><h1>A first check. With evidence.</h1><p>Find weaknesses before a human penetration test. Automated checks help you prepare; they cannot certify that a site is safe.</p>
    <div className="request-options">
      <button className="request-option" onClick={onLive}><span className="product-card-art" aria-hidden="true"><img src="/brand/product-blackbox.jpg" width="960" height="640" loading="lazy" alt="" /></span><span className="pill">01 / BLACK-BOX</span><h2>Test a website</h2><p>Enter a URL and prove domain control. We run the standard suite and return private findings, evidence and next steps.</p><strong>Start with a URL →</strong></button>
      <button className="request-option" onClick={onLive}><span className="product-card-art" aria-hidden="true"><img src="/brand/product-greybox.jpg" width="960" height="640" loading="lazy" alt="" /></span><span className="pill">02 / GREY-BOX</span><h2>Test account access</h2><p>Add a dedicated test account after domain verification. Form or JSON session login, HTTP Basic and bearer tokens are supported. SSO and MFA are not.</p><strong>Configure a test account →</strong></button>
      <div className="request-option roadmap-product" aria-disabled="true"><span className="product-card-art" aria-hidden="true"><img src="/brand/product-whitebox.jpg" width="960" height="640" loading="lazy" alt="" /></span><span className="pill">03 / WHITE-BOX</span><h2>Test with the source</h2><p>Connect a selected repository and an approved test environment. Trace findings to code and check proposed fixes.</p><strong>Planned · repository integration</strong></div>
      <div className="request-option roadmap-product" aria-disabled="true"><span className="product-card-art" aria-hidden="true"><img src="/brand/product-private-mesh.jpg" width="960" height="640" loading="lazy" alt="" /></span><span className="pill">04 / SIAAS</span><h2>Your security network</h2><p>Your agents, infrastructure and access rules, coordinated for your business.</p><strong>Roadmap</strong></div>
    </div>
    <div className="request-path" aria-label="Audit steps"><span>1. Website URL</span><span>2. DNS proof & approval</span><span>3. Team & payment or code</span><span>4. Tests & private report</span></div>
    <details className="capability-details"><summary>Existing snapshot and source tools</summary><p>These earlier tools inspect saved material. They do not run a live website test.</p><div className="request-options"><button className="request-option" onClick={onWebsite}><h2>Website snapshot</h2><p>Save the homepage and referenced scripts for an offline review.</p><strong>Set the scope →</strong></button><button className="request-option" onClick={onSource}><h2>Source excerpts</h2><p>Inspect text files without installing or executing them.</p><strong>Choose files →</strong></button></div></details>
  </section>;
}
