/**
 * GET /api/callback — finish a GitHub sign-in and hand the token to the
 * /submit/ page that opened this window. See lib/signin.mjs for the whole flow.
 */
import process from 'node:process';

import { handleCallback } from '../lib/signin.mjs';

/** @param {Request} request @returns {Promise<Response>} */
export function GET(request) {
  return handleCallback(request, process.env);
}
