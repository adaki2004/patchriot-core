export type Account = {
  id: string;
  display_name: string;
  role: 'member' | 'admin';
  auth_method: 'invite' | 'google' | 'github' | 'password' | 'wallet';
};

export type Session = { account: Account | null; csrf_token: string | null };
export type Fleet = { online_devices: number; online_operators: number; online_compute_groups: number };
export type AgentSystem = { os_name: string; os_version: string | null; architecture: string; relay_version: string };
export type Device = {
  id: string;
  operator_id: string;
  operator_name: string;
  label: string;
  runtime: 'owned_fixture' | 'hermes';
  runtime_version: string;
  declared_model: string | null;
  reported_os?: string | null;
  system?: AgentSystem | null;
  compute_group: string;
  approval: 'pending' | 'approved' | 'revoked';
  private_work_approved?: boolean;
  website_reviews?: boolean;
  live_tests?: boolean;
  state: string;
  last_seen_at: number | null;
  reports_received?: number | null;
};

const messages: Record<string, string> = {
  wallet_signin_failed: 'The wallet message could not be verified. Start again and sign the new message.',
  wallet_unavailable: 'Wallet sign-in is not configured on this installation.',

  report_content_deleted: "The report’s download window ended and its private content has been deleted.",
  report_not_finished: "Wait for the test to end before downloading its report.",
  invalid_inquiry: 'Add your name, company or team, email and a message of 20–3,000 characters.',
  inquiry_changed: 'This inquiry changed after being saved. Refresh the page before sending another.',
  inquiry_not_found: 'This inquiry is no longer available. Refresh the inbox.',
  withdrawals_unavailable: 'Withdrawals are not enabled on this installation.',
  invalid_withdrawal: 'Check the amount, receiving network and wallet address. The minimum is 10 USDC.',
  insufficient_earnings: 'There are not enough available earnings for this withdrawal.',
  withdrawal_in_progress: 'A withdrawal is already reserved. Check its saved status.',
  withdrawal_changed: 'This withdrawal changed or has expired. Refresh its status before continuing.',
  source_file_count: 'Choose 1–12 source files.',
  invalid_source_path: 'Use supported text files with simple, unique paths. No hidden files, archives or credential files.',
  invalid_source_text: 'Each file must be nonempty UTF-8 text, at most 16 KiB, without binary or hidden direction-control characters.',
  source_too_large: 'Choose at most 48 KiB of source in total.',
  source_may_contain_secret: 'A file or note appears to contain a credential. Remove it before uploading. This check cannot detect every secret.',
  source_upload_limit: 'The upload limit has been reached. Remove an old retained upload or try again later.',
  invalid_source_request: 'Add a title, requested check and permission note, and confirm private storage.',
  conflicting_source_request: 'This upload changed. Start a fresh request or open the saved upload.',
  source_already_decided: 'This upload was already decided or has expired. Refresh its status.',

  unsupported_or_missing_test_credentials: 'Check the test-account type and credentials. Use a supported test-account type and ensure account testing is enabled.',
  state_change_permission_required: 'Confirm that the agents may change disposable test data before enabling form submissions.',
  test_credentials_locked: 'This account cannot be changed after checkout or testing begins. Verify domain ownership first; start a new request if this one has already been admitted.',
  invalid_test_credentials: 'Check the selected account type, username and password or API token.',
  test_credentials_unavailable: 'Test-account access is unavailable or has expired. Open the saved assessment, or create a fresh request when the service is available.',
  test_credentials_expired_or_used: 'This test account has expired or is already attached to an assessment. Open that assessment from Audits, or start a new request.',
  conflicting_test_credentials: 'These credentials differ from the saved request. Create a new request to change the test account.',
  invalid_live_scope: 'Check the website and protected URL path. Use one HTTPS host for account tests and a path without a query or fragment.',
  live_scope_not_ready: 'This request is not ready to start. Check domain verification, expiry and any existing assessment in Audits.',
  live_test_pilot_only: 'Live tests are available only in the approved pilot; paid and coupon checkout for live tests is not enabled.',
  pairing_setup_unavailable: 'Relay setup is not configured for this deployment yet. Contact the administrator.',
  public_pairing_disabled: 'Agent pairing is staff-only. Patchriot operates the agents in this beta.',
  domain_ownership_required: 'Verify every domain with the supplied DNS TXT records before requesting approval.',
  ownership_refresh_limit: 'This request has used its six DNS refresh windows. Check your DNS records before creating a new request.',
  scope_changed_or_expired: 'This scope has changed or expired. Open the current request before continuing.',
  invalid_credentials: 'The username or password is incorrect, or this account is unavailable.',
  invalid_username: 'Use 3–40 letters, numbers, dots, hyphens or underscores. Start with a letter or number.',
  username_unavailable: 'That username is already taken. Choose another.',
  invalid_password: 'Use at least 15 characters, at most 256 bytes.',
  invalid_contact: 'Enter a valid email address.',
  sso_unavailable: 'This sign-in provider is not available yet.',
  sso_signin_failed: 'Sign-in was not completed. Please try again.',
  already_signed_in: 'You are already signed in. Open your workspace or sign out first.',
  login_unavailable: 'Sign-in is temporarily unavailable. Please try again shortly.',
  account_access_changed: 'This request was already handled or that email has an account. Refresh Users to find it.',
  account_unavailable: 'That account cannot be changed here. Administrator access uses the local operator tools.',
  invalid_or_expired_invite: 'This invitation is invalid, expired or already used. Request a fresh code.',
  sign_in_required: 'Your session has ended. Sign in again to continue.',
  csrf_required: 'Your session changed. Refresh the page before trying again.',
  origin_not_allowed: 'This address is not configured for sign-in. Open the configured Patchriot website.',
  dispatcher_unavailable: 'The dispatcher is unavailable. Previously loaded data may be out of date. Please try again shortly.',
  database_unavailable: 'Account storage is unavailable. Please try again shortly.',
  request_conflict: 'This request changed or a previous action already succeeded. Refresh the view before trying again.',
  pairing_expired: 'This pairing code has expired. Run pair again in your relay terminal, using the same state directory, then enter the new code.',
  pairing_code_unavailable: 'That pairing code was not found or has expired. Copy the latest code from your relay terminal; run pair again with the same state directory if needed.',
  pairing_already_claimed: 'This code is already linked to a different account. Use the account that claimed it, or pair a new device identity with a separate state directory.',
  checkout_preparing: 'This order is still being prepared. Wait a moment, then refresh its status.',
  checkout_unavailable: 'Checkout is unavailable. Do not send a payment using an earlier quote.',
  checkout_closed: 'This order cannot accept a new payment. Check its status in Orders.',
  checkout_offer_changed: 'The review price or payment settings changed. Refresh and check the new offer before continuing.',
  invalid_payment_details: 'Select an available payment token and enter a valid refund address on that network.',
  payment_required: 'This review now requires payment. Reopen the agent selection to see the current offer.',
  review_code_required: 'This review requires a single-use coupon. Reopen the agent selection to enter it.',
  invalid_or_used_review_code: 'This coupon is invalid, expired, revoked or already claimed. Check the code or contact the operator.',
  review_codes_unavailable: 'New reviews with codes are paused or unavailable in this mode. Existing reports remain available.',
  review_code_preparing: 'This saved request is still being checked. Wait a moment, then resume it from Coupon assessments.',
  review_code_bound: 'This code is already attached to a saved request. Open Coupon assessments under Reviews to resume that request.',
  invalid_dispatcher_response: 'The review reply could not be verified. Check the saved request before starting another.',
  not_found: 'This item is unavailable, expired or not shared with your account.',
  invalid_request: 'Check the entered details and the limits shown in the form, then try again.',
  action_not_allowed: 'Your account cannot perform this action.',
  admin_required: 'Only an administrator can perform this action.',
  invalid_incident: 'Check the text, date and public source links. Use HTTPS links without credentials or query parameters.',
  sources_review_required: 'Review the saved draft and its sources before publishing.',
  incident_changed: 'This entry changed or the previous request already succeeded. Refresh the drafts, then open the saved entry before editing again.',
  try_again_later: 'Too many requests. Wait a moment before trying again.',
};

