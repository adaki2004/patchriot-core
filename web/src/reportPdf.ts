import { reportBlocks } from './reportFormatting';
import { fallbackDescription } from './LiveReport';
import { coverageChecks, checkLabels, findingRequest } from './report';
import { PDFDocument, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { reportSummary, reviewMethod, reportRoles, roleMethods, roleOutcome, supportLabels, severities, teamDescription, toolOutcome, reportLimits, type ReportInput } from './report';

const ink = rgb(.09, .12, .19), muted = rgb(.36, .40, .48), blue = rgb(.25, .40, .75), red = rgb(.82, .26, .27);
const width = 595.28, height = 841.89, margin = 48, lineWidth = width - margin * 2;

/** Text-only drawing: report data cannot create HTML, links, scripts or fetches. */
class Pages {
  page!: PDFPage;
  y = 0;
  section = '';
  readonly contents: { title: string; page: number }[] = [];
  readonly charset: Set<number>;
  readonly doc: PDFDocument;
  readonly font: PDFFont;
  readonly mono: PDFFont;
  substituted = false;
  constructor(doc: PDFDocument, font: PDFFont, mono: PDFFont) { this.doc = doc; this.font = font; this.mono = mono; this.charset = new Set(font.getCharacterSet()); }
  text(value: string) {
    return Array.from(value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')).map(c => {
      if (c === '\n' || c === '\t') return c === '\t' ? '    ' : c;
      if (this.charset.has(c.codePointAt(0)!)) return c;
      this.substituted = true;
      return `[U+${c.codePointAt(0)!.toString(16).toUpperCase()}]`;
    }).join('');
  }
  newPage(section = this.section) {
    this.section = section;
    this.page = this.doc.addPage([width, height]); this.y = height - 86;
    this.page.drawRectangle({ x: margin, y: height - 45, width: 28, height: 3, color: red });
    this.page.drawRectangle({ x: margin + 28, y: height - 45, width: 28, height: 3, color: blue });
    this.page.drawText('PATCHRIOT / PRIVATE ASSESSMENT', { x: margin + 68, y: height - 46, size: 9, font: this.font, color: muted });
    this.page.drawLine({ start: { x: margin, y: 49 }, end: { x: width - margin, y: 49 }, color: rgb(.85, .87, .90), thickness: .5 });
    this.page.drawText(section, { x: margin, y: 32, size: 8, font: this.font, color: muted });
  }
  ensure(space: number) { if (this.y - space < 70) this.newPage(); }
  paragraph(value: string, size = 10, color = ink, indent = 0) {
    const leading = size * 1.5, max = lineWidth - indent;
    const safe = this.text(value);
    this.y -= Math.max(0, size - 10);
    for (const paragraph of safe.split('\n')) {
      let line = '';
      const emit = () => { this.ensure(leading); if (line) this.page.drawText(line, { x: margin + indent, y: this.y, font: this.font, size, color }); this.y -= leading; line = ''; };
      for (const word of paragraph.split(/ +/)) {
        if (this.font.widthOfTextAtSize(line ? `${line} ${word}` : word, size) <= max) { line += `${line ? ' ' : ''}${word}`; continue; }
        if (line) emit();
        for (const c of word) { if (this.font.widthOfTextAtSize(line + c, size) > max) emit(); line += c; }
      }
      emit();
    }
    this.y -= 7;
  }
  formatted(value: string) {
    for (const block of reportBlocks(value)) {
      if (block.kind === 'prose') { this.paragraph(block.text); continue; }
      this.ensure(55);
      this.paragraph(block.language ? `CODE / ${block.language.toUpperCase()}` : 'CODE / EVIDENCE', 8, muted);
      const size = 9, leading = 14, available = lineWidth - 20;
      const charset = new Set(this.mono.getCharacterSet());
      const safe = this.text(block.text).replace(/./gu, c => charset.has(c.codePointAt(0)!) ? c : `[U+${c.codePointAt(0)!.toString(16).toUpperCase()}]`);
      const emit = (line: string) => {
        this.ensure(leading + 8);
        this.page.drawRectangle({ x: margin, y: this.y - 4, width: lineWidth, height: leading, color: rgb(.93, .95, .98) });
        if (line) this.page.drawText(line, { x: margin + 10, y: this.y, font: this.mono, size, color: ink });
        this.y -= leading;
      };
      for (const line of safe.split('\n')) {
        let wrapped = '';
        for (const c of line) { if (this.mono.widthOfTextAtSize(wrapped + c, size) > available) { emit(wrapped); wrapped = ''; } wrapped += c; }
        emit(wrapped);
      }
      this.y -= 12;
    }
  }
  heading(value: string, level = 2) { this.ensure(level === 1 ? 96 : 60); this.y -= 10; this.paragraph(value, level === 1 ? 25 : 13, level === 1 ? ink : blue); }
  begin(title: string) { this.newPage(title); this.contents.push({ title, page: this.doc.getPageCount() }); this.heading(title, 1); }
  label(label: string, value: string) { this.ensure(52); this.paragraph(label.toUpperCase(), 8, muted); this.paragraph(value); }
}

