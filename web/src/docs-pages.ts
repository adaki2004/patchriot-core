export const docPages = [
  { id: 'start', title: 'Start here', group: 'Your assessment' },
  { id: 'workflow', title: 'What is a review?', group: 'Your assessment' },
  { id: 'request', title: 'Start your test', group: 'Your assessment' },
  { id: 'payments', title: 'Free trials & payment', group: 'Your assessment' },
  { id: 'safety', title: 'Testing & questions', group: 'Understand the service' },
  { id: 'privacy', title: 'Who can see your data', group: 'Understand the service' },
  { id: 'infrastructure', title: 'Inside the network', group: 'Understand the service' },
  { id: 'agents', title: 'Meet the agents', group: 'Understand the service' },
] as const;
export type DocPage = typeof docPages[number]['id'];
export const isDocPage = (value: string): value is DocPage => docPages.some(page => page.id === value);
