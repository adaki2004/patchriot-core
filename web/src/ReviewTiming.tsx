import { useEffect, useState } from 'react';
import { liveRoles } from './LiveReport';
import type { LiveStep, LiveTiming } from './LiveReport';
import './review-timing.css';

/** A planning guide from this test's received reports, not a completion promise. */
export function ReviewTiming({ steps, timing }: { steps: LiveStep[]; timing: LiveTiming }) {
  const [now, setNow] = useState(() => Date.now() / 1000);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now() / 1000), 15_000);
    return () => window.clearInterval(timer);
  }, []);
  const minutes = (seconds: number) => Math.max(1, Math.ceil(seconds / 60));
  const active = steps.find(step => ['leased', 'running'].includes(step.state));
  const elapsed = active && timing.active_role_deadline_at ? Math.max(0, now - (timing.active_role_deadline_at - timing.role_limit_seconds)) : null;
  return <div className="review-timing" aria-label="Agent time guide">
    <strong>Time guide</strong>
    <ul>{steps.map(step => {
      const running = step === active;
      const duration = step.result?.execution.duration_ms;
      let detail: string;
      if (duration != null) detail = `${minutes(duration / 1000)} min recorded`;
      else if (['failed', 'cancelled'].includes(step.state)) detail = 'Stopped';
      else if (running && elapsed != null) detail = `${minutes(elapsed)} min elapsed · up to ${Math.max(0, Math.ceil((timing.role_limit_seconds - elapsed) / 60))} min left in its allowance`;
      else if (step.role !== 'investigator') detail = 'Focused evidence review · timing not yet measured';
      else detail = `up to ${minutes(timing.role_limit_seconds)} min once started`;
      return <li key={step.role}><span>{liveRoles[step.role]}</span><span>{detail}</span></li>;
    })}</ul>
    <small>Recorded times are actual durations. Remaining allowances are limits, not estimates. Evidence review has a different workload from discovery; queue waits are extra.</small>
  </div>;
}
