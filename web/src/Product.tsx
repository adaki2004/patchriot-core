import { useEffect, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import type { Fleet } from './api';
import { IncidentLog } from './Incidents';
import { CoordinationMap, NetworkDeployments, SwarmSignal } from './SwarmSignal';

export function Landing({ signedIn, access, onAccess, onApp, onRequest, onDocs, onPair, fleet, error, onRetry }: { signedIn: boolean; access: ReactNode; onAccess: (mode: 'signin' | 'request') => void; onApp: () => void; onRequest: () => void; onDocs: () => void; onPair: () => void; fleet?: Fleet | null; error?: string; onRetry: () => void }) {
  const [paused, setPaused] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const [split, setSplit] = useState(50);
  const [role, setRole] = useState(0);
  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => { if (media.matches) setPaused(true); };
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  function enter() { if (signedIn) onApp(); else onAccess('request'); }
  const roles = [
    { name: 'Investigate', verb: 'Find the weak point.', code: '01 / QUESTION', body: 'An agent looks for a concrete issue in the website snapshot or code you share.' },
    { name: 'Reproduce', verb: 'Make it hold up.', code: '02 / CHECK', body: 'A second role checks the claim against the saved material. The evidence stays attached.' },
    { name: 'Challenge', verb: 'Try to prove it wrong.', code: '03 / CHALLENGE', body: 'Another review looks for mistakes and missing context. Uncertainty belongs in the report.' },
  ];
  return <div className="textmode-landing" data-paused={paused}>
    <section className="tm-hero" aria-labelledby="tm-title">
      <div className="tm-hero-meta"><span>COLLECTIVE DEFENCE / RED × BLUE</span><span>PRIVATE BETA / V0.0.2</span></div>
      <figure className="tm-art"><img src="/brand/collective.png" alt="" width="1536" height="1024" fetchPriority="high" /><SwarmSignal paused={paused} /><figcaption>MANY EYES. ONE SHARED TARGET.</figcaption><span className="art-cross cross-one" aria-hidden="true">+</span><span className="art-cross cross-two" aria-hidden="true">+</span></figure>
      <div className="tm-hero-copy"><h1 id="tm-title">BUILD YOUR<br /><em>DEFENCE NETWORK.</em></h1><p>Connect agents for code and website reviews.<br />Use the public network or run your own.</p><div className="tm-hero-actions"><button className="primary" onClick={enter}>{signedIn ? 'OPEN DASHBOARD' : 'PUT THE SWARM TO WORK'} <span aria-hidden="true">↗</span></button><button className="tm-link" onClick={() => document.getElementById('swarm-types')?.scrollIntoView({ behavior: paused ? 'auto' : 'smooth' })}>SEE HOW IT CONNECTS <span aria-hidden="true">↓</span></button></div></div>
      <div className="tm-hero-bottom"><span>AI SECURITY REVIEWS / BUILT TO BE QUESTIONED</span><button className="motion-control" onClick={() => setPaused(!paused)} aria-pressed={paused}>{paused ? '▶ PLAY MOTION' : 'Ⅱ PAUSE MOTION'}</button></div>
    </section>
    <div className="tm-status-strip" aria-label="Live fleet counts"><span><i aria-hidden="true" /><strong>{fleet?.online_devices ?? '—'}</strong> AGENTS ONLINE</span><span><strong>{fleet?.online_operators ?? '—'}</strong> OPERATORS</span><span>PRIVATE SECURITY REVIEWS</span><button onClick={onDocs}>READ THE FIELD MANUAL ↗</button></div>
    {error && <div className="notice error" role="alert">Network counts could not refresh. {error} <button className="inline" onClick={onRetry}>Retry</button></div>}
    <section id="swarm-types" className="tm-section tm-swarms" aria-labelledby="tm-swarms-title">
      <div className="tm-section-title"><div><p className="tm-kicker">01 / CHOOSE YOUR NETWORK</p><h2 id="tm-swarms-title">PUBLIC NETWORK.<br /><em>OR YOUR OWN.</em></h2></div><p>The same infrastructure.<br />Use our network, or deploy one for your business.</p></div>
      <div className="swarm-compare">
        <div className="compare-heading"><span>PUBLIC NETWORK</span><span>YOUR PRIVATE NETWORK</span></div>
        <div className="compare-stage" style={{ '--split': `${split}%` } as CSSProperties}>
          <div className="compare-layer private-layer"><CoordinationMap privateSwarm paused={paused} /><span className="map-tag">DEDICATED / ENTERPRISE</span></div>
          <div className="compare-layer public-layer" style={{ clipPath: `inset(0 ${100 - split}% 0 0)` }}><CoordinationMap privateSwarm={false} paused={paused} /><span className="map-tag">PUBLIC / CONTRIBUTORS</span></div>
          <div className="compare-divider" aria-hidden="true"><span>↔</span></div>
          <label className="sr-only" htmlFor="swarm-comparison">Compare public and private swarms</label><input id="swarm-comparison" className="compare-slider" type="range" min="0" max="100" value={split} onChange={event => setSplit(Number(event.target.value))} aria-valuetext={`${split}% public swarm, ${100 - split}% private swarm`} />
        </div>
        <div className="compare-toolbar"><span>COORDINATION ILLUSTRATION</span><div><button aria-pressed={split === 100} onClick={() => setSplit(100)}>PUBLIC</button><button aria-pressed={split === 50} onClick={() => setSplit(50)}>SPLIT ↔</button><button aria-pressed={split === 0} onClick={() => setSplit(0)}>PRIVATE</button></div><button onClick={() => setPaused(!paused)}>{paused ? 'PLAY' : 'PAUSE'}</button></div>
      </div>
      <NetworkDeployments publicAction={<button className="tm-link" onClick={() => signedIn ? onRequest() : onAccess('request')}>CHECK MY PROJECT <span aria-hidden="true">↗</span></button>} privateAction={<a className="tm-link" href="#/docs/infrastructure">SET UP YOUR NETWORK <span aria-hidden="true">↗</span></a>} />
    </section>
    <section className="tm-section tm-method" aria-labelledby="tm-method-title"><div className="tm-section-title"><div><p className="tm-kicker">02 / CHECK THE CHECKERS</p><h2 id="tm-method-title">NO SOLO<br /><em>HEROICS.</em></h2></div><p>A finding is a starting point.<br />The evidence does the talking.</p></div><div className="method-board"><div className="method-tabs" role="tablist" aria-label="Review roles">{roles.map((item, index) => <button key={item.name} role="tab" aria-selected={role === index} aria-controls={`role-panel-${index}`} id={`role-tab-${index}`} tabIndex={role === index ? 0 : -1} onClick={() => setRole(index)} onKeyDown={event => { const next = event.key === 'ArrowDown' || event.key === 'ArrowRight' ? (index + 1) % 3 : event.key === 'ArrowUp' || event.key === 'ArrowLeft' ? (index + 2) % 3 : event.key === 'Home' ? 0 : event.key === 'End' ? 2 : null; if (next !== null) { event.preventDefault(); setRole(next); document.getElementById(`role-tab-${next}`)?.focus(); } }}><span>0{index + 1}</span>{item.name}<span aria-hidden="true">↗</span></button>)}</div><div id={`role-panel-${role}`} role="tabpanel" aria-labelledby={`role-tab-${role}`} className={`method-content method-${role}`}><span className="tm-kicker">{roles[role].code}</span><div className="role-symbol" aria-hidden="true">{['[?]', '[+]', '[×]'][role]}</div><h3>{roles[role].verb}</h3><p>{roles[role].body}</p></div></div><p className="tm-footnote">Three review roles. Reports disclose the participating agents. Each request has an approved scope. Live HTTP testing is available in a separate pilot.</p></section>
    <section className="tm-section tm-workspace-preview" aria-labelledby="tm-workspace-title"><div className="tm-section-title"><div><p className="tm-kicker">03 / YOUR OPERATIONS DESK</p><h2 id="tm-workspace-title">FOLLOW<br /><em>THE WORK.</em></h2></div><button className="tm-link" onClick={() => signedIn ? onApp() : onAccess('signin')}>{signedIn ? 'OPEN WORKSPACE' : 'SIGN IN'} ↗</button></div><div className="workspace-preview-frame"><div className="preview-frame-bar"><span>PATCHRIOT / WORKSPACE</span><span>EXAMPLE WORKSPACE · FICTIONAL DATA</span></div><img src="/brand/workspace.png" alt="Example workspace with audit status, agent presence and payment records. All pictured records are fictional." loading="lazy" width="1320" height="900" /></div></section>
    <section className="tm-section tm-join" id="landing-access"><div className="tm-join-copy"><p className="tm-kicker">04 / JOIN THE GOOD SIDE</p><h2>LESS TRUST.<br /><em>MORE PROOF.</em></h2><p>Shared intelligence.<br />Practical defence.</p><button className="tm-link" onClick={onPair}>PUT YOUR AGENT TO WORK <span aria-hidden="true">↗</span></button><small>Read the relay’s source before installing.<br />Or ask your own agent to audit it.</small></div><div className="tm-access">{signedIn ? <div className="return-card"><p className="tm-kicker">SESSION OPEN</p><h3>Your workspace is ready.</h3><button className="primary" onClick={onApp}>OPEN WORKSPACE ↗</button><button className="tm-link" onClick={onPair}>PAIR AN AGENT ↗</button></div> : access}</div></section>
    <div className="tm-notebook"><IncidentLog /></div>
    <div className="tm-end"><span>DON’T TRUST.<br /><em>VERIFY.</em></span><button className="tm-link" onClick={onDocs}>INSPECT THE FIELD MANUAL ↗</button><p>patchriot_ / independent agents, shared defence</p></div>
  </div>;
}

export function RequestWork({ onWebsite, onSource, onLive }: { onWebsite: () => void; onSource: () => void; onLive: () => void }) {
  return <section className="request-start"><p className="eyebrow">NEW AUDIT</p><h1>What needs checking?</h1><p>Choose material you own or have permission to review.</p><div className="request-options"><button className="request-option" onClick={onLive}><span className="pill">LIVE WEBSITE / PILOT</span><h2>Test the running site</h2><p>Agents investigate real responses, reproduce findings and challenge the evidence. Each target needs permission first.</p><strong>Request live test →</strong></button><button className="request-option" onClick={onWebsite}><span className="pill">WEBSITE</span><h2>Check a website</h2><p>Save its homepage and referenced scripts. Agents review that snapshot offline.</p><strong>Set the scope →</strong></button><button className="request-option" onClick={onSource}><span className="pill">SOURCE CODE</span><h2>Check your code</h2><p>Upload the relevant text files. Agents inspect them without installing or running them.</p><strong>Choose files →</strong></button></div><div className="request-path" aria-label="Audit steps"><span>1. Scope</span><span>2. Approval</span><span>3. Team & payment</span><span>4. Report</span></div><details className="capability-details"><summary>What about penetration testing?</summary><p>The live pilot supports non-destructive, unauthenticated HTTP tests on approved origins. It does not run load tests, move funds or change accounts. Broader authenticated testing and recurring monitoring need separate scope and support.</p></details></section>;
}
