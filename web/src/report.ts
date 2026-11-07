import type { ReviewPolicy, ThirdReview } from './Pentests';
import type { AccountSlot, HttpRecord, LiveFinding, LiveResult, LiveRole, LiveStep } from './LiveReport';

export const reportRoles = { investigator: 'Scout', reproducer: 'Recon', challenger: 'Verifier' } as const;
export const roleDuties = { investigator: 'Find leads and record what the website returned.', reproducer: 'Repeat the checks and challenge the initial findings.', challenger: 'Review the evidence, impact and proposed fixes.' };
/** Assigned methods describe the role prompt, not proof that a test ran. */
export const roleMethods = {
  investigator: ['Website and API mapping', 'Configuration and input checks', 'Evidence collection'],
  reproducer: ['Repeat reported probes', 'Compare positive and negative controls', 'Challenge false positives'],
  challenger: ['Retest material claims', 'Assess impact and severity', 'Review proposed fixes and gaps'],
} as const;
export const severities = ['critical', 'high', 'medium', 'low', 'info'] as const;
export const supportLabels: Record<string, string> = { observed: 'Observed', reproduced: 'Reproduction reported', not_reproduced: 'Not reproduced', needs_review: 'Unconfirmed' };
export type ReportInput = { account_policy?: { allow_password_changes: boolean }; tools?: string[]; browser_login?: boolean; review_policy?: ReviewPolicy; third_review?: ThirdReview; id: string; state: string; created_at: number; origins: string[]; steps: LiveStep[]; methods?: string[]; profile?: string; authentication?: 'basic' | 'bearer' | 'session' | 'wallet'; auth_check_path?: string; scope_sha256?: string; team?: { device_id: string; operator_id: string; compute_group?: string | null }[] };
export type FindingContribution = { id: string; role: LiveRole; finding: LiveFinding; result: LiveResult; complete: boolean };
export type ReportFinding = FindingContribution & { contributions: FindingContribution[]; disputed: boolean; variedRequests: boolean };

/** These are execution problems, never findings about the assessed website. */
export function stopExplanation(reason?: string): string {
  switch (reason) {
    case 'model_history_limit': case 'model_request_too_large': return 'The agent’s conversation exceeded the runner’s input limit before its report was ready. Recorded requests remain available.';
    case 'model_messages_empty': case 'model_message_role': case 'model_message_content': case 'invalid_model_messages': return 'The runner rejected a model conversation before the agent could finish its assessment. This is an execution problem, not a finding about your website.';
    case 'inference_limit': return 'The runner reached its model-request limit before the agent could finish its report. This is a testing limit, not a vulnerability in your website.';
    case 'agent_request_limit': return 'The agent exceeded the runner’s internal request allowance before returning its assessment. This is an execution failure, not a finding about your website.';
    case 'provider_budget_reached': case 'engine_budget_reached': return 'The agent reached its allowed AI usage budget. Saved evidence is available, but the remaining checks were not completed.';
    case 'timed_out': case 'timeout': return 'The allowed testing time ended before this work finished.';
    case 'provider_unavailable': case 'provider_rejected_request': case 'provider_stream_interrupted': return 'The AI provider did not complete a request. The agent could not finish this stage.';
    case 'provider_authentication_failed': return 'The AI provider rejected the configured account access. Staff must check it before another assessment can run.';
    case 'provider_repetition': return 'The model repeated itself instead of producing a usable answer. No repeated output was executed. The saved website evidence is still available.';
    case 'provider_rate_limited': return 'The AI provider limited a request. This stage stopped before completing; saved website evidence remains available.';
    case 'provider_context_limit': return 'The request exceeded the AI provider’s input limit. This stage could not finish.';
    case 'provider_invalid_json': case 'provider_missing_completion_id': case 'provider_missing_message': case 'unexpected_provider_response': return 'The AI provider returned a response the runner could not interpret. This stage is incomplete; it is not a finding about your website.';
    // This legacy code covers the whole request, including model generation.
    case 'near_verification_timeout': return 'NEAR AI did not return a verified reply before the request deadline. The delay may be in the model response or verification; this code alone does not identify which. Saved website requests remain available.';
    case 'near_attestation_invalid': case 'near_signature_invalid': case 'near_attestation_unavailable': case 'near_model_attestation_required': case 'near_signature_unavailable': case 'near_model_signature_required': return 'NEAR AI verification could not be completed. The agent stopped rather than trust an unverified model response. Saved website requests remain available; this stage needs another assessment.';
    case 'cancelled': return 'This stage was cancelled. Work already recorded remains available.';
    case 'invalid_tool_records': return 'The runner could not validate the recorded tool output. Its conclusions need review.';
    case undefined: return 'Some checks or supporting evidence are incomplete. Review the recorded limits before relying on these findings.';
    default: return 'The runner could not finish this stage. The technical details include its recorded stop reason.';
  }
}

