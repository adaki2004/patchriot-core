import { useState } from 'react';
import type { ReactNode } from 'react';
import type { Fleet } from './api';
import { IncidentLog } from './Incidents';

export function Landing({ signedIn, access, onApp, onDocs, onPair, fleet, error, onRetry }: { signedIn: boolean; access: ReactNode; onApp: () => void; onDocs: () => void; onPair: () => void; fleet?: Fleet | null; error?: string; onRetry: () => void }) {
  const [audience, setAudience] = useState<'personal' | 'team'>('personal');
  return <div className="landing">
    <section className="product-hero">
      <div className="hero-copy"><p className="eyebrow">A SWARM OF REBELS. A SAFER INTERNET.</p><h1>A little more<br /><em>defence.</em></h1><p className="product-lede">Security agents for the things you build.</p><p className="hero-description">Private reviews of your code and websites. Agents investigate, check each other’s claims and give you evidence to act on.</p>
        <div className="audience-switch" aria-label="Who Patchriot is for"><button aria-pressed={audience === 'personal'} onClick={() => setAudience('personal')}>For your project</button><button aria-pressed={audience === 'team'} onClick={() => setAudience('team')}>For your organization</button></div>
        <p className="audience-copy">{audience === 'personal' ? 'For individuals and developers. Request an account, agree the scope, then follow the review in your workspace.' : 'The same review workflow, within your organization. Private deployments with your own approved operators are the next step; team isolation is not yet a hosted feature.'}</p>
        <button className="text-button hero-guide" onClick={onDocs}>See how it works <span aria-hidden="true">↗</span></button>
      </div>
      <div className="hero-access">{signedIn ? <section className="return-card"><span className="eyebrow">YOUR WORKSPACE</span><h2>Pick up where you left off.</h2><button className="primary" onClick={onApp}>Open workspace →</button><button className="text-button" onClick={onPair}>Pair an agent →</button></section> : access}</div>
    </section>
    <div className="live-strip" aria-label="Live fleet counts"><span className="live-indicator" aria-hidden="true" /><strong>{fleet?.online_devices ?? '—'} relays online</strong><span>{fleet?.online_operators ?? '—'} operators</span><span>Private beta</span><button className="text-button" onClick={onDocs}>What’s available ↗</button></div>
    {error && <div className="notice error" role="alert">{error} <button className="inline" onClick={onRetry}>Retry</button></div>}
    <section className="product-section" aria-labelledby="review-roles"><div className="section-heading"><div><p className="eyebrow">THE WORK</p><h2 id="review-roles">A finding needs evidence.</h2></div><p className="subtle">One request. Three review roles.</p></div><ol className="product-roles"><li><span>01</span><h3>Investigate</h3><p>Find a specific issue in the agreed material.</p></li><li><span>02</span><h3>Reproduce</h3><p>Check the claim. Record what holds up.</p></li><li><span>03</span><h3>Challenge</h3><p>Question the finding. Keep the gaps visible.</p></li></ol><p className="capability-note">Available now: saved website snapshots and source-text reviews. Live penetration testing and red-team operations come later.</p></section>
    <section className="product-section contribute-section"><div><p className="eyebrow">CONTRIBUTE</p><h2>Bring an agent.<br />Help check the work.</h2><p>Connect a machine you control, meet the approval checks and take scoped review work. You choose when it runs.</p><button className="text-button" onClick={onPair}>How to pair an agent →</button></div><aside className="verify-note"><strong>DON’T TRUST. VERIFY.</strong><p>Read the source—or ask your own agent to audit it—before installing. Read the evidence before trusting a finding.</p><button className="text-button" onClick={onDocs}>Open the guide ↗</button></aside></section>
    <IncidentLog />
  </div>;
}

export function RequestWork({ onWebsite, onSource }: { onWebsite: () => void; onSource: () => void }) {
  return <section className="request-start"><p className="eyebrow">NEW AUDIT</p><h1>What needs checking?</h1><p>Choose material you own or have permission to review.</p><div className="request-options"><button className="request-option" onClick={onWebsite}><span className="pill">WEBSITE</span><h2>Check a website</h2><p>Save its homepage and referenced scripts. Agents review that snapshot offline.</p><strong>Set the scope →</strong></button><button className="request-option" onClick={onSource}><span className="pill">SOURCE CODE</span><h2>Check your code</h2><p>Upload the relevant text files. Agents inspect them without installing or running them.</p><strong>Choose files →</strong></button></div><div className="request-path" aria-label="Audit steps"><span>1. Scope</span><span>2. Approval</span><span>3. Team & payment</span><span>4. Report</span></div><details className="capability-details"><summary>What about penetration testing?</summary><p>Active testing, red-team operations and recurring monitoring are planned. This version does not attack a live target, execute uploaded code or make changes to your system.</p></details></section>;
}
