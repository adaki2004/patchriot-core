/** A deliberately small formatter. Report text never becomes HTML or links. */
export type ReportBlock = { kind: 'prose' | 'code'; text: string; language: string };
export function prettyJson(value: string): string {
  if (!/^[\s]*[\[{]/.test(value)) return value;
  try { const parsed: unknown = JSON.parse(value); return parsed !== null && typeof parsed === 'object' ? JSON.stringify(parsed, null, 2) : value; }
  catch { return value; }
}
export function reportBlocks(text: string): ReportBlock[] {
  const blocks: ReportBlock[] = [];
  const prose = (value: string) => {
    if (!value.trim()) return;
    const pretty = prettyJson(value);
    if (pretty !== value || /^[\s]*[\[{]/.test(value) && (() => { try { JSON.parse(value); return true; } catch { return false; } })()) blocks.push({ kind: 'code', text: pretty, language: 'json' });
    else for (const paragraph of value.trim().split(/\n[ \t]*\n/)) blocks.push({ kind: 'prose', text: paragraph, language: '' });
  };
  let cursor = 0;
  const fences = /^(`{3,}|~{3,})[ \t]*([a-z0-9_+.-]*)[ \t]*\r?\n([\s\S]*?)^\1[ \t]*$/gmi;
  for (const match of text.matchAll(fences)) {
    prose(text.slice(cursor, match.index));
    blocks.push({ kind: 'code', text: match[2].toLowerCase() === 'json' ? prettyJson(match[3]) : match[3].replace(/\r?\n$/, ''), language: match[2].toLowerCase() });
    cursor = match.index + match[0].length;
  }
  prose(text.slice(cursor));
  return blocks;
}
export function fencedText(value: string, language = 'text') {
  const fence = '`'.repeat(Array.from(value.matchAll(/`+/g)).reduce((max, m) => Math.max(max, m[0].length + 1), 3));
  return `${fence}${language}\n${value}\n${fence}`;
}
/** Escape Markdown controls and HTML so a payload cannot embed a remote image. */
export function reportMarkdownText(text: string) {
  return reportBlocks(text).map(block => block.kind === 'code' ? fencedText(block.text, block.language || 'text') : block.text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/([\\`*_[\]{}()#+.!|~])/g, '\\$1')).join('\n\n');
}
