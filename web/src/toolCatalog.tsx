/** Public attribution for the deployed tool families; receipts identify actual execution. */
export const toolCatalog = {
  patchriot: {name:'Patchriot adapters', url:'https://github.com/adaki2004/patchriot-relay', license:'AGPL-3.0-only', licenseUrl:'https://github.com/adaki2004/patchriot-relay/blob/main/LICENSE', purpose:'Bounded HTTP checks, route discovery, access verification and evidence accounting.'},
  hermes: {name:'Hermes Agent', url:'https://github.com/NousResearch/hermes-agent', license:'MIT', licenseUrl:'https://github.com/NousResearch/hermes-agent/blob/main/LICENSE', purpose:'Plans follow-up checks, investigates observations and validates findings inside the approved scope.'},
  nuclei: {name:'Nuclei', url:'https://github.com/projectdiscovery/nuclei', license:'MIT', licenseUrl:'https://github.com/projectdiscovery/nuclei/blob/main/LICENSE.md', purpose:'Runs curated HTTP signatures. ProjectDiscovery is its maintainer; unrestricted template packs are not enabled.'},
  ares: {name:'ARES-derived fingerprints', url:'https://github.com/Mafifrizi/ARES', license:'MIT', licenseUrl:'https://github.com/Mafifrizi/ARES/blob/d09251374a82042f2d8069818febcb08289aa3d5/LICENSE', purpose:'Adapted technology and exposed-path signatures. The full ARES framework is not run.'},
  ffuf: {name:'ffuf', url:'https://github.com/ffuf/ffuf', license:'MIT', licenseUrl:'https://github.com/ffuf/ffuf/blob/master/LICENSE', purpose:'Tests a bounded candidate-path list against missing-page controls.'},
  zap: {name:'ZAP', url:'https://www.zaproxy.org/', license:'Apache-2.0', licenseUrl:'https://github.com/zaproxy/zaproxy/blob/main/LICENSE', purpose:'Checks selected responses and, with active-test permission, a selected reflected-input rule. This is not a full unrestricted ZAP scan.'},
  schemathesis: {name:'Schemathesis', url:'https://github.com/schemathesis/schemathesis', license:'MIT', licenseUrl:'https://github.com/schemathesis/schemathesis/blob/master/LICENSE', purpose:'Generates bounded read cases from an observed API schema. No supported schema means not applicable.'},
  chromium: {name:'Chromium', url:'https://www.chromium.org/', license:'BSD and bundled third-party licenses', licenseUrl:'https://chromium.googlesource.com/chromium/src/+/main/LICENSE', purpose:'Renders the website in the restricted browser.'},
  playwright: {name:'Playwright', url:'https://github.com/microsoft/playwright', license:'Apache-2.0', licenseUrl:'https://github.com/microsoft/playwright/blob/main/LICENSE', purpose:'Controls scoped browser navigation and verifies account access.'},
  'agent-browser': {name:'agent-browser', url:'https://github.com/vercel-labs/agent-browser', license:'Apache-2.0', licenseUrl:'https://github.com/vercel-labs/agent-browser/blob/main/LICENSE', purpose:'Browser controls available to the investigator through the scoped browser.'},
} as const;
export type ToolKey = keyof typeof toolCatalog;
/** Shared names and explanations for setup and the hosted check guide. */
export const websiteChecks: {id: string; title: string; summary: string; description: string; sources: ToolKey[]; optional?: boolean}[] = [
  {id:'public_baseline', title:'Headers & configuration', summary:'Browser policies and exposed settings', description:'Inspect response headers, browser security policies and exposed configuration on the approved website.', sources:['patchriot']},
  {id:'public_mapping', title:'Map routes', summary:'Pages, forms and API paths', description:'Follow public links and identify forms and API paths within the approved origin. Discovering a route does not establish a vulnerability.', sources:['patchriot']},
  {id:'public_signatures', title:'Known signatures', summary:'Curated vulnerability patterns', description:'Check responses against selected Nuclei HTTP templates. Matches need supporting evidence before becoming findings.', sources:['nuclei']},
  {id:'public_fingerprints', title:'Web fingerprints', summary:'Technologies and exposed paths', description:'Compare technology hints and exposed paths with normal missing-page responses using ARES-derived signatures.', sources:['ares']},
  {id:'public_analysis', title:'Web & API checks', summary:'Route discovery and scanner checks', description:'Run bounded route discovery, ZAP checks and API-schema tests. Grey-box runs can include verified account access; no supported API schema means that part is not applicable.', sources:['ffuf','zap','schemathesis','patchriot']},
  {id:'public_deep', title:'Deep scan', summary:'Extra probes · more requests and time', description:'Add script and route mining, access-control path variations, header/cache probes and observed-input probes. Cross-account comparisons need two verified test accounts and relevant object routes. Even read requests can have side effects.', sources:['patchriot'], optional:true},
];
export function ToolLinks({tools}: {tools: readonly ToolKey[]}) {
  return <span className="tool-source-links">{tools.map((id,index)=><span key={id}>{index > 0 && ' · '}<a href={toolCatalog[id].url} target="_blank" rel="noreferrer" title={toolCatalog[id].purpose}>{toolCatalog[id].name}</a></span>)}</span>;
}
export function ToolAttributions() {
  return <div className="table-scroll"><table><thead><tr><th>Tool</th><th>Purpose in Patchriot</th><th>License</th></tr></thead><tbody>{Object.entries(toolCatalog).map(([id,tool])=><tr key={id}><td><a href={tool.url} target="_blank" rel="noreferrer">{tool.name}</a></td><td>{tool.purpose}</td><td><a href={tool.licenseUrl} target="_blank" rel="noreferrer">{tool.license}</a></td></tr>)}</tbody></table></div>;
}
export function toolSource(tool: string) {
  if (tool.startsWith('patchriot-')) return toolCatalog.patchriot;
  if (tool === 'ares-web-surface') return toolCatalog.ares;
  return toolCatalog[tool as ToolKey];
}
