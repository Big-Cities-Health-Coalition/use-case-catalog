/**
 * /api/upload — take one screenshot or PDF from a signed-in submitter on a
 * PHCT /submit/ page and store it in the private uploads repository; or remove
 * one. See lib/upload.mjs for the whole flow.
 *
 * Every method routes to the same handler, so an unsupported one gets this
 * service's own JSON 405 (with CORS headers) rather than the platform's.
 */
import process from 'node:process';

import { handleUpload } from '../lib/upload.mjs';

/** @param {Request} request @returns {Promise<Response>} */
export function OPTIONS(request) {
  return handleUpload(request, process.env);
}

/** @param {Request} request @returns {Promise<Response>} */
export function POST(request) {
  return handleUpload(request, process.env);
}

/** @param {Request} request @returns {Promise<Response>} */
export function DELETE(request) {
  return handleUpload(request, process.env);
}

/** @param {Request} request @returns {Promise<Response>} */
export function GET(request) {
  return handleUpload(request, process.env);
}

/** @param {Request} request @returns {Promise<Response>} */
export function PUT(request) {
  return handleUpload(request, process.env);
}

/** @param {Request} request @returns {Promise<Response>} */
export function PATCH(request) {
  return handleUpload(request, process.env);
}
