import { Fragment } from 'react';
import { reportBlocks } from './reportFormatting';
function Inline({ text }: { text: string }) {
  return <>{text.split(/(`[^`\n]+`)/g).map((part, i) => part.startsWith('`') && part.endsWith('`') ? <code key={i}>{part.slice(1, -1)}</code> : <Fragment key={i}>{part}</Fragment>)}</>;
}
export function ReportText({ text }: { text: string }) {
  return <div className="report-prose">{reportBlocks(text).map((block, i) => {
    if (block.kind === 'code') return <figure className="remediation-example" key={i}><figcaption>Code / evidence{block.language ? ` · ${block.language}` : ''}</figcaption><pre><code>{block.text}</code></pre></figure>;
    const lines = block.text.split('\n');
    if (lines.length > 1 && lines.every(line => /^\s*[-*]\s+/.test(line))) return <ul key={i}>{lines.map((line, j) => <li key={j}><Inline text={line.replace(/^\s*[-*]\s+/, '')} /></li>)}</ul>;
    if (lines.length > 1 && lines.every(line => /^\s*\d+[.)]\s+/.test(line))) return <ol key={i}>{lines.map((line, j) => <li key={j}><Inline text={line.replace(/^\s*\d+[.)]\s+/, '')} /></li>)}</ol>;
    return <p className="finding-prose" key={i}><Inline text={block.text} /></p>;
  })}</div>;
}
