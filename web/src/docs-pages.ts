export const docPages = [
  { id: 'start', title: 'Start here', group: 'Get started' },
  { id: 'workflow', title: 'What is a review?', group: 'Get started' },
  { id: 'request', title: 'Start your test', group: 'Get started' },
  { id: 'checks', title: 'Checks & tools', group: 'Get started' },
  { id: 'payments', title: 'Free trials & payment', group: 'Get started' },
  { id: 'infrastructure', title: 'Architecture', group: 'How it works' },
  { id: 'privacy', title: 'Who can see your data', group: 'How it works' },
  { id: 'safety', title: 'Testing & questions', group: 'How it works' },
] as const;
export type DocPage = typeof docPages[number]['id'];
export const isDocPage = (value: string): value is DocPage => docPages.some(page => page.id === value);
