import type { LiveWorkflow, LiveToolRun, WorkflowCheckId, WorkflowCheckState } from './LiveReport';

export const checkDefinitions: { id: WorkflowCheckId; title: string; tool: string; description: string }[] = [
  { id: 'public_baseline', title: 'Headers & config', tool: 'Patchriot baseline', description: 'Inspect public response headers, browser policies and exposed configuration without a signed-in session.' },
  { id: 'public_mapping', title: 'Map routes', tool: 'Patchriot crawl', description: 'Map reachable public pages, links and forms within the approved origin.' },
  { id: 'public_signatures', title: 'Known signatures', tool: 'Nuclei', description: 'Run the curated signature checks against public responses. Matches are leads to investigate.' },
  { id: 'public_fingerprints', title: 'Web fingerprints', tool: 'ARES-engine', description: 'Compare public technology and content fingerprints with missing-path controls.' },
  { id: 'public_analysis', title: 'Deeper public checks', tool: 'Agentic security checks', description: 'Investigate the public attack surface within the saved scope and remaining limits.' },
  { id: 'authentication', title: 'Verify access', tool: 'Relay access proof', description: 'Establish the permitted account or disposable-wallet access and record an anonymous comparison.' },
  { id: 'authenticated_checks', title: 'Signed-in checks', tool: 'Signed-in investigation', description: 'Inspect signed-in resources under the saved permission, in addition to public checks. Recorded means requests were made with verified access; the evidence shows what was actually tested.' },
  { id: 'evidence_review', title: 'Review & report', tool: 'Agent assessment', description: 'Review claims against evidence, retain uncertainty and produce this role’s assessment.' },
];

export const workflowStateLabels: Record<WorkflowCheckState | 'not_recorded', string> = {
  pending: 'Waiting', running: 'Running', recorded: 'Recorded', reused: 'Reused evidence',
  incomplete: 'Incomplete', not_applicable: 'Not in scope', not_recorded: 'Not recorded',
};
export const workflowCaveat = 'Recorded means work or access evidence was returned. It does not mean complete coverage or a finding-free website.';
export const workflowAbsent = 'Structured checklist not recorded for this role.';
const sourceRoles = { investigator: 'Scout', reproducer: 'Recon', challenger: 'Verifier' };
/** Retain explicit gaps without inventing execution states for historical reports. */
export function workflowRecordLines(workflow: LiveWorkflow | undefined): string[] {
  if (workflow?.version !== 1) return [];
  return checkDefinitions.flatMap(definition => {
    const check = workflow.checks.find(check => check.id === definition.id);
    if (!check) return [`${definition.title} (${definition.tool}): Not recorded (no checklist entry)`];
    const state = check.state === 'running' ? 'Last reported running' : workflowStateLabels[check.state];
    return [`${definition.title} (${definition.tool}): ${state} · ${check.evidence_count} evidence records${check.source_role ? ` · Source: ${sourceRoles[check.source_role]}` : ''}`];
  });
}

export function workflowToolName(tool: string, record?: LiveToolRun) {
  if (record && combinedEngineAccess(record)) return 'Agentic security checks';
  if (tool === 'zap' && record?.arguments.includes('--engine-discoveries')) return 'ZAP · discovered inputs';
  const names: Record<string, string> = { 'patchriot-controls': 'Access controls', 'patchriot-probes': 'HTTP controls', ffuf: 'Endpoint discovery', zap: 'ZAP web scanner', schemathesis: 'API schema checks', 'patchriot-coverage': 'Evidence coverage' };
  if (names[tool]) return names[tool];
  return tool === 'artex-engine' ? 'Agentic security checks' : tool === 'ares-web-surface' ? 'ARES-engine' : tool;
}
export function combinedEngineAccess(tool: LiveToolRun): { anonymous: number; authenticated: number } | undefined {
  if (tool.tool !== 'artex-engine') return undefined;
  try {
    const receipt = JSON.parse(tool.output_excerpt);
    const counts = [receipt.anonymous_evidence_count, receipt.authenticated_evidence_count];
    if (receipt.receipt_schema === 1 && receipt.access_mode === 'anonymous_and_authenticated'
      && counts.every(count => Number.isSafeInteger(count) && count >= 0)) {
      return { anonymous: counts[0], authenticated: counts[1] };
    }
  } catch { /* Older or shortened receipts can omit structured access metadata. */ }
  return undefined;
}

