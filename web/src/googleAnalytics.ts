const pages = {
  home: ['/', 'Patchriot'],
  docs: ['/docs', 'Patchriot docs'],
  incidents: ['/incidents', 'Patchriot recent events'],
  contact: ['/contact', 'Contact Patchriot'],
  dashboard: ['/workspace/dashboard', 'Patchriot workspace'],
  audits: ['/workspace/audits', 'Patchriot audits'],
  setup: ['/workspace/setup', 'Patchriot test setup'],
  report: ['/workspace/report', 'Patchriot report'],
  account: ['/workspace/account', 'Patchriot account'],
  orders: ['/workspace/orders', 'Patchriot orders'],
  agents: ['/workspace/agents', 'Patchriot agents'],
} as const;

export type AnalyticsPage = keyof typeof pages;
type GoogleWindow = Window & { dataLayer?: unknown[]; gtag?: (...args: unknown[]) => void };
let measurementId: string | null = null;
let lastPage: AnalyticsPage | null = null;

export function validMeasurementId(value?: string | null): value is string {
  return typeof value === 'string' && /^G-[A-Z0-9]{4,20}$/.test(value);
}

/** Use the standard Google tag, but never pass the SPA's actual URL, title,
 * referrer, account or report fields. Enhanced measurement must remain off in GA. */
export function countPage(id: string | null, page: AnalyticsPage | null) {
  const google = window as GoogleWindow;
  const flags = window as unknown as Record<string, unknown>;
  if (!validMeasurementId(id) || !page) {
    if (measurementId) flags['ga-disable-' + measurementId] = true;
    lastPage = null;
    return;
  }
  // A deployment has one stream. Do not load extra destinations if configuration changes mid-visit.
  if (measurementId && measurementId !== id) return;
  flags['ga-disable-' + id] = false;
  if (lastPage === page) return;
  lastPage = page;
  const [path, title] = pages[page];
  const fields = { page_location: location.origin + path, page_title: title, page_referrer: '' };
  if (!measurementId) {
    measurementId = id;
    google.dataLayer = google.dataLayer || [];
    google.gtag = function () { google.dataLayer!.push(arguments); };
    // Analytics follows the standard tag supplied by the site owner. Advertising stays disabled.
    google.gtag('consent', 'default', { ad_storage: 'denied', ad_user_data: 'denied', ad_personalization: 'denied' });
    google.gtag('set', 'ads_data_redaction', true);
    google.gtag('set', fields);
    google.gtag('js', new Date());
    google.gtag('config', id, { ...fields, send_page_view: false, allow_google_signals: false, allow_ad_personalization_signals: false, cookie_domain: 'none' });
    const script = document.createElement('script');
    script.async = true;
    script.referrerPolicy = 'no-referrer';
    script.src = 'https://www.googletagmanager.com/gtag/js?id=' + encodeURIComponent(id);
    document.head.append(script);
  } else {
    // Update defaults as well as the event, so later engagement events keep the same safe category.
    google.gtag!('set', fields);
    google.gtag!('config', id, { ...fields, send_page_view: false });
  }
  google.gtag!('event', 'page_view', fields);
}
