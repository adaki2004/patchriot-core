import type { ReviewPolicy, ThirdReview } from './Pentests';
import type { LiveFinding, LiveResult, LiveRole, LiveStep } from './LiveReport';

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
export type ReportInput = { review_policy?: ReviewPolicy; third_review?: ThirdReview; id: string; state: string; created_at: number; origins: string[]; steps: LiveStep[]; methods?: string[]; profile?: string; authentication?: 'basic' | 'bearer' | 'session'; auth_check_path?: string; scope_sha256?: string; team?: { device_id: string; operator_id: string; compute_group?: string | null }[] };
export type FindingContribution = { id: string; role: LiveRole; finding: LiveFinding; result: LiveResult; complete: boolean };
export type ReportFinding = FindingContribution & { contributions: FindingContribution[]; disputed: boolean };

/** These are execution problems, never findings about the assessed website. */
export function stopExplanation(reason?: string): string {
  switch (reason) {
    case 'inference_limit': return 'The runner reached its model-request limit before the agent could finish its report. This is a testing limit, not a vulnerability in your website.';
    case 'provider_budget_reached': case 'engine_budget_reached': return 'The agent reached its allowed AI usage budget. Saved evidence is available, but the remaining checks were not completed.';
    case 'timed_out': case 'timeout': return 'The allowed testing time ended before this work finished.';
    case 'provider_unavailable': case 'provider_rejected_request': case 'provider_stream_interrupted': return 'The AI provider did not complete a request. The agent could not finish this stage.';
    case 'provider_authentication_failed': return 'The AI provider rejected the configured account access. Staff must check it before another assessment can run.';
    case 'provider_rate_limited': return 'The AI provider limited a request. This stage stopped before completing; saved website evidence remains available.';
    case 'provider_context_limit': return 'The request exceeded the AI provider’s input limit. This stage could not finish.';
    case 'provider_invalid_json': case 'provider_missing_completion_id': case 'provider_missing_message': case 'unexpected_provider_response': return 'The AI provider returned a response the runner could not interpret. This stage is incomplete; it is not a finding about your website.';
    case 'near_attestation_unavailable': case 'near_model_attestation_required': case 'near_signature_unavailable': case 'near_model_signature_required': case 'near_verification_timeout': return 'NEAR AI verification could not be completed. The agent stopped rather than trust an unverified model response. Saved website requests remain available; this stage needs another assessment.';
    case 'cancelled': return 'This stage was cancelled. Work already recorded remains available.';
    case 'invalid_tool_records': return 'The runner could not validate the recorded tool output. Its conclusions need review.';
    case undefined: return 'Some checks or supporting evidence are incomplete. Review the recorded limits before relying on these findings.';
    default: return 'The runner could not finish this stage. The technical details include its recorded stop reason.';
  }
}

export function roleOutcome(step: LiveStep): { label: string; detail: string } {
  if (!step.result) return ['running', 'leased'].includes(step.state) ? { label: 'Working', detail: roleDuties[step.role] } : ['waiting', 'queued'].includes(step.state) ? { label: 'Waiting', detail: 'This stage has not started.' } : { label: 'No report', detail: 'This stage ended without a saved report.' };
  if (!step.result.assessment) return { label: 'No assessment', detail: stopExplanation(step.result.execution.failure_reason) };
  return step.evidence_complete ? { label: 'Assessment received', detail: 'Findings and request evidence are available. The agent’s conclusions still need review.' } : { label: 'Partial assessment', detail: stopExplanation(step.result.execution.failure_reason) };
}

/** First cited request, with access kept visible inside a grouped observation. */
export function findingRequest(claim: FindingContribution): string {
  const evidence = claim.result.evidence.find(e => e.id === claim.finding.evidence_ids[0]);
  return evidence ? `${evidence.authenticated === true ? 'Test account' : 'Anonymous'} · ${evidence.method} ${evidence.url}` : 'Request evidence unavailable';
}

/** Match the claim and first request, preserving different access contexts as
 * contributions to the same observation. A shared control URL elsewhere must
 * not join unrelated findings. Grouping is presentation, never consensus. */
