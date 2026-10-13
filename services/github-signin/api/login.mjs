/**
 * GET /api/login — start a GitHub sign-in for a PHCT /submit/ page.
 * See lib/signin.mjs for the whole flow.
 */
import process from 'node:process';

import { handleLogin } from '../lib/signin.mjs';

/** @param {Request} request @returns {Promise<Response>} */
export function GET(request) {
  return handleLogin(request, process.env);
}
