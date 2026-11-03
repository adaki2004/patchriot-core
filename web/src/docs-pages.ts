export const docPages = [
  { id: 'start', title: 'Start here', group: 'Patchriot' },
  { id: 'infrastructure', title: 'Public network or private team', group: 'Patchriot' },
  { id: 'workflow', title: 'How a review works', group: 'Patchriot' },
  { id: 'privacy', title: 'Who can see your data', group: 'Patchriot' },
  { id: 'request', title: 'Request a review', group: 'Using Patchriot' },
  { id: 'agents', title: 'Managed agents', group: 'Using Patchriot' },
  { id: 'payments', title: 'Price and payments', group: 'Using Patchriot' },
  { id: 'safety', title: 'Testing, risks & limits', group: 'Using Patchriot' },
  { id: 'deployment', title: 'Before going live', group: 'Under the hood' },
  { id: 'verify', title: 'Don’t trust. Verify.', group: 'Under the hood' },
  { id: 'architecture', title: 'Services and boundaries', group: 'Under the hood' },
] as const;
export type DocPage = typeof docPages[number]['id'];
export const isDocPage = (value: string): value is DocPage => docPages.some(page => page.id === value);