/** A returned report and complete requested coverage are separate facts. */
export function assessmentFinished(result: LiveResult | null): boolean {
  return !!result?.assessment && result.execution.state === 'completed' && result.execution.cleanup_confirmed && !result.execution.failure_reason;
}

export function roleOutcome(step: LiveStep): { label: string; detail: string } {
  if (!step.result) return ['running', 'leased'].includes(step.state) ? { label: 'Working', detail: roleDuties[step.role] } : ['waiting', 'queued'].includes(step.state) ? { label: 'Waiting', detail: 'This stage has not started.' } : { label: 'No report', detail: 'This stage ended without a saved report.' };
  if (!step.result.assessment) return { label: 'No assessment', detail: stopExplanation(step.result.execution.failure_reason) };
  if (!assessmentFinished(step.result)) return { label: 'Interrupted assessment', detail: stopExplanation(step.result.execution.failure_reason) };
  return step.evidence_complete ? { label: 'Assessment received', detail: 'Findings and request evidence are available. The agent’s conclusions still need review.' } : { label: 'Report received · coverage limits', detail: 'The agent returned its assessment. Some requested checks or access could not be verified; read those limits alongside the findings.' };
}

export function accountLabel(account: AccountSlot): string {
  return account === 'testing' ? 'Account 1 (testing)' : 'Account 2 (reference)';
}
export function evidenceAccessLabel(evidence: HttpRecord): string {
  if (evidence.account) return `${accountLabel(evidence.account)} · ${evidence.authenticated ? 'Signed-in' : 'Anonymous'}`;
  return evidence.authenticated ? 'Test account' : 'Anonymous';
}

/** First cited request, with access kept visible inside a grouped observation. */
export function findingRequest(claim: FindingContribution): string {
  const evidence = claim.result.evidence.find(e => e.id === claim.finding.evidence_ids[0]);
  return evidence ? `${evidenceAccessLabel(evidence)} · ${evidence.method} ${evidence.url}` : 'Request evidence unavailable';
}

/** Group matching labels on one origin for reading, not to infer a shared root
 * cause or reviewer consensus. Keep each author's separate claims, requests,
 * inputs and access conditions intact, including disagreements. */
export function reportFindings(input: ReportInput): ReportFinding[] {
  const claims = input.steps.flatMap(s => s.result?.assessment?.findings.map((finding, i) => ({
    id: `${({ investigator: 'S', reproducer: 'R', challenger: 'V' })[s.role]}-${String(i + 1).padStart(2, '0')}`,
    role: s.role, finding, result: s.result!, complete: s.evidence_complete === true,
  })) ?? []);
  const groups = new Map<string, ReportFinding[]>();
  for (const claim of claims) {
    const evidence = claim.result.evidence.find(e => e.id === claim.finding.evidence_ids[0]);
    // No fuzzy matching. Similar-looking titles can describe different causes.
    const title = claim.finding.title.toLowerCase().trim().replace(/\s+/g, ' ').replace(/\bstrict-transport-security header\b/g, 'strict-transport-security');
    let origin: string | undefined;
    if (evidence?.status != null) {
      try {
        const origins = new Set(claim.finding.evidence_ids.map(id => {
          const record = claim.result.evidence.find(e => e.id === id);
          return record?.status != null ? new URL(record.url).origin : undefined;
        }));
        if (origins.size === 1 && !origins.has(undefined)) origin = [...origins][0];
      } catch { /* Missing or malformed evidence must not join another claim. */ }
    }
    const key = origin ? JSON.stringify([title, origin]) : claim.id;
    const bucket = groups.get(key) ?? [];
    const group = bucket.find(g => !g.contributions.some(c => c.role === claim.role));
    if (group) group.contributions.push(claim);
    else bucket.push({ ...claim, contributions: [claim], disputed: false, variedRequests: false });
    groups.set(key, bucket);
  }
  const rank = (f: LiveFinding) => severities.indexOf(f.severity as typeof severities[number]);
  return [...groups.values()].flat().map(group => {
    const highest = group.contributions.reduce((a, b) => rank(a.finding) <= rank(b.finding) ? a : b);
    const support = new Set(group.contributions.map(c => ['observed', 'reproduced'].includes(c.finding.support) ? 'positive' : c.finding.support));
    const requests = new Set(group.contributions.map(c => {
      const e = c.result.evidence.find(e => e.id === c.finding.evidence_ids[0]);
      return e ? JSON.stringify([e.method, e.url, e.request_body_sha256 ?? null, e.authenticated === true, e.account ?? null]) : c.id;
    }));
    return { ...group, role: highest.role, finding: highest.finding, result: highest.result,
      complete: group.contributions.every(c => c.complete),
      variedRequests: requests.size > 1,
      disputed: support.size > 1 || new Set(group.contributions.map(c => c.finding.severity)).size > 1 };
  }).sort((a, b) => rank(a.finding) - rank(b.finding));
}

