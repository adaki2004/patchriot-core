import { expect, test } from '@playwright/test';
import { fencedText, prettyJson, reportBlocks, reportMarkdownText } from '../src/reportFormatting';

test('report formatting separates prose, preserves code and indents structured evidence', () => {
  const body = 'Check `debug`.\n\n```json\n{"debug":true,"nested":{"n":1}}\n```\n\nRetest after changing it.';
  const parts = reportBlocks(body);
  expect(parts.map(p => p.kind)).toEqual(['prose', 'code', 'prose']);
  expect(parts[1].language).toBe('json');
  expect(parts[1].text).toBe('{\n  "debug": true,\n  "nested": {\n    "n": 1\n  }\n}');
  expect(reportBlocks('{"debug":false}')[0].kind).toBe('code');
  const mixed = reportBlocks('A response was recorded.\n\n{"debug":true}\n\nRetest the route.');
  expect(mixed.map(p => p.kind)).toEqual(['prose', 'code', 'prose']);
  expect(mixed[1].text).toBe('{\n  "debug": true\n}');
  expect(prettyJson('not JSON')).toBe('not JSON');
  expect(reportBlocks('```unfinished\nKeep this visible.')[0].text).toContain('Keep this visible.');
  const shell = 'if true; then\n  printf "done"\nfi';
  expect(reportBlocks(fencedText(shell, 'sh'))[0].text).toBe(shell);
});

test('Markdown exports cannot turn evidence into active HTML or remote images', () => {
  const payload = '<img src="https://untrusted.example/pixel">\n\n![tracking](https://untrusted.example/pixel)';
  const rendered = reportMarkdownText(payload);
  expect(rendered).not.toContain('<img');
  expect(rendered).not.toContain('![tracking]');
  expect(rendered).toContain('&lt;img');
  const code = '```\n<img src="https://untrusted.example/pixel">\n```';
  const wrapped = fencedText(code, 'html');
  expect(wrapped.startsWith('````html\n')).toBe(true);
  expect(reportBlocks(wrapped)).toEqual([{ kind: 'code', language: 'html', text: code }]);
});
