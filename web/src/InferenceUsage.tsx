import type { LiveResult } from './LiveReport';
import './inference-usage.css';

export type InferenceUsageObservation = {
  provider: string;
  model: string;
  responses: number;
  token_usage_responses: number;
  cache_usage_responses: number;
  prompt_tokens: number;
  completion_tokens: number;
  cached_prompt_tokens: number;
  usd_cost_responses: number;
  diem_cost_responses: number;
  provider_reported_usd: number;
  provider_reported_diem: number;
};

const amount = (value: number) => value.toLocaleString(undefined, { maximumSignificantDigits: 6 });

export function InferenceUsage({ execution }: { execution: LiveResult['execution'] }) {
  const observations = execution.inference_usage ?? [];
  return <details className="inference-usage">
    <summary>Inference usage &amp; cost</summary>
    <p className="fine">Provider-reported response observations. Billing reconciliation is handled separately.</p>
    {observations.length === 0 && <p>Provider usage and response costs were not recorded.</p>}
    {observations.map(observation => <section key={`${observation.provider}/${observation.model}`} className="inference-route" aria-label={`${observation.provider} usage`}>
      <h5>{observation.provider} <span>{observation.model}</span></h5>
      <p className="fine">{observation.responses} responses observed</p>
      <dl>
        <div><dt>Provider-reported USD</dt><dd>{observation.usd_cost_responses ? `${amount(observation.provider_reported_usd)} USD` : 'Not reported'}<small>{observation.usd_cost_responses} of {observation.responses} responses</small></dd></div>
        <div><dt>Provider-reported DIEM</dt><dd>{observation.diem_cost_responses ? `${amount(observation.provider_reported_diem)} DIEM` : 'Not reported'}<small>{observation.diem_cost_responses} of {observation.responses} responses</small></dd></div>
        <div><dt>Prompt / completion tokens</dt><dd>{observation.token_usage_responses ? `${observation.prompt_tokens.toLocaleString()} / ${observation.completion_tokens.toLocaleString()}` : 'Not reported'}<small>{observation.token_usage_responses} of {observation.responses} responses</small></dd></div>
        <div><dt>Cached prompt tokens</dt><dd>{observation.cache_usage_responses ? observation.cached_prompt_tokens.toLocaleString() : 'Not reported'}<small>{observation.cache_usage_responses} of {observation.responses} responses</small></dd></div>
      </dl>
    </section>)}
    <p className="inference-estimate">Conservative uncached upper estimate <strong>{amount(execution.cost_upper_microusd / 1_000_000)} USD</strong><small>Used by the spend guard with uncached pricing.</small></p>
  </details>;
}