export function expectedReports(input: Pick<ReportInput, 'review_policy' | 'third_review'>) {
  return input.review_policy === 'investigate_validate_v1' || input.review_policy === 'investigate_verify_v1' && !input.third_review?.reasons.length ? 2 : 3;
}
export function reviewMethod(input: Pick<ReportInput, 'review_policy' | 'third_review'>) {
  if (input.review_policy === 'investigate_validate_v1') return 'Two agents: a full scoped investigation, followed by targeted validation of its findings. No automatic third agent. Unresolved claims and coverage gaps remain visible.';
  if (input.review_policy !== 'investigate_verify_v1') return 'This saved request uses three required agents.';
  const decision = input.third_review;
  if (!decision) return 'Two required agents: investigation and verification. A third review may follow for serious findings, disagreement or incomplete evidence.';
  if (!decision.reasons.length) return 'Both required reports are in. The escalation checks did not request a third review; this is not a guarantee of safety.';
  const labels: Record<string, string> = { serious_finding: 'a high or critical claim', disagreement: 'disputed evidence or severity', unchecked_claim: 'a claim still needing a matching check', incomplete_evidence: 'incomplete evidence' };
  return `A third review was requested for ${decision.reasons.map(r => labels[r] ?? 'further review').join(', ')}. The original findings and limitations remain visible.`;
}
export function reportSummary(input: ReportInput) {
  const findings = reportFindings(input);
  const assessments = input.steps.filter(s => !!s.result?.assessment).length;
  const complete = input.steps.filter(s => !!s.result?.assessment && s.evidence_complete).length;
  const requests = input.steps.reduce((sum, s) => sum + (s.result?.evidence.length ?? 0), 0);
  const finished = !['awaiting_payment', 'queued', 'running'].includes(input.state);
  const expected = expectedReports(input);
  const requiredRoles: LiveRole[] = expected === 3 ? ['investigator', 'reproducer', 'challenger'] : ['investigator', 'reproducer'];
  const reportsFinished = requiredRoles.every(role => input.steps.some(s => s.role === role && assessmentFinished(s.result)));
  const loginMissing = input.browser_login && requiredRoles.some(role => !input.steps.find(s => s.role === role)?.result?.browser_access);
  const partial = complete < expected || input.state !== 'completed' || input.review_policy === 'investigate_verify_v1' && !input.third_review;
  const reportsReady = finished && reportsFinished && ['completed', 'needs_review'].includes(input.state) && (input.review_policy !== 'investigate_verify_v1' || !!input.third_review);
  const headline = !finished ? 'Assessment in progress' : !reportsReady ? 'Run ended · some checks missing' : loginMissing ? 'Report ready · sign-in not verified' : partial ? 'Report ready · coverage limits' : 'Report ready';
  const claims = findings.reduce((n, f) => n + f.contributions.length, 0);
  const missing = input.steps.filter(s => (expected === 3 || s.role !== 'challenger') && (!s.result?.assessment || !s.evidence_complete)).map(s => reportRoles[s.role]);
  const description = `${assessments} of ${expected} agent reports are available. ${findings.length} ${findings.length === 1 ? 'finding' : 'findings'} to inspect${claims > findings.length ? ` from ${claims} agent observations` : ''}. ${!finished ? 'Work is still running.' : reportsReady && partial ? `The agents finished their reports. ${loginMissing ? 'Signed-in access was not verified by every required role. ' : ''}Use the saved findings alongside the listed coverage limits; unfinished checks remain untested.` : partial ? `Nothing is still running. ${missing.length ? missing.join(', ') + ' did not finish every required check. ' : ''}You can use the findings below; missing checks remain untested.` : 'The requested stages finished. Findings still need your review.'}`;
  return { findings, assessments, complete, expected, requests, finished, partial, reportsReady, headline, description };
}

