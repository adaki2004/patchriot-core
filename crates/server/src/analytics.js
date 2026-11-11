/* Embedded with a nonce in the sandboxed workspace frame; storage stays denied. */
(() => {
  const config = document.currentScript.dataset;
  let started = false;
  window.addEventListener('message', event => {
    if (started || window.parent === window || event.source !== window.parent || event.origin !== config.parentOrigin || event.data !== 'patchriot-workspace-page-count-v1') return;
    started = true;
    window.dataLayer = [];
    function gtag() { window.dataLayer.push(arguments); }
    gtag('consent', 'default', { ad_storage: 'denied', ad_user_data: 'denied', ad_personalization: 'denied', analytics_storage: 'denied' });
    gtag('set', 'ads_data_redaction', true);
    gtag('js', new Date());
    gtag('config', config.measurementId, { send_page_view: false, allow_google_signals: false, allow_ad_personalization_signals: false, page_location: config.pageLocation, page_title: config.pageTitle, page_referrer: '' });
    gtag('event', 'page_view', { page_location: config.pageLocation, page_title: config.pageTitle, page_referrer: '' });
    const script = document.createElement('script');
    script.async = true;
    script.referrerPolicy = 'no-referrer';
    script.src = 'https://www.googletagmanager.com/gtag/js?id=' + encodeURIComponent(config.measurementId);
    document.head.append(script);
  });
})();
