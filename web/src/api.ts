export type Account = {
  id: string;
  display_name: string;
  role: 'member' | 'admin';
  auth_method: 'invite' | 'google';
};

export type Session = { account: Account | null; csrf_token: string | null };
export type Fleet = { online_devices: number; online_operators: number; online_compute_groups: number };
export type Device = {
  id: string;
  operator_id: string;
  operator_name: string;
  label: string;
  runtime: 'owned_fixture' | 'hermes';
  runtime_version: string;
  declared_model: string | null;
  compute_group: string;
  approval: 'pending' | 'approved' | 'revoked';
  private_work_approved?: boolean;
  website_reviews?: boolean;
  state: string;
  last_seen_at: number | null;
  reports_received?: number | null;
};

const messages: Record<string, string> = {
  invalid_or_expired_invite: 'This invitation is invalid, expired or already used. Request a fresh code.',
  sign_in_required: 'Your session has ended. Sign in again to continue.',
  csrf_required: 'Your session changed. Refresh the page before trying again.',
  origin_not_allowed: 'This address is not configured for sign-in. Open the configured Patchriot website.',
  dispatcher_unavailable: 'The dispatcher is unavailable. The last response is shown below; it may be out of date.',
  database_unavailable: 'Account storage is unavailable. Please try again shortly.',
  request_conflict: 'This request changed or a previous action already succeeded. Refresh the view before trying again.',
  checkout_preparing: 'This order is still being prepared. Wait a moment, then refresh its status.',
  checkout_unavailable: 'Checkout is unavailable. Do not send a payment using an earlier quote.',
  checkout_closed: 'This order cannot accept a new payment. Check its status in Orders.',
  checkout_offer_changed: 'The review price or payment settings changed. Refresh and check the new offer before continuing.',
  invalid_payment_details: 'Select an available payment token and enter a valid refund address on that network.',
  payment_required: 'This review now requires payment. Reopen the agent selection to see the current offer.',
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
/** Late replies from a previous login must not clear a newer workspace. */
export function sessionChanged() { sessionRevision += 1; }
export class SessionExpiredError extends Error {
  constructor() { super(messages.sign_in_required); }
}

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const revision = sessionRevision;
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      credentials: 'same-origin',
      ...options,
      signal: options.signal ?? AbortSignal.timeout(12_000),
      headers: { 'content-type': 'application/json', ...options.headers },
    });
  } catch (error) {
    if (options.signal?.aborted) throw error;
    throw new Error('Cannot reach Patchriot. Check your connection and try again.');
  }
  const body = await response.json().catch(() => null);
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
