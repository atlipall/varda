import { authUrl, exchangeCode, HelperError, refreshToken, revokeSealed, signInReturn, withoutSignInReturn } from './helper';
import { storageName } from '../channel';
import { GOOGLE_CLIENT_ID, setSyncState, syncState, type SyncState } from './state';

export { GOOGLE_CLIENT_ID, setSyncState, syncState, type SyncState };

/**
 * Signing in to Google for Drive sync. Asks for the drive.appdata scope alone: the app's hidden
 * folder, none of the user's own files. Normally through the sign-in helper (./helper.ts), which
 * keeps the device signed in; without it, with Google Identity Services (a script from Google, loaded
 * only then), whose access token lasts about an hour. The token is kept in localStorage so sync runs
 * without a new sign-in until it runs out.
 */
const SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
const GIS = 'https://accounts.google.com/gsi/client';

interface TokenResponse { access_token?: string; expires_in?: number; error?: string }
interface TokenClient { requestAccessToken(o?: { prompt?: string }): void }
interface Gis { accounts: { oauth2: { initTokenClient(c: { client_id: string; scope: string; callback: (r: TokenResponse) => void; error_callback?: (e: { type: string }) => void }): TokenClient; revoke(token: string, done?: () => void): void } } }

/** A token that still has a minute or more left. */
export function validToken(s: SyncState = syncState()): string | null {
  return s.token && s.expires && s.expires - Date.now() > 60_000 ? s.token : null;
}

/** Signed in on this device: a token now, or the sealed key to get one. */
export const signedIn = (s: SyncState = syncState()) => s.on && (!!validToken(s) || !!s.sealed);

export type TokenResult = { token: string } | { problem: 'signed-out' | 'unreachable' };

/** A token for Drive: the current one, else a new one from the sign-in helper. */
export async function freshToken(): Promise<TokenResult> {
  const s = syncState();
  const token = validToken(s);
  if (token) return { token };
  if (!s.sealed) return { problem: 'signed-out' };
  try {
    const t = await refreshToken(s.sealed);
    setSyncState({ ...syncState(), token: t.token, expires: t.expires });
    return { token: t.token };
  } catch (err) {
    if (err instanceof HelperError && err.kind === 'signed-out') {
      setSyncState({ ...syncState(), token: undefined, expires: undefined, sealed: undefined });
      return { problem: 'signed-out' };
    }
    return { problem: 'unreachable' };
  }
}

/** Where Google's page sends the user back to: the app itself (registered with the OAuth client). */
const redirectUri = () => new URL('./', document.baseURI).toString();
/** The sign-in under way, against a forged return. */
const STATE_KEY = storageName('google-sync-signin');

/** Leaves for Google's sign-in page; it comes back to the app, where finishSignIn takes over. */
export function startSignIn(): void {
  const state = crypto.randomUUID();
  try {
    localStorage.setItem(STATE_KEY, state);
  } catch {
    // finishSignIn will refuse the return: nothing is signed in
  }
  location.assign(authUrl({ clientId: GOOGLE_CLIENT_ID, scope: SCOPE, redirect: redirectUri(), state }));
}

/** Back from Google's page: trades its code for a token and the sealed refresh key, and tidies the
 *  address. Null on a normal start; an Error to show when the sign-in didn't work. */
export async function finishSignIn(href = location.href): Promise<'signed-in' | Error | null> {
  const back = signInReturn(href);
  if (!back) return null;
  history.replaceState(history.state, '', withoutSignInReturn(href));
  let expected: string | null = null;
  try {
    expected = localStorage.getItem(STATE_KEY);
    localStorage.removeItem(STATE_KEY);
  } catch {
    // no stored state: refused below
  }
  if (!expected || back.state !== expected) return new Error('That sign-in was not started here; try again.');
  if ('error' in back) return new Error(back.error === 'access_denied' ? 'Google Drive access was not allowed.' : 'Google sign-in failed.');
  try {
    const t = await exchangeCode(back.code, redirectUri());
    setSyncState({ ...syncState(), on: true, token: t.token, expires: t.expires, sealed: t.sealed });
    return 'signed-in';
  } catch (err) {
    return err instanceof Error ? err : new Error(String(err));
  }
}

let gis: Promise<Gis> | null = null;
let client: TokenClient | null = null;
let pending: { resolve: (t: string) => void; reject: (e: Error) => void } | null = null;

/** Loads the Google script and prepares sign-in, so a later tap can open it at once (browsers only
 *  allow the sign-in window straight from a tap). */
export function prepareSignIn(): Promise<void> {
  gis ??= new Promise<Gis>((resolve, reject) => {
    const w = window as unknown as { google?: Gis };
    if (w.google?.accounts?.oauth2) return resolve(w.google);
    const script = document.createElement('script');
    script.src = GIS;
    script.async = true;
    script.onload = () => (w.google?.accounts?.oauth2 ? resolve(w.google) : reject(new Error('Google sign-in did not load.')));
    script.onerror = () => reject(new Error('Google sign-in could not be loaded (offline?).'));
    document.head.append(script);
  }).catch((err) => {
    // Any failure: the next tap tries again (a script that loaded without Google's sign-in, say).
    gis = null;
    throw err;
  });
  return gis.then((g) => {
    client ??= g.accounts.oauth2.initTokenClient({
      client_id: GOOGLE_CLIENT_ID,
      scope: SCOPE,
      callback: (r) => {
        const p = pending;
        pending = null;
        if (!p) return;
        if (!r.access_token) return p.reject(new Error(r.error === 'access_denied' ? 'Google Drive access was not allowed.' : 'Google sign-in failed.'));
        setSyncState({ ...syncState(), on: true, token: r.access_token, expires: Date.now() + (r.expires_in ?? 3600) * 1000 });
        p.resolve(r.access_token);
      },
      error_callback: (e) => {
        const p = pending;
        pending = null;
        p?.reject(new Error(e.type === 'popup_closed' ? 'Sign-in was closed.' : 'Google sign-in failed.'));
      },
    });
  });
}

/** Opens Google sign-in for an hour (call from a tap, after prepareSignIn): without the helper. */
export function signIn(): Promise<string> {
  if (!client) return Promise.reject(new Error('Google sign-in is still loading; try again in a moment.'));
  return new Promise((resolve, reject) => {
    pending = { resolve, reject };
    client!.requestAccessToken({ prompt: syncState().on ? '' : 'consent' });
  });
}

/** Stops syncing on this device (the file in Drive stays, for other devices). */
export function signOut(): void {
  const s = syncState();
  if (s.sealed) revokeSealed(s.sealed);
  const g = (window as unknown as { google?: Gis }).google;
  // Withdraw the access at Google too: through its script when loaded, else straight to its revoke
  // endpoint (best effort; an access token lapses within the hour anyway).
  if (s.token && g?.accounts?.oauth2) g.accounts.oauth2.revoke(s.token);
  else if (s.token) {
    fetch('https://oauth2.googleapis.com/revoke', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: `token=${encodeURIComponent(s.token)}`, keepalive: true }).catch(() => {});
  }
  setSyncState({ on: false });
}
