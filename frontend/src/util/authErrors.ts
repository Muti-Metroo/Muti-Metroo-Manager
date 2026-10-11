import {
  ERR_SHELL_AUTH_REQUIRED,
  ERR_SHELL_INVALID_CREDS,
  ERR_FILE_TRANSFER_DENIED,
} from '../api/types';

// Auth failures are no longer recoverable from the UI — they mean the
// connected agent has no management signing private key or the target
// has no signing public key. Surface as an inline banner, not a prompt.
const AUTH_REQUIRED_MSG = /management signature missing/i;
const INVALID_CREDS_MSG =
  /management signature (verification failed|target mismatch|outside timestamp window)/i;

export function isAuthRequired(code: unknown, message: string): boolean {
  if (code === ERR_SHELL_AUTH_REQUIRED) return true;
  if (code === 'auth_required') return true;
  return AUTH_REQUIRED_MSG.test(message);
}

export function isInvalidCreds(code: unknown, message: string): boolean {
  if (code === ERR_SHELL_INVALID_CREDS) return true;
  if (code === 'invalid_credentials') return true;
  return INVALID_CREDS_MSG.test(message);
}

export function isFileTransferDenied(code: unknown, message: string): boolean {
  if (code === ERR_FILE_TRANSFER_DENIED) return true;
  return /ERR_FILE_TRANSFER_DENIED/.test(message);
}

export const AUTH_ERROR_NO_SIGNING_KEY =
  'Management signing key not configured on the connected agent.';
export const AUTH_ERROR_SIG_REJECTED = 'Target agent rejected the management signature.';

// Maps an auth failure (by wire code and/or message) to a human-readable
// banner. Returns null for non-auth errors so callers can fall back to the
// raw error text.
export function mapManagementAuthError(code: unknown, message: string): string | null {
  if (isAuthRequired(code, message)) return AUTH_ERROR_NO_SIGNING_KEY;
  if (isInvalidCreds(code, message)) return AUTH_ERROR_SIG_REJECTED;
  return null;
}
