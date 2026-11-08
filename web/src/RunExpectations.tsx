import './run-expectations.css';

export function RunExpectations() {
  return <aside className="run-expectations" aria-label="Queue and test duration">
    <span className="run-expectations-clock" aria-hidden="true">◷</span>
    <div><strong>You can come back later.</strong>
      <p>Tests share limited agent capacity and may wait in a queue. An exact queue position or start time isn’t guaranteed. In-depth testing can take 1½–2 hours or longer, plus queue time.</p>
      <p>You don’t need to keep this page open. Return to Audits for progress and saved reports.</p>
    </div>
  </aside>;
}
