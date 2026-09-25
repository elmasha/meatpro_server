// services/advantaSms.js
const axios = require('axios');

const ADVANTA_BASE = process.env.ADVANTA_BASE || 'https://quicksms.advantasms.com';
const ADVANTA_API_KEY = process.env.ADVANTA_API_KEY;
const ADVANTA_PARTNER_ID = process.env.ADVANTA_PARTNER_ID;
const ADVANTA_SHORTCODE = process.env.ADVANTA_SHORTCODE;

/**
 * Normalise a Kenyan phone number to 2547XXXXXXXX / 2541XXXXXXXX form.
 * Returns null if the input can't be parsed.
 */
function normalizePhone(mobile) {
  if (!mobile) return null;
  let m = String(mobile).replace(/\D/g, '');
  if (m.startsWith('0')) m = '254' + m.slice(1);
  if (!m.startsWith('254')) m = '254' + m;
  if (m.length !== 12) return null;
  return m;
}

/**
 * Send a single SMS via Advanta Bulk SMS API.
 * @param {string} mobile  e.g. '254712345678' or '0712345678'
 * @param {string} message
 * @returns {Promise<{ ok: boolean, ref?: string, error?: string }>}
 */
async function sendSms(mobile, message) {
  if (!ADVANTA_API_KEY || !ADVANTA_PARTNER_ID || !ADVANTA_SHORTCODE) {
    return { ok: false, error: 'Advanta credentials not configured' };
  }

  const msisdn = normalizePhone(mobile);
  if (!msisdn) {
    return { ok: false, error: 'Invalid phone number' };
  }

  const body = {
    apikey: ADVANTA_API_KEY,
    partnerID: ADVANTA_PARTNER_ID,
    shortcode: ADVANTA_SHORTCODE,
    mobile: msisdn,
    message: message.slice(0, 480), // keep under 3 SMS segments
  };

  try {
    const r = await axios.post(
      `https://quicksms.advantasms.com/api/services/sendsms`,
      body,
      {
        headers: { 'Content-Type': 'application/json' },
        timeout: 15000,
        validateStatus: () => true, // don't throw on 4xx/5xx — we handle below
      }
    );

    const data = r.data;

    if (r.status < 200 || r.status >= 300) {
      const errText = typeof data === 'string'
        ? data.slice(0, 200)
        : JSON.stringify(data).slice(0, 200);
      return { ok: false, error: `HTTP ${r.status}: ${errText}` };
    }

    // Advanta returns:
    // { responses: [{ "respose-code": 200, "response-description": "Success", "messageid": "..." }] }
    const first = data?.responses?.[0];
    const code = first?.['respose-code'] ?? first?.['response-code'] ?? first?.code;
    const ok = code === 200 || code === '200' || data?.success === true;

    return {
      ok,
      ref: first?.messageid || first?.['message-id'] || null,
      error: ok
        ? undefined
        : (first?.['response-description'] || JSON.stringify(data).slice(0, 200)),
    };
  } catch (e) {
    const detail = e.response
      ? `HTTP ${e.response.status}`
      : (e.code || e.message || 'unknown');
    return { ok: false, error: `Request failed: ${detail}` };
  }
}

/**
 * Fetch the current SMS credit balance from Advanta.
 * @returns {Promise<{ ok: boolean, balance?: number, currency?: string, error?: string }>}
 */
async function getSmsBalance() {
  if (!ADVANTA_API_KEY || !ADVANTA_PARTNER_ID) {
    return { ok: false, error: 'Advanta credentials not configured' };
  }

  try {
    const r = await axios.post(
      `https://quicksms.advantasms.com/api/services/getbalance`,
      {
        apikey: ADVANTA_API_KEY,
        partnerID: ADVANTA_PARTNER_ID,
      },
      {
        headers: { 'Content-Type': 'application/json' },
        timeout: 15000,
        validateStatus: () => true,
      }
    );

    const data = r.data;

    if (r.status < 200 || r.status >= 300) {
      const errText = typeof data === 'string'
        ? data.slice(0, 200)
        : JSON.stringify(data).slice(0, 200);
      return { ok: false, error: `HTTP ${r.status}: ${errText}` };
    }

    const credit = data?.credit || data?.balance || '0';
    return {
      ok: true,
      balance: Number(credit) || 0,
      currency: 'KES',
    };
  } catch (e) {
    const detail = e.response
      ? `HTTP ${e.response.status}`
      : (e.code || e.message || 'unknown');
    return { ok: false, error: `Request failed: ${detail}` };
  }
}

module.exports = { sendSms, getSmsBalance, normalizePhone };