/** Display known receipt metadata only; target/model text never becomes an execution diagnosis. */
export function toolCoverageDetail(tool: LiveToolRun): string | undefined {
  if (tool.tool === 'zap' && tool.failure) {
    try {
      const receipt = JSON.parse(tool.output_excerpt);
      const contexts = Array.isArray(receipt.contexts) ? receipt.contexts : [];
      const requests = contexts.reduce((sum: number, context: {requests?: number}) => sum + (Number.isSafeInteger(context.requests) && (context.requests ?? -1) >= 0 ? context.requests! : 0), 0);
      const gaps = [...(Array.isArray(receipt.gaps) ? receipt.gaps : []), ...contexts.flatMap((context: {gaps?: string[]}) => Array.isArray(context.gaps) ? context.gaps : [])];
      const phase = tool.arguments.includes('--engine-discoveries') ? 'ZAP follow-up' : 'ZAP scan';
      const reasons: Record<string,string> = {scanner_api_url_not_found:'ZAP could not index a discovered input',scanner_startup_timeout:'ZAP did not start within its allowance',scanner_version_mismatch:'The scanner version did not match the configured version',scanner_api_internal_error:'ZAP returned an internal error',TimeoutError:'The scanner operation timed out'};
      const cause = contexts.map((context: {result?: {reason?: string}}) => reasons[context.result?.reason ?? '']).find(Boolean);

      if (gaps.includes('scanner_execution_incomplete')) return `${phase} stopped early after ${requests} recorded requests. ${cause ? `Retained reason: ${cause}.` : 'The receipt records a scanner execution failure; its underlying cause was not retained.'} Saved responses remain available, but unfinished scanner checks cannot be treated as passed. Other tool runs have separate outcomes.`;
      if (gaps.some(gap => ['scanner_budget_reached','active_scan_incomplete','passive_scan_incomplete','follow_up_time_unavailable'].includes(gap))) return `${phase} did not finish within its available request or time allowance. Saved responses remain available; unfinished checks are a coverage gap, not a passed scan.`;
    } catch { /* Keep unstructured failures explicit. */ }
    return undefined;
  }
  if (tool.tool !== 'artex-engine') return undefined;
  try {
    const receipt = JSON.parse(tool.output_excerpt);
    if (receipt.receipt_schema !== 1 || receipt.coverage_complete !== false) return undefined;
    const gaps = Array.isArray(receipt.collection_errors) ? receipt.collection_errors : [];
    if (gaps.includes('authenticated_context_unverified') || gaps.includes('account_context_unverified'))
      return 'Signed-in access was not verified for every required account in this engine pass. Public checks are retained; authenticated coverage remains incomplete.';
    if (gaps.includes('access_context_untested'))
      return 'The engine did not retain requests for every required public and signed-in context. Combined coverage remains incomplete.';
    const reasons: Record<string, string> = {
      target_request_budget: 'Reached this tool’s request limit. Deeper public coverage remains incomplete.',
      time_budget: 'Reached this tool’s time limit. Deeper public coverage remains incomplete.',
      model_budget: 'Reached this tool’s model budget. Deeper public coverage remains incomplete.',
      no_target_progress: 'Stopped after no further target progress. Deeper public coverage remains incomplete.',
      interrupted: 'The engine was interrupted before a finished receipt. Deeper public coverage remains incomplete.',
      provider_rate_limited: 'The model provider kept refusing requests after the available recovery attempts. Engine coverage remains incomplete.',
      model_request_rejected: 'A model request was rejected before the engine finished. The retained reason does not identify the underlying rejection. Engine coverage remains incomplete.',
      model_request_too_large: 'The engine’s model input exceeded the bridge size limit. Engine coverage remains incomplete.',
    };
    const reason = reasons[receipt.stop_reason];
    return combinedEngineAccess(tool) ? reason?.replace('Deeper public coverage', 'Combined public and signed-in coverage') : reason;
  } catch { return undefined; }
}
