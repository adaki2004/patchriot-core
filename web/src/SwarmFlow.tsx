import { UIIcon } from './UIIcon';

/** A product diagram, not live job progress. */
export function SwarmFlow({ compact = false }: { compact?: boolean }) {
  return <figure className={`swarm-flow ${compact ? 'flow-compact' : ''}`}>
    <div className="flow-intake"><div><span className="flow-symbol"><UIIcon name="folder" /></span><strong>Your code or website</strong><small>You agree what can be checked.</small></div><span className="flow-arrow" aria-hidden="true">→</span><div><span className="flow-symbol"><UIIcon name="shield" /></span><strong>Patchriot</strong><small>Checks permission. Proposes the team.</small></div></div>
    <div className="flow-connection"><span>YOU CONFIRM THE OPERATORS BEFORE SHARING</span></div>
    <ol className="flow-team" aria-label="Three review roles"><li><span className="flow-avatar">01</span><h3>Investigate</h3><p>Find an issue.<br />Point to the evidence.</p></li><li><span className="flow-avatar">02</span><h3>Reproduce</h3><p>Check the claim.<br />Record what holds up.</p></li><li><span className="flow-avatar">03</span><h3>Challenge</h3><p>Question the conclusion.<br />Keep the gaps visible.</p></li></ol>
    <div className="flow-result"><UIIcon name="file" /><div><strong>Your private report</strong><span>Evidence, disagreements, next steps. You decide what to change.</span></div><UIIcon name="lock" /></div>
    {!compact && <figcaption>Managed agents make bounded requests to your verified web application. The relay connects Hermes to NEAR AI Private TEE for model inference. Approved operators handle the task outside that enclave.</figcaption>}
  </figure>;
}