async function asset(path: string) {
  const response = await fetch(path, { credentials: 'same-origin' });
  if (!response.ok) throw new Error('A report asset could not be loaded. Please try the download again.');
  return response.arrayBuffer();
}

/** Generated locally from the authorized report. No customer data leaves the browser. */
export async function createReportPdf(input: ReportInput): Promise<Uint8Array> {
  const [fontBytes, logoBytes, monoBytes] = await Promise.all([asset('/fonts/ibm-plex-sans-variable.ttf'), asset('/brand/white-hat.png'), asset('/fonts/ibmplexmono-400.woff2')]);
  const doc = await PDFDocument.create(); doc.registerFontkit(fontkit);
  const font = await doc.embedFont(fontBytes, { subset: true });
  const logo = await doc.embedPng(logoBytes);
  const summary = reportSummary(input);
  const generated = new Date();
  doc.setTitle('Patchriot vulnerability report'); doc.setAuthor('Patchriot'); doc.setSubject('Automated website assessment'); doc.setCreationDate(generated);
  const mono = await doc.embedFont(monoBytes, { subset: true });
  const p = new Pages(doc, font, mono);
  const cover = doc.addPage([width, height]);
  cover.drawRectangle({ x: 0, y: 0, width, height, color: ink });
  cover.drawRectangle({ x: 0, y: 0, width: width / 2, height: 8, color: red });
  cover.drawRectangle({ x: width / 2, y: 0, width: width / 2, height: 8, color: blue });
  const logoSize = logo.scaleToFit(80, 80);
  cover.drawImage(logo, { x: margin - 8, y: height - 137, ...logoSize });
  cover.drawText('patchriot_', { x: margin + 85, y: height - 103, size: 24, font, color: rgb(.96, .96, .98) });
  p.page = cover; p.y = height - 225;
  p.paragraph('PRIVATE / AUTOMATED SECURITY ASSESSMENT', 10, rgb(.67, .74, .88));
  p.paragraph('Vulnerability\nreport', 44, rgb(1, 1, 1));
  p.y -= 16;
  p.paragraph(input.origins.join('\n') || 'Website assessment', 20, rgb(.83, .88, .98));
  p.paragraph(summary.headline, 15, rgb(1, .65, .57));
  p.y = 215;
  p.paragraph(`Started ${new Date(input.created_at * 1000).toISOString().replace('T', ' ').replace('.000Z', ' UTC')}`, 10, rgb(.78, .82, .88));
  p.paragraph(`${summary.findings.length} observations / ${summary.assessments} of ${summary.expected} usable assessments`, 12, rgb(.94, .95, .98));
  p.paragraph(`Report ${input.id}`, 9, rgb(.66, .73, .84));
  p.paragraph('Prepared from saved agent reports. Incomplete work is disclosed; this is not a certification of security.', 10, rgb(.78, .82, .88));

  p.newPage('Contents'); const contentsPage = p.page;
  p.begin('01 / Executive summary');
  p.paragraph(summary.description, 12);
  p.paragraph(reviewMethod(input));
  p.label('Status', summary.headline);
  p.label('Results at a glance', `${summary.assessments} usable assessments. ${summary.complete} roles with complete recorded evidence. ${summary.requests} recorded HTTP requests.`);
  p.heading('Reported severity');
  for (const severity of severities) p.paragraph(`${severity === 'info' ? 'Informational' : severity[0].toUpperCase() + severity.slice(1)}: ${summary.findings.filter(r => r.finding.severity === severity).length}`, 11);
  p.heading('How to use this report');
  p.paragraph('Start with the numbered findings. Repeat claims with matching titles and first cited requests are grouped. Anonymous and test-account checks stay visible within that observation. Each original contribution remains available. Differences in severity or support are marked for review, with the highest reported severity shown. Agreement is not independent confirmation. Informational observations may describe intentional behavior.');
  p.paragraph(summary.partial ? 'Follow up on the incomplete stages before treating this assessment as finished. A missing report is not a report of no vulnerabilities.' : 'Validate material findings and retest any changes. A completed automated run cannot establish the absence of vulnerabilities.');
  p.paragraph(reportLimits, 10, muted);

  p.begin('02 / Scope & method');
  p.label('Authorized origins', input.origins.join('\n'));
  p.label('Profile', input.profile ?? 'Recorded custom scope');
  p.label('Test-account scope', input.authentication ? `${input.authentication === 'basic' ? 'HTTP Basic' : input.authentication === 'session' ? 'Session login' : 'Bearer token'} · protected control path ${input.auth_check_path ?? 'not recorded'}. Credentials are not included.` : 'No test account supplied.');
  p.label('Approved HTTP methods', input.methods?.join(', ') ?? 'See the saved scope');
  p.label('Scope fingerprint (SHA-256)', input.scope_sha256 ?? 'Not recorded');
  p.heading('Assessment process');
  p.paragraph('Scout investigates the application and records leads. Recon attempts to reproduce or challenge them. When scheduled, Verifier reviews the evidence and impact. Requests are constrained by the approved target scope and execution budget. Tool executions, final assessments and coverage limitations are recorded separately.');
  p.paragraph(teamDescription(input));
  p.paragraph('Evidence is reported by the operators. This document does not attest their honesty, independently verify a model’s identity or demonstrate that a suggested fix works.');

  p.begin('03 / Agent contributions');
  for (const s of input.steps) {
    p.ensure(200);
    p.heading(`${reportRoles[s.role]} — ${roleOutcome(s).label}`);
    p.paragraph(roleOutcome(s).detail);
    if (!s.result) continue;
    p.paragraph(`${s.result.evidence.length} recorded requests · ${s.result.execution.inference_calls} model calls · ${Math.round(s.result.execution.duration_ms / 1000)} seconds`, 9, muted);
    if (s.result.execution.fallback) p.paragraph(fallbackDescription(s.result.execution.fallback), 9, muted);
    p.label('Primary provider / model', `${s.result.execution.provider} / ${s.result.execution.model}`);
    p.formatted(s.result.assessment?.summary ?? 'No usable assessment was returned. Request and tool records do not by themselves establish a vulnerability.');
    const refs = summary.findings.filter(f => f.contributions.some(c => c.role === s.role)).map(f => f.id);
    if (refs.length) p.paragraph(`Observations: ${refs.join(', ')}`, 10, blue);
  }

  p.begin('04 / Findings');
  if (!summary.findings.length) p.paragraph('No findings are available in the saved assessments. Read the execution and coverage limitations before interpreting this result.');
  summary.findings.forEach((row, i) => {
    if (i) p.newPage('04 / Findings');
    const f = row.finding;
    p.paragraph(`${row.id} / ${f.severity.toUpperCase()} / ${reportRoles[row.role].toUpperCase()}`, 10, blue);
    p.heading(f.title, 1);
    p.paragraph(`${supportLabels[f.support] ?? 'Unconfirmed'}${row.complete ? '' : ' · From a partial assessment'}. Severity and support are the agent’s assessment.`, 10, muted);
    if (row.disputed) p.paragraph('Roles differ — review needed. The highest reported severity is shown, not a confirmed verdict.', 11, blue);
    p.heading('Observation & impact'); p.formatted(f.explanation);
    p.heading('Recommended action'); p.formatted(f.suggested_action);
    p.paragraph('Recommendation only. No patch was applied or retested.', 9, muted);
    p.heading('Reproduction recorded by the agent'); p.formatted(f.reproduction);
    for (const c of row.contributions) {
      p.heading(`${reportRoles[c.role]} — supporting contribution`);
      p.paragraph(`${c.finding.severity} · ${supportLabels[c.finding.support] ?? c.finding.support}${c.complete ? '' : ' · Partial assessment'}`, 9, muted);
      p.label('First cited request', findingRequest(c));
      if (c.finding.explanation !== f.explanation) p.formatted(c.finding.explanation);
      if (c.finding.reproduction !== f.reproduction) { p.heading('Reproduction'); p.formatted(c.finding.reproduction); }
      if (c.finding.suggested_action !== f.suggested_action) { p.heading('Suggested action'); p.formatted(c.finding.suggested_action); }
      for (const id of c.finding.evidence_ids) {
        const e = c.result.evidence.find(e => e.id === id);
        if (!e) { p.paragraph(`${reportRoles[c.role]} #${id}: missing from the recorded evidence.`); continue; }
        p.paragraph(`${reportRoles[c.role]} #${id} · ${e.authenticated === true ? 'Test account' : 'Anonymous'} · ${e.method} · HTTP ${e.status ?? 'no response'}`, 10, blue);
        p.paragraph(e.url, 9);
        if (e.body_sha256) p.paragraph(`Response fingerprint: ${e.body_sha256}`, 8, muted);
      }
    }
    p.paragraph('Response excerpts, headers and tool transcripts are available in the private report’s Technical evidence view and the separate evidence JSON download. References are scoped to their agent.', 9, muted);
  });

  p.begin('05 / Coverage & limitations');
  for (const s of input.steps) {
    p.heading(reportRoles[s.role]);
    for (const c of coverageChecks(s.result)) { p.paragraph(`${c.title} — ${checkLabels[c.status]}`, 10, blue); p.paragraph(c.summary, 9); p.paragraph(`${c.origin} · Requests: ${c.evidence_ids.join(', ') || 'none'}`, 8, muted); }
    const limits = s.result?.assessment?.limitations;
    if (limits?.length) limits.forEach((limit, i) => p.paragraph(`${i + 1}. ${limit}`));
    else p.paragraph(roleOutcome(s).detail);
  }
  p.begin('06 / Tool register & record');
  p.paragraph('Discovery tools map the site; later roles check specific claims. Older reports may repeat scanners. The register below shows what actually ran; assigned methods alone do not establish coverage.', 9, muted);
  for (const s of input.steps) {
    p.heading(reportRoles[s.role]);
    p.paragraph('Assigned methods: ' + roleMethods[s.role].join('; '), 9, muted);
    if (!s.result?.tool_runs?.length) p.paragraph('No tool execution records were received.');
    for (const t of s.result?.tool_runs ?? []) {
      p.paragraph(`${t.tool} / ${t.version}`, 11, blue);
      p.paragraph(`${toolOutcome(t)} · ${Math.round(t.duration_ms / 1000)} seconds · ${t.evidence_ids.length} request references${t.failure ? ` · Recorded reason: ${t.failure}` : ''}`, 9);
      p.paragraph(`Output SHA-256: ${t.output_sha256}${t.output_truncated ? '. Retained excerpt was shortened.' : ''}`, 8, muted);
    }
  }
  p.heading('Report record');
  p.label('Generated (UTC)', generated.toISOString());
  p.label('Assessment ID', input.id);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(input)));
  p.label('Export input fingerprint (SHA-256)', Array.from(new Uint8Array(digest), n => n.toString(16).padStart(2, '0')).join(''));
  p.paragraph('This fingerprint identifies the input to this browser-generated document; it is not a server signature or attestation. Raw transcripts are intentionally separate from the report. Retain the private evidence JSON with this document for technical review.', 9, muted);
  if (p.substituted) p.paragraph('Characters not available in the report font are written as [U+codepoint]. The evidence JSON preserves the original text.', 9, muted);
  p.paragraph(reportLimits, 9, muted);
  p.page = contentsPage; p.y = height - 86; p.heading('Contents', 1);
  p.paragraph('A readable report, with technical evidence kept separately.', 11, muted);
  p.y -= 20;
  p.contents.forEach(item => { p.paragraph(`${item.title}                                      ${item.page}`, 13); p.y -= 10; });
  const pages = doc.getPages();
  pages.forEach((page, i) => { if (i > 0) page.drawText(`${i + 1} / ${pages.length}`, { x: width - margin - 38, y: 32, font, size: 8, color: muted }); });
  return doc.save();
}
