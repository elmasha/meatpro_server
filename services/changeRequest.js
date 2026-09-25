// services/changeRequest.js
const crypto = require('crypto');
const db = require('../config/db');
const { sendSms } = require('./advantaSms');

// Unambiguous alphabet: no 0/O, 1/I/L
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function generateRequestCode(len = 6) {
  let s = '';
  for (let i = 0; i < len; i++) {
    s += CODE_ALPHABET[crypto.randomInt(0, CODE_ALPHABET.length)];
  }
  return s;
}

/**
 * Build a short SMS summary for the request.
 */
function summarise(action, payload) {
  switch (action) {
    case 'plan.create':
      return `new plan "${payload.display_name}" @ KES ${payload.price_kes}`;
    case 'plan.update':
      return `edit plan #${payload.id || '?'} (${payload.display_name || 'name unchanged'}) price→${payload.price_kes ?? 'unchanged'}`;
    case 'plan.delete':
      return `DELETE plan #${payload.id}`;
    case 'plan.toggle':
      return `${payload.active ? 'activate' : 'deactivate'} plan #${payload.id}`;
    case 'payment.confirmManual':
      return `manually confirm payment #${payload.payment_id}`;
    case 'user.delete':
      return `DELETE user #${payload.id}`;
    case 'user.startTrial':
      return `start ${payload.days || 30}d trial for user #${payload.id}`;
    case 'subscription.renew':
      return `renew subscription #${payload.id} for ${payload.months || 1}mo`;
    case 'subscription.cancel':
      return `cancel subscription #${payload.id}`;
    case 'subscription.extend':
      return `extend subscription #${payload.id} by ${payload.days}d`;
    case 'admin.roleChange':
      return `change role of admin #${payload.id} to ${payload.new_role}`;
    default:
      return action;
  }
}

/**
 * Notify all super_admins via SMS and log each attempt.
 */
async function notifySuperAdmins(changeRequestId, code, action, maker, payloadSummary) {
  const [supers] = await db.promise().query(
    `SELECT name, phone FROM users
      WHERE admin_role = 'super_admin'
        AND is_admin = 1
        AND phone IS NOT NULL`
  );

  if (!supers.length) {
    console.warn('[changeRequest] No super_admin with phone found — nobody notified. Request is still queued.');
    await db.promise().query(
      `INSERT INTO admin_sms_log
         (change_request_id, recipient_phone, message, provider, status, error)
       VALUES (?, ?, ?, ?, 'failed', ?)`,
      [changeRequestId, 'NONE', `No super_admin found for request ${code}`, 'advanta',
       'No super_admin with phone found']
    );
    return;
  }

  const base = process.env.ADMIN_APP_URL || 'https://app.meatpro.co';
  const link = `${base}/admin/approve?code=${code}`;
  const msg = `MeatPro: ${maker.name} requests ${action}. ${payloadSummary}. Code ${code} (15min). Approve: ${link}`;

  for (const s of supers) {
    const r = await sendSms(s.phone, msg);
    await db.promise().query(
      `INSERT INTO admin_sms_log
         (change_request_id, recipient_phone, message, provider, provider_ref, status, error)
       VALUES (?,?,?,?,?,?,?)`,
      [changeRequestId, s.phone, msg, 'advanta', r.ref || null,
       r.ok ? 'sent' : 'failed', r.ok ? null : (r.error || null)]
    );
    if (r.ok) {
      await db.promise().query(
        `UPDATE admin_change_requests SET sms_sent_at = NOW(), sms_provider_ref = ? WHERE id = ?`,
        [r.ref, changeRequestId]
      );
    }
  }
}
/**
 * Insert a pending change request and notify super admins.
 * Returns { id, request_code, expires_at }.
 */
