// middleware/requireApproval.js
const SENSITIVE_ACTIONS = new Set([
  'plan.create', 'plan.update', 'plan.delete',
  'subscription.override', 'subscription.cancel', 'subscription.extend',
  'payment.refund', 'payment.markSuccess',
  'business.suspend', 'business.delete',
  'admin.roleChange',
]);

function requireApproval(action, targetType) {
  return async (req, res, next) => {
    // only super_admin bypasses the queue
    if (req.admin?.role === 'super_admin') return next();
    if (!SENSITIVE_ACTIONS.has(action)) return next();

    // Otherwise: create a pending request instead of applying
    const code = generateRequestCode(6);
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000);

    const [result] = await db.execute(
      `INSERT INTO admin_change_requests
       (request_code, maker_uid, maker_email, action, target_type, target_id,
        payload_before, payload_after, expires_at, ip_address, user_agent)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [
        code, req.admin.uid, req.admin.email, action, targetType,
        req.params.id ?? null,
        JSON.stringify(req.changeBefore ?? null),
        JSON.stringify(req.body),
        expiresAt,
        req.ip, req.get('user-agent')?.slice(0, 255),
      ]
    );

    // fire SMS to all super_admins
    await notifySuperAdmins(result.insertId, code, action, req.admin, req.body);

    // audit
    await db.execute(
      `INSERT INTO admin_audit_log
       (admin_uid, admin_email, action, target_type, target_id, payload, change_request_id, ip_address, user_agent)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [req.admin.uid, req.admin.email, `request.${action}`, targetType,
       req.params.id ?? null, JSON.stringify(req.body), result.insertId,
       req.ip, req.get('user-agent')?.slice(0, 255)]
    );

    return res.status(202).json({
      status: 'pending_approval',
      request_code: code,
      expires_at: expiresAt,
      message: 'Change queued. Super admin has been notified by SMS.',
    });
  };
}