export const sessionExpiredEvent = 'patchriot:session-expired';
let sessionRevision = 0;
/** Late replies from a previous login must not update a newer workspace. */
export function sessionChanged() { sessionRevision += 1; }
export class SessionExpiredError extends Error {
  constructor() { super(messages.sign_in_required); }
}
export class SessionChangedError extends Error {
  constructor() { super('Your session changed. Retry from the current workspace.'); }
}

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const revision = sessionRevision;
  const method = (options.method ?? 'GET').toUpperCase();
  // Only these GET responses contain no account-specific data. An old write
  // may already have completed on the server; discard its reply, not the work.
  const publicRead = method === 'GET' && ['/fleet', '/incidents', '/contact', '/auth/providers'].includes(path);
  const checkSession = () => { if (!publicRead && revision !== sessionRevision) throw new SessionChangedError(); };
  const signal = options.signal ?? AbortSignal.timeout(12_000);
  let response: Response;
  let body;
  try {
    response = await fetch(`/api${path}`, {
      credentials: 'same-origin',
      ...options,
      signal,
      headers: { 'content-type': 'application/json', ...options.headers },
    });
    // Body delivery can time out after the response headers have arrived.
    body = await response.json().catch(error => {
      if (error instanceof SyntaxError) return null;
      throw error;
    });
  } catch (error) {
    checkSession();
    const reason = signal.aborted ? signal.reason : error;
    if (method === 'GET' && reason instanceof DOMException && reason.name === 'TimeoutError') {
      throw new Error('Patchriot took too long to respond. Try refreshing.');
    }
    if (options.signal?.aborted) throw error;
    throw new Error('Cannot reach Patchriot. Check your connection and try again.');
  }
  checkSession();
  if (!response.ok) {
    if (response.status === 401 && body?.error === 'sign_in_required') {
      if (revision === sessionRevision && !options.signal?.aborted) {
        window.dispatchEvent(new Event(sessionExpiredEvent));
      }
      throw new SessionExpiredError();
    }
    throw new Error(messages[body?.error] ?? `The request failed (${response.status}). Please try again.`);
  }
  if (body === null) throw new Error('The server returned an unreadable response. Please try again.');
  return body as T;
}

export function write<T>(path: string, csrf: string, body?: unknown): Promise<T> {
  return api<T>(path, {
    method: 'POST',
    headers: { 'x-csrf-token': csrf },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
