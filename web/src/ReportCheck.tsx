import { useState } from 'react';
import { api, write } from './api';
import { useLive } from './useLive';
import { saveReportFile } from './LiveReport';

type Check = {
  state: 'not_requested' | 'queued' | 'running' | 'verified' | 'unavailable' | 'deleted';
  model: string; can_request: boolean;
  result?: { advisory_only: true; advice: { duplicate_groups: string[][]; review_ids: string[]; explanation: string }; omitted_findings: number; receipt: { kind: string; request_sha256: string; response_sha256: string; signer: string } };
};
const active = (check: Check) => ['queued', 'running'].includes(check.state);
function name(id: string) { return id.replace(/^investigator-/, 'Scout #').replace(/^reproducer-/, 'Recon #').replace(/^challenger-/, 'Verifier #'); }

/** A receipt authenticates the model's bytes; it cannot certify a finding. */
export function ReportCheck({ id, csrf, beforeExport }: { id: string; csrf: string; beforeExport: () => Promise<unknown> }) {
  const path = `/reviews/${id}/consistency-check`;
  const check = useLive<Check>(path, true, 5_000, active);
  const [consent, setConsent] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  async function request() {
    setBusy(true); setError('');
    try { await write(path, csrf, { accepts_near_ai: consent }); check.refresh(); }
    catch (e) { setError((e as Error).message); check.refresh(); }
    finally { setBusy(false); }
  }
  async function download() {
    setBusy(true); setError('');
    try {
      // Starts the same fixed report-retention clock as the other exports.
      await beforeExport();
      const latest = await api<Check>(path);
      if (latest.state !== 'verified' || latest.result?.receipt.kind !== 'provider_tee') throw new Error('The verification receipt is no longer available.');
      saveReportFile(`patchriot-report-check-${id}.json`, JSON.stringify(latest.result, null, 2), 'application/json');
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  if (!check.data || check.data.state === 'deleted' || check.data.state === 'not_requested' && !check.data.can_request) return null;
  const result = check.data.state === 'verified' && check.data.result?.receipt.kind === 'provider_tee' ? check.data.result : null;
  return <details className="assessment-disclosure report-technical" aria-label="NEAR AI report check">
    <summary>Optional report check · NEAR AI</summary>
    <p>A separate model can flag possible duplicate findings and claims that need closer review. It does not run more website tests or change this report.</p>
    {check.data.state === 'not_requested' && <>
      <label className="check"><input type="checkbox" checked={consent} onChange={e => setConsent(e.target.checked)} /><span>Send finding excerpts and request metadata to NEAR AI for this check. Raw HTTP captures and saved login credentials are excluded.</span></label>
      <p className="fine">One attempt per finished report, included in this pilot. The check and receipt share the report’s deletion time.</p>
      <button className="quiet" disabled={!consent || busy} onClick={() => void request()}>Check this report</button>
    </>}
    {active(check.data) && <p role="status">{check.data.state === 'queued' ? 'Waiting for the report checker.' : 'Checking the summaries and verifying the model’s signature.'}</p>}
    {check.data.state === 'unavailable' && <p className="notice">This check could not be completed and verified. The original report remains available. It will not be charged or run again automatically.</p>}
    {result && <>
      <h3>Model-signed advice</h3><p>{result.advice.explanation}</p>
      {result.advice.duplicate_groups.length > 0 && <><h4>Possible duplicates to compare</h4><ul>{result.advice.duplicate_groups.map((group, index) => <li key={index}>{group.map(name).join(' · ')}</li>)}</ul></>}
      {result.advice.review_ids.length > 0 && <p><strong>Look more closely at:</strong> {result.advice.review_ids.map(name).join(', ')}. These numbers refer to each agent’s original finding order.</p>}
      {result.omitted_findings > 0 && <p className="notice">{result.omitted_findings} findings were outside this bounded check.</p>}
      <p className="fine">NEAR’s SDK verified model attestation and a signature over the exact check input and output. This does not attest to the Kali agents, identify a particular physical machine or prove any vulnerability. No claim of audited model code or end-to-end encryption is made.</p>
      <button className="quiet" disabled={busy} onClick={() => void download()}>Download check & signature ↓</button>
    </>}
    <p className="fine">Model: {check.data.model}. The signed receipt contains the exact check messages; share it as carefully as the report.</p>
    {(error || check.error) && <p className="notice error" role="alert">{error || check.error}</p>}
  </details>;
}
