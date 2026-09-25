// routes/adminApproval.js
router.post('/admin/change-requests/:code/decide', requireAuth, requireRole('super_admin'),
async (req, res) => {
  const { code } = req.params;
  const { decision } = req.body; // 'approve' | 'reject'

  const [rows] = await db.execute(
    `SELECT * FROM admin_change_requests WHERE request_code = ? LIMIT 1`,
    [code]
  );
  const r = rows[0];
  if (!r) return res.status(404).json({ error: 'not_found' });
  if (r.status !== 'pending') return res.status(409).json({ error: `already_${r.status}` });
  if (new Date(r.expires_at) < new Date()) {
    await db.execute(
      `UPDATE admin_change_requests SET status='expired' WHERE id=?`, [r.id]
    );
    return res.status(410).json({ error: 'expired' });
  }
  if (r.attempts >= 5) return res.status(429).json({ error: 'too_many_attempts' });

  if (decision === 'reject') {
    await db.execute(
      `UPDATE admin_change_requests
          SET status='rejected', checker_uid=?, checker_email=?, decision_at=NOW()
        WHERE id=?`,
      [req.admin.uid, req.admin.email, r.id]
    );
    await audit(req, 'reject.' + r.action, r.target_type, r.target_id, null, r.id);
    return res.json({ status: 'rejected' });
  }

  // APPROVE → apply payload_after
  try {
    await applyChange(r);   // see below
    await db.execute(
      `UPDATE admin_change_requests
          SET status='consumed', checker_uid=?, checker_email=?, decision_at=NOW()
        WHERE id=?`,
      [req.admin.uid, req.admin.email, r.id]
    );
    await audit(req, 'approve.' + r.action, r.target_type, r.target_id, r.payload_after, r.id);
    return res.json({ status: 'approved' });
  } catch (e) {
    await db.execute(
      `UPDATE admin_change_requests SET attempts = attempts + 1 WHERE id=?`, [r.id]
    );
    return res.status(500).json({ error: 'apply_failed', detail: String(e) });
  }
});