export function reportFindings(input: ReportInput): ReportFinding[] {
  const claims = input.steps.flatMap(s => s.result?.assessment?.findings.map((finding, i) => ({
    id: `${({ investigator: 'S', reproducer: 'R', challenger: 'V' })[s.role]}-${String(i + 1).padStart(2, '0')}`,
    role: s.role, finding, result: s.result!, complete: s.evidence_complete === true,
  })) ?? []);
  const groups = new Map<string, ReportFinding[]>();
  for (const claim of claims) {
    const evidence = claim.result.evidence.find(e => e.id === claim.finding.evidence_ids[0]);
    // This spelling variant means the same HTTP header. No semantic/fuzzy
    // title matching: different causes, paths, queries and inputs stay separate.
    const title = claim.finding.title.toLowerCase().trim().replace(/\s+/g, ' ').replace(/\bstrict-transport-security header\b/g, 'strict-transport-security');
    const key = evidence?.status != null ? JSON.stringify([title, evidence.method, evidence.url, evidence.request_body_sha256 ?? null]) : claim.id;
    const bucket = groups.get(key) ?? [];
    const group = bucket.find(g => !g.contributions.some(c => c.role === claim.role));
    if (group) group.contributions.push(claim);
    else bucket.push({ ...claim, contributions: [claim], disputed: false });
    groups.set(key, bucket);
  }
  const rank = (f: LiveFinding) => severities.indexOf(f.severity as typeof severities[number]);
  return [...groups.values()].flat().map(group => {
    const highest = group.contributions.reduce((a, b) => rank(a.finding) <= rank(b.finding) ? a : b);
    const support = new Set(group.contributions.map(c => ['observed', 'reproduced'].includes(c.finding.support) ? 'positive' : c.finding.support));
    return { ...group, role: highest.role, finding: highest.finding, result: highest.result,
      complete: group.contributions.every(c => c.complete),
      disputed: support.size > 1 || new Set(group.contributions.map(c => c.finding.severity)).size > 1 };
  }).sort((a, b) => rank(a.finding) - rank(b.finding));
}

export function expectedReports(input: Pick<ReportInput, 'review_policy' | 'third_review'>) {
  return input.review_policy === 'investigate_verify_v1' && !input.third_review?.reasons.length ? 2 : 3;
}
export function reviewMethod(input: Pick<ReportInput, 'review_policy' | 'third_review'>) {
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
  const partial = complete < expected || input.state !== 'completed' || input.review_policy === 'investigate_verify_v1' && !input.third_review;
  const headline = !finished ? 'Assessment in progress' : partial ? 'Partial assessment' : 'Assessment received';
  const claims = findings.reduce((n, f) => n + f.contributions.length, 0);
  const description = `${assessments} of ${expected} agents returned usable assessments. ${findings.length} ${findings.length === 1 ? 'observation is' : 'observations are'} listed below${claims > findings.length ? `, grouping ${claims} agent claims` : ''}${partial ? '; unfinished work is listed separately' : ''}. ${partial ? 'This run cannot establish that your website is safe.' : 'These are agent-reported findings, not a certification of security.'}`;
  return { findings, assessments, complete, expected, requests, finished, partial, headline, description };
}

export function toolOutcome(run: NonNullable<LiveResult['tool_runs']>[number]) {
  if (run.failure || run.exit_code !== 0) return 'Incomplete';
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
  return (result?.tool_runs ?? []).filter(t => t.tool === 'patchriot-baseline' && !t.output_truncated).flatMap(t => {
    try {
      const data = JSON.parse(t.output_excerpt);
      if (data.profile !== 'web-checks-v1' || !Array.isArray(data.checks) || data.checks.length > 40) return [];
      return data.checks.filter((c: CoverageCheck) => c && ['id', 'origin', 'title', 'summary'].every(k => typeof c[k as keyof CoverageCheck] === 'string' && String(c[k as keyof CoverageCheck]).length <= 2000) && ['completed', 'finding', 'inconclusive', 'skipped', 'unsupported'].includes(c.status) && Array.isArray(c.evidence_ids) && c.evidence_ids.every(id => t.evidence_ids.includes(id) && result!.evidence.some(e => e.id === id)));
    } catch { return []; }
  });
}
export const checkLabels: Record<string, string> = { completed: 'Completed', finding: 'Potential issue', inconclusive: 'Inconclusive', skipped: 'Skipped', unsupported: 'Unsupported' };