async function queueChangeRequest({ req, action, targetType, targetId, before, after }) {
  const code = generateRequestCode(6);
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000);

  const [result] = await db.promise().query(
    `INSERT INTO admin_change_requests
       (request_code, maker_uid, maker_email, action, target_type, target_id,
        payload_before, payload_after, expires_at, ip_address, user_agent)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [
      code, req.admin.uid, req.admin.email, action, targetType,
      targetId != null ? String(targetId) : null,
      before ? JSON.stringify(before) : null,
      JSON.stringify(after),
      expiresAt,
      req.ip, (req.get('user-agent') || '').slice(0, 255),
    ]
  );

  const summary = summarise(action, after);
  await notifySuperAdmins(result.insertId, code, action, req.admin, summary);

  return { id: result.insertId, request_code: code, expires_at: expiresAt };
}

/**
 * Apply the approved change to the actual table, inside a transaction.
 * Called by decideChangeRequest when decision = 'approve'.
 */
async function applyChange(conn, r) {
  const p = typeof r.payload_after === 'string'
    ? JSON.parse(r.payload_after)
    : (r.payload_after || {});

  switch (r.action) {
    case 'plan.create': {
      const featuresJson = Array.isArray(p.features)
        ? JSON.stringify(p.features) : (p.features ?? null);
      await conn.query(
        `INSERT INTO plans (name, display_name, price_kes, billing_cycle, description, features, is_active)
         VALUES (?,?,?,?,?,?,1)`,
        [p.name, p.display_name, p.price_kes, p.billing_cycle || 'monthly',
         p.description || null, featuresJson]
      );
      break;
    }
    case 'plan.update': {
      const before = typeof r.payload_before === 'string'
        ? JSON.parse(r.payload_before) : (r.payload_before || {});
      const updates = []; const values = [];
      for (const k of ['display_name', 'price_kes', 'billing_cycle', 'description']) {
        if (p[k] !== undefined) { updates.push(`${k} = ?`); values.push(p[k]); }
      }
      if (p.features !== undefined) {
        updates.push('features = ?');
        values.push(Array.isArray(p.features) ? JSON.stringify(p.features) : p.features);
      }
      if (p.is_active !== undefined) {
        updates.push('is_active = ?'); values.push(p.is_active ? 1 : 0);
      }
      if (!updates.length) throw new Error('No fields to update');
      values.push(r.target_id);
      await conn.query(`UPDATE plans SET ${updates.join(', ')} WHERE id = ?`, values);
      break;
    }
    case 'plan.delete':
      await conn.query('DELETE FROM plans WHERE id = ?', [r.target_id]);
      break;
    case 'plan.toggle':
      await conn.query('UPDATE plans SET is_active = ? WHERE id = ?',
        [p.active ? 1 : 0, r.target_id]);
      break;
    case 'payment.confirmManual': {
      const [payments] = await conn.query('SELECT * FROM payments WHERE id = ?', [r.target_id]);
      if (!payments.length) throw new Error('Payment not found');
      const payment = payments[0];
      const receipt = 'ADMIN_' + Date.now();

      await conn.query(
        `UPDATE payments SET mpesa_receipt = ?, status = 'success', transaction_date = NOW() WHERE id = ?`,
        [receipt, r.target_id]
      );
      await conn.query(
        `UPDATE subscriptions SET status = 'active', start_date = CURDATE(),
                end_date = DATE_ADD(CURDATE(), INTERVAL 1 MONTH), mpesa_receipt = ?
          WHERE user_id = ? AND status = 'pending'
          ORDER BY id DESC LIMIT 1`,
        [receipt, payment.user_id]
      );
      await conn.query(
        `UPDATE users SET subscription = ?, subscription_status = 'active',
                subscription_expires = DATE_ADD(CURDATE(), INTERVAL 1 MONTH),
                mpesa_receipt = ?, payment_date = NOW()
          WHERE id = ?`,
        [payment.subscription, receipt, payment.user_id]
      );
      break;
    }
    case 'user.delete':
      await conn.query('DELETE FROM payments WHERE user_id = ?', [r.target_id]);
      await conn.query('DELETE FROM users WHERE id = ?', [r.target_id]);
      break;
    case 'user.startTrial': {
      const days = parseInt(p.days || 30);
      const endDate = new Date();
      endDate.setDate(endDate.getDate() + days);
      const expires = endDate.toISOString().split('T')[0];

      await conn.query(
        `UPDATE subscriptions SET status = 'expired' WHERE user_id = ? AND status = 'active'`,
        [r.target_id]
      );
      await conn.query(
        `INSERT INTO subscriptions (user_id, plan_id, plan, amount, start_date, end_date, status, auto_renew)
         VALUES (?, NULL, 'trial', 0, CURDATE(), ?, 'active', 0)`,
        [r.target_id, expires]
      );
      await conn.query(
        `UPDATE users SET subscription = 'trial', subscription_status = 'active',
                subscription_expires = ?
          WHERE id = ?`,
        [expires, r.target_id]
      );
      break;
    }
    case 'subscription.renew': {
      const months = parseInt(p.months || 1);
      const [subs] = await conn.query('SELECT * FROM subscriptions WHERE id = ?', [r.target_id]);
      if (!subs.length) throw new Error('Subscription not found');
      const sub = subs[0];
      const newEnd = new Date(sub.end_date);
      newEnd.setMonth(newEnd.getMonth() + months);
      const iso = newEnd.toISOString().split('T')[0];

      await conn.query(
        `UPDATE subscriptions SET end_date = ?, status = 'active', auto_renew = 1 WHERE id = ?`,
        [iso, r.target_id]
      );
      await conn.query(
        `UPDATE users SET subscription_status = 'active', subscription_expires = ? WHERE id = ?`,
        [iso, sub.user_id]
      );
      break;
    }
    case 'subscription.cancel': {
      const [subs] = await conn.query('SELECT * FROM subscriptions WHERE id = ?', [r.target_id]);
      if (!subs.length) throw new Error('Subscription not found');
      await conn.query(
        `UPDATE subscriptions SET status = 'cancelled', auto_renew = 0 WHERE id = ?`,
        [r.target_id]
      );
      await conn.query(
        `UPDATE users SET subscription_status = 'cancelled', subscription = NULL WHERE id = ?`,
        [subs[0].user_id]
      );
      break;
    }
    case 'subscription.extend': {
      await conn.query(
        `UPDATE subscriptions SET end_date = DATE_ADD(end_date, INTERVAL ? DAY) WHERE id = ?`,
        [parseInt(p.days), r.target_id]
      );
      break;
    }
    case 'admin.roleChange': {
      await conn.query(
        `UPDATE users SET admin_role = ? WHERE id = ?`,
        [p.new_role, r.target_id]
      );
      break;
    }
    default:
      throw new Error(`No handler for action ${r.action}`);
  }
}

module.exports = {
  queueChangeRequest,
  applyChange,
  generateRequestCode,
};