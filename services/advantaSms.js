// services/advantaSms.js
const fetch = require('node-fetch'); // if Node < 18; otherwise remove this line

const ADVANTA_BASE = process.env.ADVANTA_BASE || 'https://quicksms.advantasms.com';
const ADVANTA_API_KEY = process.env.ADVANTA_API_KEY;
const ADVANTA_PARTNER_ID = process.env.ADVANTA_PARTNER_ID;
const ADVANTA_SHORTCODE = process.env.ADVANTA_SHORTCODE;

/**
 * Send a single SMS via Advanta Bulk SMS API.
 * @param {string} mobile - e.g. '254712345678' or '0712345678'
 * @param {string} message
 * @returns {Promise<{ ok: boolean, ref?: string, error?: string }>}
 */
async function sendSms(mobile, message) {
  if (!ADVANTA_API_KEY || !ADVANTA_PARTNER_ID || !ADVANTA_SHORTCODE) {
    return { ok: false, error: 'Advanta credentials not configured' };
  }

  // Normalise: strip non-digits, convert 0-prefix to 254
  let msisdn = String(mobile).replace(/\D/g, '');
  if (msisdn.startsWith('0')) msisdn = '254' + msisdn.slice(1);
  if (!msisdn.startsWith('254')) msisdn = '254' + msisdn;

  const body = {
    apikey: ADVANTA_API_KEY,
    partnerID: ADVANTA_PARTNER_ID,
    shortcode: ADVANTA_SHORTCODE,
    mobile: msisdn,
    message: message.slice(0, 480), // keep under 3 SMS segments
  };

  try {
    const r = await fetch(`${ADVANTA_BASE}/api/services/sendsms`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    const text = await r.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }

    if (!r.ok) {
      return { ok: false, error: `HTTP ${r.status}: ${text.slice(0, 200)}` };
    }

    // Advanta returns { responses: [{ "respose-code": 200, "response-description": "Success", ... }] }
    const first = data?.responses?.[0];
    const code = first?.['respose-code'] ?? first?.['response-code'] ?? first?.code;
    const ok = code === 200 || code === '200' || data?.success === true;

    return {
      ok,
      ref: first?.messageid || first?.['message-id'] || null,
      error: ok ? undefined : (first?.['response-description'] || JSON.stringify(data).slice(0, 200)),
    };
  } catch (e) {
    return { ok: false, error: String(e).slice(0, 200) };
  }
}

module.exports = { sendSms };