export function toolOutcome(run: NonNullable<LiveResult['tool_runs']>[number]) {
  if (run.failure || run.exit_code !== 0) return 'Incomplete';
  if (['schemathesis', 'ffuf'].includes(run.tool) && !run.output_truncated) {
    try {
      const receipt = JSON.parse(run.output_excerpt);
      if (Array.isArray(receipt.contexts) && receipt.contexts.length > 0 && receipt.contexts.every((context: { result?: { state?: string } }) => context.result?.state === 'inapplicable')) return 'Not applicable';
    } catch { /* Preserve older or unstructured tool receipts. */ }
  }
  return 'Ran'; // A successful exit is neither full coverage nor proof of safety.
}

export function teamDescription(input: ReportInput) {
  if (!input.team?.length) return 'Team independence was not recorded. Multiple agent roles do not establish independent verification.';
  const operators = new Set(input.team.map(r => r.operator_id)).size;
  const groups = new Set(input.team.filter(r => r.compute_group).map(r => `${r.operator_id}:${r.compute_group}`)).size;
  return `${input.team.length} devices, ${operators} operator${operators === 1 ? '' : 's'}, ${groups} declared machine group${groups === 1 ? '' : 's'}. Shared operators, machines or models are not independent reviewers.`;
}

export const reportLimits = 'An automated assessment within the approved scope. It does not replace a full human penetration test. Tool matches and agent agreement do not prove exploitability. Suggested fixes have not been applied or retested.';

export type CoverageCheck = { id: string; origin: string; title: string; status: string; summary: string; evidence_ids: number[] };
export function coverageChecks(result: LiveResult | null): CoverageCheck[] {
  return (result?.tool_runs ?? []).filter(t => ['patchriot-baseline', 'patchriot-coverage'].includes(t.tool) && !t.output_truncated).flatMap(t => {
    try {
      const data = JSON.parse(t.output_excerpt);
      if (t.tool === 'patchriot-coverage' && data.version === 1 && Array.isArray(data.units) && data.units.length <= 40) {
        return data.units.filter((unit: Record<string, unknown> & { evidence_ids?: number[] }) => unit && ['id', 'url', 'method', 'account', 'class', 'state', 'reason'].every(key => typeof unit[key] === 'string') && Array.isArray(unit.evidence_ids) && unit.evidence_ids.every(id => t.evidence_ids.includes(id) && result!.evidence.some(e => e.id === id)))
          .map((unit: { id: string; url: string; method: string; account: string; class: string; state: string; reason: string; evidence_ids: number[] }) => ({
            id: unit.id, origin: unit.url, title: `${unit.method} · ${unit.account} · ${unit.class.replaceAll('_', ' ')}`,
            status: ({ tested: 'completed', blocked: 'inconclusive', deferred: 'skipped', inapplicable: 'unsupported' } as Record<string, string>)[unit.state] ?? 'inconclusive',
            summary: unit.reason, evidence_ids: unit.evidence_ids,
          }));
      }
      if (data.profile !== 'web-checks-v1' || !Array.isArray(data.checks) || data.checks.length > 40) return [];
      return data.checks.filter((c: CoverageCheck) => c && ['id', 'origin', 'title', 'summary'].every(k => typeof c[k as keyof CoverageCheck] === 'string' && String(c[k as keyof CoverageCheck]).length <= 2000) && ['completed', 'finding', 'inconclusive', 'skipped', 'unsupported'].includes(c.status) && Array.isArray(c.evidence_ids) && c.evidence_ids.every(id => t.evidence_ids.includes(id) && result!.evidence.some(e => e.id === id)));
    } catch { return []; }
  });
}
export const checkLabels: Record<string, string> = { completed: 'Completed', finding: 'Potential issue', inconclusive: 'Inconclusive', skipped: 'Skipped', unsupported: 'Unsupported' };
