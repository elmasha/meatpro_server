// controllers/adminController.js
const db = require('../config/db');
const { queueChangeRequest, applyChange } = require('../services/changeRequest');
const { audit } = require('../middleware/adminAuth');

// ============================================================
// Helper: safely serialize any value for a JSON column.
// ============================================================
function toJson(v) {
  if (v == null) return null;
  if (typeof v === 'string') return v;
  return JSON.stringify(v);
}

// ============================================================
// Which actions require maker-checker approval?
// ============================================================
const REQUIRES_APPROVAL = new Set([
  'plan.create', 'plan.update', 'plan.delete', 'plan.toggle',
  'payment.confirmManual',
  'user.delete', 'user.startTrial', 'user.updateSubscription',
  'subscription.renew', 'subscription.cancel', 'subscription.extend',
]);

function needsApproval(action) {
  return REQUIRES_APPROVAL.has(action);
}

function queuedResponse(res, { request_code, expires_at, id }) {
  return res.status(202).json({
    success: true,
    status: 'pending_approval',
    request_code,
    expires_at,
    request_id: id,
    message: 'Change queued. Super admins have been notified by SMS.',
  });
}

// ============================================================
// DASHBOARD STATS
// ============================================================
exports.getDashboardStats = async (req, res) => {
  try {
    const connection = await db.promise().getConnection();

    const [[usersCount]] = await connection.query('SELECT COUNT(*) as total FROM users');
    const [[businessCount]] = await connection.query('SELECT COUNT(*) as total FROM businesses');
    const [[branchesCount]] = await connection.query('SELECT COUNT(*) as total FROM branches');
    const [[activeSubs]] = await connection.query(
      "SELECT COUNT(*) as total FROM subscriptions WHERE status = 'active'"
    );
    const [[monthlyRevenue]] = await connection.query(
      `SELECT COALESCE(SUM(amount), 0) as total
         FROM payments
        WHERE created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)
          AND status = 'success'`
    );
    const [[pendingSubs]] = await connection.query(
      "SELECT COUNT(*) as total FROM subscriptions WHERE status = 'pending'"
    );
    const [[expiredSubs]] = await connection.query(
      "SELECT COUNT(*) as total FROM subscriptions WHERE status = 'expired'"
    );
    const [[todaysEntries]] = await connection.query(
      "SELECT COUNT(*) as total FROM daily_entries WHERE date = CURDATE()"
    );
    const [[pendingChanges]] = await connection.query(
      `SELECT COUNT(*) as total FROM admin_change_requests
        WHERE status = 'pending' AND expires_at > NOW()`
    );

    connection.release();

    res.json({
      success: true,
      data: {
        totalUsers: usersCount.total,
        totalBusinesses: businessCount.total,
        totalBranches: branchesCount.total,
        activeSubscriptions: activeSubs.total,
        monthlyRevenue: monthlyRevenue.total,
        pendingApprovals: pendingSubs.total,
        expiredSubscriptions: expiredSubs.total,
        todaysEntries: todaysEntries.total,
        pendingChangeRequests: pendingChanges.total,
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// ============================================================
// PLANS
// ============================================================
exports.getAllPlans = async (req, res) => {
  try {
    const [plans] = await db.promise().query(
      'SELECT * FROM plans ORDER BY price_kes ASC'
    );
    res.json({ success: true, data: plans });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.createPlan = async (req, res) => {
  const { name, display_name, price_kes, billing_cycle, description, features } = req.body;

  try {
    if (!name || !display_name || price_kes === undefined) {
      return res.status(400).json({ error: 'Name, display name and price are required' });
    }

    const action = 'plan.create';
    const payload = { name, display_name, price_kes, billing_cycle, description, features };

    if (!needsApproval(action) || req.admin.role === 'super_admin') {
      const featuresJson = Array.isArray(features) ? JSON.stringify(features) : features;
      const [result] = await db.promise().query(
        `INSERT INTO plans (name, display_name, price_kes, billing_cycle, description, features, is_active)
         VALUES (?, ?, ?, ?, ?, ?, 1)`,
        [name, display_name, price_kes, billing_cycle || 'monthly', description || null, featuresJson]
      );
      await audit({
        admin: req.admin, action: 'plan.create', targetType: 'plan',
        targetId: result.insertId, payload, req,
      });
      return res.status(201).json({
        success: true,
        message: 'Plan created successfully',
        data: { id: result.insertId, name, display_name, price_kes },
      });
    }

    const queued = await queueChangeRequest({
      req, action, targetType: 'plan', targetId: null,
      before: null, after: payload,
    });
    return queuedResponse(res, queued);
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ error: 'Plan name already exists' });
    }
    res.status(500).json({ error: err.message });
  }
};

exports.updatePlan = async (req, res) => {
  const { id } = req.params;
  const { display_name, price_kes, billing_cycle, description, features, is_active } = req.body;

  try {
    const [plans] = await db.promise().query('SELECT * FROM plans WHERE id = ?', [id]);
    if (!plans.length) return res.status(404).json({ error: 'Plan not found' });
    const before = plans[0];

    const action = 'plan.update';
    const payload = { id: parseInt(id), display_name, price_kes, billing_cycle, description, features, is_active };

    if (req.admin.role === 'super_admin') {
      const updates = [];
      const values = [];
      if (display_name !== undefined) { updates.push('display_name = ?'); values.push(display_name); }
      if (price_kes !== undefined)    { updates.push('price_kes = ?');    values.push(price_kes); }
      if (billing_cycle !== undefined){ updates.push('billing_cycle = ?');values.push(billing_cycle); }
      if (description !== undefined)  { updates.push('description = ?');  values.push(description); }
      if (features !== undefined) {
        updates.push('features = ?');
        values.push(Array.isArray(features) ? JSON.stringify(features) : features);
      }
      if (is_active !== undefined)    { updates.push('is_active = ?');    values.push(is_active ? 1 : 0); }

      if (!updates.length) return res.status(400).json({ error: 'No fields to update' });

      values.push(id);
      await db.promise().query(`UPDATE plans SET ${updates.join(', ')} WHERE id = ?`, values);

      await audit({
        admin: req.admin, action: 'plan.update', targetType: 'plan',
        targetId: id, payload, req,
      });

      return res.json({ success: true, message: 'Plan updated successfully' });
    }

    const queued = await queueChangeRequest({
      req, action, targetType: 'plan', targetId: id,
      before, after: payload,
    });
    return queuedResponse(res, queued);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.togglePlanStatus = async (req, res) => {
  const { id } = req.params;
  const { active } = req.body;

  try {
    const [plans] = await db.promise().query('SELECT * FROM plans WHERE id = ?', [id]);
    if (!plans.length) return res.status(404).json({ error: 'Plan not found' });

    const action = 'plan.toggle';
    const payload = { id: parseInt(id), active: !!active };

    if (req.admin.role === 'super_admin') {
      await db.promise().query(
        'UPDATE plans SET is_active = ? WHERE id = ?',
        [active ? 1 : 0, id]
      );
      await audit({
        admin: req.admin, action, targetType: 'plan',
        targetId: id, payload, req,
      });
      return res.json({ success: true, message: `Plan ${active ? 'activated' : 'deactivated'} successfully` });
    }

    const queued = await queueChangeRequest({
      req, action, targetType: 'plan', targetId: id,
      before: plans[0], after: payload,
    });
    return queuedResponse(res, queued);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.deletePlan = async (req, res) => {
  const { id } = req.params;

  try {
    const [subs] = await db.promise().query(
      'SELECT COUNT(*) as count FROM subscriptions WHERE plan_id = ? AND status = "active"',
      [id]
    );
    if (subs[0].count > 0) {
      return res.status(400).json({
        error: 'Cannot delete plan with active subscriptions. Deactivate it instead.',
      });
    }

    const [plans] = await db.promise().query('SELECT * FROM plans WHERE id = ?', [id]);
    if (!plans.length) return res.status(404).json({ error: 'Plan not found' });

    const action = 'plan.delete';
    const payload = { id: parseInt(id) };

    if (req.admin.role === 'super_admin') {
      await db.promise().query('DELETE FROM plans WHERE id = ?', [id]);
      await audit({
        admin: req.admin, action, targetType: 'plan',
        targetId: id, payload, req,
      });
      return res.json({ success: true, message: 'Plan deleted permanently' });
    }

    const queued = await queueChangeRequest({
      req, action, targetType: 'plan', targetId: id,
      before: plans[0], after: payload,
    });
    return queuedResponse(res, queued);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// ============================================================
// USERS
// ============================================================
exports.getAllUsers = async (req, res) => {
  try {
    const [users] = await db.promise().query(`
      SELECT
        u.*,
        b.name as business_name,
        p.display_name as plan_name,
        DATEDIFF(u.subscription_expires, CURDATE()) as days_left
      FROM users u
      LEFT JOIN businesses b ON u.business_id = b.id
      LEFT JOIN subscriptions s ON u.id = s.user_id AND s.status = 'active'
      LEFT JOIN plans p ON s.plan_id = p.id
      ORDER BY u.created_at DESC
    `);
    res.json({ success: true, data: users });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.updateUser = async (req, res) => {
  const { id } = req.params;
  const { name, phone, user_type, subscription, subscription_status, subscription_expires } = req.body;

  try {
    const [users] = await db.promise().query('SELECT * FROM users WHERE id = ?', [id]);
    if (!users.length) return res.status(404).json({ error: 'User not found' });

    const updates = [];
    const values = [];
    if (name !== undefined)                { updates.push('name = ?');                values.push(name); }
    if (phone !== undefined)               { updates.push('phone = ?');               values.push(phone); }
    if (user_type !== undefined)           { updates.push('user_type = ?');           values.push(user_type); }
    if (subscription !== undefined)        { updates.push('subscription = ?');        values.push(subscription); }
    if (subscription_status !== undefined) { updates.push('subscription_status = ?'); values.push(subscription_status); }
    if (subscription_expires !== undefined){ updates.push('subscription_expires = ?');values.push(subscription_expires); }

    if (!updates.length) return res.status(400).json({ error: 'No fields to update' });

    values.push(id);
    await db.promise().query(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`, values);

    await audit({
      admin: req.admin, action: 'user.update', targetType: 'user',
      targetId: id, payload: req.body, req,
    });

    res.json({ success: true, message: 'User updated successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.deleteUser = async (req, res) => {
  const { id } = req.params;

  try {
    const [users] = await db.promise().query(
      'SELECT id, name, firebase_uid FROM users WHERE id = ?', [id]
    );
    if (!users.length) return res.status(404).json({ error: 'User not found' });
    const user = users[0];

    if (req.admin?.uid && user.firebase_uid === req.admin.uid) {
      return res.status(400).json({ error: 'You cannot delete your own account' });
    }

    const action = 'user.delete';
    const payload = { id: parseInt(id), name: user.name };

    if (req.admin.role === 'super_admin') {
      const conn = await db.promise().getConnection();
      try {
        await conn.beginTransaction();
        await conn.query('DELETE FROM payments WHERE user_id = ?', [id]);
        await conn.query('DELETE FROM users WHERE id = ?', [id]);
        await conn.commit();
      } catch (e) {
        await conn.rollback();
        throw e;
      } finally {
        conn.release();
      }

      await audit({
        admin: req.admin, action, targetType: 'user',
        targetId: id, payload, req,
      });
      return res.json({
        success: true,
        message: `User "${user.name || 'Unknown'}" deleted successfully`,
      });
    }

    const queued = await queueChangeRequest({
      req, action, targetType: 'user', targetId: id,
      before: user, after: payload,
    });
    return queuedResponse(res, queued);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.startTrial = async (req, res) => {
  const { id } = req.params;
  const { days = 30 } = req.body;

  try {
    const [users] = await db.promise().query('SELECT id, name FROM users WHERE id = ?', [id]);
    if (!users.length) return res.status(404).json({ error: 'User not found' });

    const action = 'user.startTrial';
    const payload = { id: parseInt(id), days: parseInt(days) };

    if (req.admin.role === 'super_admin') {
      const conn = await db.promise().getConnection();
      try {
        await conn.beginTransaction();
        const endDate = new Date();
        endDate.setDate(endDate.getDate() + parseInt(days));
        const expires = endDate.toISOString().split('T')[0];

        await conn.query(
          `UPDATE subscriptions SET status = 'expired'
            WHERE user_id = ? AND status = 'active'`, [id]
        );
        await conn.query(
          `INSERT INTO subscriptions
             (user_id, plan_id, plan, amount, start_date, end_date, status, auto_renew)
           VALUES (?, NULL, 'trial', 0, CURDATE(), ?, 'active', 0)`,
          [id, expires]
        );
        await conn.query(
          `UPDATE users SET subscription = 'trial', subscription_status = 'active',
                  subscription_expires = ?
            WHERE id = ?`, [expires, id]
        );
        await conn.commit();
        await audit({
          admin: req.admin, action, targetType: 'user',
          targetId: id, payload, req,
        });
        return res.json({
          success: true,
          message: `User put on ${days}-day trial until ${expires}`,
          expires,
        });
      } catch (e) {
        await conn.rollback();
        throw e;
      } finally {
        conn.release();
      }
    }

    const queued = await queueChangeRequest({
      req, action, targetType: 'user', targetId: id,
      before: users[0], after: payload,
    });
    return queuedResponse(res, queued);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.updateUserSubscription = async (req, res) => {
  const { id } = req.params;
  const { plan_id, subscription_status, months = 1 } = req.body;

  try {
    const action = 'user.updateSubscription';
    const payload = { id: parseInt(id), plan_id, subscription_status, months: parseInt(months) };

    if (req.admin.role === 'super_admin') {
      const conn = await db.promise().getConnection();
      try {
        await conn.beginTransaction();

        if (plan_id && subscription_status === 'active') {
          await conn.query(
            `UPDATE subscriptions SET status = 'expired'
              WHERE user_id = ? AND status = 'active'`, [id]
          );
          const [plans] = await conn.query('SELECT * FROM plans WHERE id = ?', [plan_id]);
          if (plans.length) {
            const plan = plans[0];
            const endDate = new Date();
            endDate.setMonth(endDate.getMonth() + parseInt(months));
            await conn.query(
              `INSERT INTO subscriptions
                 (user_id, plan_id, plan, amount, start_date, end_date, status, auto_renew)
               VALUES (?, ?, ?, ?, CURDATE(), ?, 'active', 1)`,
              [id, plan_id, plan.name, plan.price_kes, endDate.toISOString().split('T')[0]]
            );
            await conn.query(
              `UPDATE users SET subscription = ?, subscription_status = 'active',
                      subscription_expires = ?
                WHERE id = ?`,
              [plan.name, endDate.toISOString().split('T')[0], id]
            );
          }
        } else {
          await conn.query(
            'UPDATE users SET subscription_status = ? WHERE id = ?',
            [subscription_status, id]
          );
        }

        await conn.commit();
        await audit({
          admin: req.admin, action, targetType: 'user',
          targetId: id, payload, req,
        });
        return res.json({ success: true, message: 'User subscription updated' });
      } catch (e) {
        await conn.rollback();
        throw e;
      } finally {
        conn.release();
      }
    }

    const queued = await queueChangeRequest({
      req, action, targetType: 'user', targetId: id,
      before: null, after: payload,
    });
    return queuedResponse(res, queued);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// ============================================================
// PAYMENTS
// ============================================================
exports.getAllPayments = async (req, res) => {
  try {
    const [payments] = await db.promise().query(`
      SELECT
        p.*,
        u.name as user_name,
        u.phone as user_phone,
        pl.display_name as plan_name
      FROM payments p
      LEFT JOIN users u ON p.user_id = u.id
      LEFT JOIN plans pl ON p.subscription = pl.name
      ORDER BY p.created_at DESC
      LIMIT 200
    `);
    res.json({ success: true, data: payments });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.confirmPaymentManually = async (req, res) => {
  const { payment_id } = req.body;

  try {
    const [payments] = await db.promise().query('SELECT * FROM payments WHERE id = ?', [payment_id]);
    if (!payments.length) return res.status(404).json({ error: 'Payment not found' });

    const action = 'payment.confirmManual';
    const payload = { payment_id: parseInt(payment_id) };

    if (req.admin.role === 'super_admin') {
      const conn = await db.promise().getConnection();
      try {
        await conn.beginTransaction();
        const payment = payments[0];
        const receipt = 'ADMIN_' + Date.now();

        await conn.query(
          `UPDATE payments SET mpesa_receipt = ?, status = 'success',
                  transaction_date = NOW()
            WHERE id = ?`, [receipt, payment_id]
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
        await conn.commit();
        await audit({
          admin: req.admin, action, targetType: 'payment',
          targetId: payment_id, payload, req,
        });
        return res.json({ success: true, message: 'Payment confirmed manually', receipt });
      } catch (e) {
        await conn.rollback();
        throw e;
      } finally {
        conn.release();
      }
    }

    const queued = await queueChangeRequest({
      req, action, targetType: 'payment', targetId: payment_id,
      before: payments[0], after: payload,
    });
    return queuedResponse(res, queued);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// ============================================================
// REVENUE
// ============================================================
exports.getRevenueReport = async (req, res) => {
  const { start_date, end_date, group_by = 'day' } = req.query;

  try {
    let groupFormat;
    switch (group_by) {
      case 'month': groupFormat = 'DATE_FORMAT(created_at, "%Y-%m")'; break;
      case 'year':  groupFormat = 'YEAR(created_at)'; break;
      default:      groupFormat = 'DATE(created_at)';
    }

    const [revenue] = await db.promise().query(`
      SELECT
        ${groupFormat} as period,
        COUNT(*) as transaction_count,
        COALESCE(SUM(CASE WHEN status = 'success' THEN amount ELSE 0 END), 0) as total_revenue,
        COALESCE(SUM(CASE WHEN status = 'success' THEN amount ELSE 0 END), 0) as confirmed_revenue,
        COALESCE(SUM(CASE WHEN status = 'pending' THEN amount ELSE 0 END), 0) as pending_revenue
      FROM payments
      WHERE created_at >= ? AND created_at <= ?
      GROUP BY period
      ORDER BY period DESC
    `, [start_date || '2024-01-01', end_date || '2030-12-31']);

    const [[summary]] = await db.promise().query(`
      SELECT
        COALESCE(SUM(amount), 0) as total_all_time,
        COALESCE(SUM(CASE WHEN created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY) THEN amount ELSE 0 END), 0) as last_30_days,
        COALESCE(SUM(CASE WHEN created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY) THEN amount ELSE 0 END), 0) as last_7_days,
        COALESCE(SUM(CASE WHEN DATE(created_at) = CURDATE() THEN amount ELSE 0 END), 0) as today,
        COUNT(DISTINCT user_id) as paying_customers
      FROM payments
      WHERE status = 'success'
    `);

    const [byPlan] = await db.promise().query(`
      SELECT
        p.display_name as plan_name,
        COUNT(*) as sales_count,
        COALESCE(SUM(py.amount), 0) as revenue
      FROM payments py
      LEFT JOIN plans p ON py.subscription = p.name
      WHERE py.status = 'success'
      AND py.created_at >= ? AND py.created_at <= ?
      GROUP BY py.subscription
      ORDER BY revenue DESC
    `, [start_date || '2024-01-01', end_date || '2030-12-31']);

    const [[monthlyRevenue]] = await db.promise().query(
      `SELECT COALESCE(SUM(amount), 0) as total
         FROM payments
        WHERE created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)
          AND status = 'success'`
    );

    res.json({
      success: true,
      data: {
        timeline: revenue,
        summary,
        by_plan: byPlan,
        monthly_revenue: monthlyRevenue.total,
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// ============================================================
// SUBSCRIPTIONS
// ============================================================
exports.getActiveSubscriptions = async (req, res) => {
  const { status = 'active', plan_id, search } = req.query;

  try {
    let whereClause = 'WHERE 1=1';
    const params = [];

    if (status !== 'all') {
      whereClause += ' AND s.status = ?';
      params.push(status);
    }
    if (plan_id) {
      whereClause += ' AND s.plan_id = ?';
      params.push(plan_id);
    }
    if (search) {
      whereClause += ' AND (u.name LIKE ? OR u.phone LIKE ?)';
      const like = `%${search}%`;
      params.push(like, like);
    }

    const [subscriptions] = await db.promise().query(`
      SELECT
        s.*,
        u.name as user_name,
        u.phone as user_phone,
        u.firebase_uid,
        p.display_name as plan_name,
        p.price_kes as plan_price,
        DATEDIFF(s.end_date, CURDATE()) as days_remaining,
        CASE
          WHEN DATEDIFF(s.end_date, CURDATE()) <= 3 THEN 'critical'
          WHEN DATEDIFF(s.end_date, CURDATE()) <= 7 THEN 'warning'
          ELSE 'healthy'
        END as expiry_status
      FROM subscriptions s
      LEFT JOIN users u ON s.user_id = u.id
      LEFT JOIN plans p ON s.plan_id = p.id
      ${whereClause}
      ORDER BY s.end_date ASC
    `, params);

    res.json({ success: true, data: subscriptions });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.renewSubscription = async (req, res) => {
  const { id } = req.params;
  const { months = 1 } = req.body;

  try {
    const [subs] = await db.promise().query('SELECT * FROM subscriptions WHERE id = ?', [id]);
    if (!subs.length) return res.status(404).json({ error: 'Subscription not found' });

    const action = 'subscription.renew';
    const payload = { id: parseInt(id), months: parseInt(months) };

    if (req.admin.role === 'super_admin') {
      const conn = await db.promise().getConnection();
      try {
        await conn.beginTransaction();
        const sub = subs[0];
        const newEndDate = new Date(sub.end_date);
        newEndDate.setMonth(newEndDate.getMonth() + parseInt(months));
        const iso = newEndDate.toISOString().split('T')[0];

        await conn.query(
          `UPDATE subscriptions SET end_date = ?, status = 'active', auto_renew = 1 WHERE id = ?`,
          [iso, id]
        );
        await conn.query(
          `UPDATE users SET subscription_status = 'active', subscription_expires = ? WHERE id = ?`,
          [iso, sub.user_id]
        );
        await conn.commit();
        await audit({
          admin: req.admin, action, targetType: 'subscription',
          targetId: id, payload, req,
        });
        return res.json({
          success: true,
          message: `Renewed for ${months} month(s)`,
          new_end_date: iso,
        });
      } catch (e) {
        await conn.rollback();
        throw e;
      } finally {
        conn.release();
      }
    }

    const queued = await queueChangeRequest({
      req, action, targetType: 'subscription', targetId: id,
      before: subs[0], after: payload,
    });
    return queuedResponse(res, queued);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.cancelSubscription = async (req, res) => {
  const { id } = req.params;

  try {
    const [subs] = await db.promise().query('SELECT * FROM subscriptions WHERE id = ?', [id]);
    if (!subs.length) return res.status(404).json({ error: 'Subscription not found' });

    const action = 'subscription.cancel';
    const payload = { id: parseInt(id) };

    if (req.admin.role === 'super_admin') {
      const conn = await db.promise().getConnection();
      try {
        await conn.beginTransaction();
        await conn.query(
          `UPDATE subscriptions SET status = 'cancelled', auto_renew = 0 WHERE id = ?`,
          [id]
        );
        await conn.query(
          `UPDATE users SET subscription_status = 'cancelled', subscription = NULL WHERE id = ?`,
          [subs[0].user_id]
        );
        await conn.commit();
        await audit({
          admin: req.admin, action, targetType: 'subscription',
          targetId: id, payload, req,
        });
        return res.json({ success: true, message: 'Subscription cancelled' });
      } catch (e) {
        await conn.rollback();
        throw e;
      } finally {
        conn.release();
      }
    }

    const queued = await queueChangeRequest({
      req, action, targetType: 'subscription', targetId: id,
      before: subs[0], after: payload,
    });
    return queuedResponse(res, queued);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.extendSubscription = async (req, res) => {
  const { id } = req.params;
  const { days } = req.body;

  try {
    const [subs] = await db.promise().query('SELECT * FROM subscriptions WHERE id = ?', [id]);
    if (!subs.length) return res.status(404).json({ error: 'Subscription not found' });

    const action = 'subscription.extend';
    const payload = { id: parseInt(id), days: parseInt(days) };

    if (req.admin.role === 'super_admin') {
      await db.promise().query(
        `UPDATE subscriptions SET end_date = DATE_ADD(end_date, INTERVAL ? DAY) WHERE id = ?`,
        [days, id]
      );
      await audit({
        admin: req.admin, action, targetType: 'subscription',
        targetId: id, payload, req,
      });
      return res.json({ success: true, message: `Extended by ${days} days` });
    }

    const queued = await queueChangeRequest({
      req, action, targetType: 'subscription', targetId: id,
      before: subs[0], after: payload,
    });
    return queuedResponse(res, queued);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// ============================================================
// BUSINESSES
// ============================================================
exports.getAllBusinesses = async (req, res) => {
  try {
    const [businesses] = await db.promise().query(`
      SELECT
        b.*,
        u.name as owner_name,
        u.phone as owner_phone,
        (SELECT COUNT(*) FROM branches WHERE business_id = b.id) as branch_count
      FROM businesses b
      LEFT JOIN users u ON b.firebase_uid = u.firebase_uid
      ORDER BY b.created_at DESC
    `);
    res.json({ success: true, data: businesses });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.getBusinessBranches = async (req, res) => {
  const { business_id } = req.params;
  try {
    const [branches] = await db.promise().query(
      'SELECT * FROM branches WHERE business_id = ?',
      [business_id]
    );
    res.json({ success: true, data: branches });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// ============================================================
// CHANGE REQUESTS — the approval engine
// ============================================================
exports.getPendingChangeRequests = async (req, res) => {
  try {
    const [rows] = await db.promise().query(`
      SELECT r.*, u.name AS maker_name
        FROM admin_change_requests r
        LEFT JOIN users u ON u.firebase_uid = r.maker_uid
       WHERE r.status = 'pending' AND r.expires_at > NOW()
       ORDER BY r.created_at DESC
    `);
    res.json({ success: true, data: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.getChangeRequestByCode = async (req, res) => {
  const { code } = req.params;
  try {
    const [rows] = await db.promise().query(
      `SELECT r.*, u.name AS maker_name
         FROM admin_change_requests r
         LEFT JOIN users u ON u.firebase_uid = r.maker_uid
        WHERE r.request_code = ?
        LIMIT 1`,
      [code]
    );
    if (!rows.length) return res.status(404).json({ error: 'Request not found' });
    res.json({ success: true, data: rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.decideChangeRequest = async (req, res) => {
  const { code } = req.params;
  const { decision } = req.body;

  if (!['approve', 'reject'].includes(decision)) {
    return res.status(400).json({ error: 'decision must be approve or reject' });
  }

  const conn = await db.promise().getConnection();
  try {
    await conn.beginTransaction();

    const [rows] = await conn.query(
      `SELECT * FROM admin_change_requests WHERE request_code = ? FOR UPDATE`,
      [code]
    );
    if (!rows.length) {
      await conn.rollback();
      return res.status(404).json({ error: 'Request not found' });
    }
    const r = rows[0];

    if (r.status !== 'pending') {
      await conn.rollback();
      return res.status(409).json({ error: `Already ${r.status}` });
    }
    if (new Date(r.expires_at) < new Date()) {
      await conn.query(`UPDATE admin_change_requests SET status='expired' WHERE id=?`, [r.id]);
      await conn.commit();
      return res.status(410).json({ error: 'Request expired' });
    }
    if (r.attempts >= 5) {
      await conn.rollback();
      return res.status(429).json({ error: 'Too many attempts' });
    }

    if (r.maker_uid === req.admin.uid) {
      await conn.query(
        `UPDATE admin_change_requests SET attempts = attempts + 1 WHERE id = ?`,
        [r.id]
      );
      await conn.commit();
      return res.status(403).json({
        error: 'You cannot approve your own request. Another super admin must approve it.',
      });
    }

    if (decision === 'reject') {
      await conn.query(
        `UPDATE admin_change_requests
            SET status='rejected', checker_uid=?, checker_email=?, decision_at=NOW()
          WHERE id=?`,
        [req.admin.uid, req.admin.email, r.id]
      );
      await conn.query(
        `INSERT INTO admin_audit_log
           (admin_uid, admin_email, action, target_type, target_id,
            payload, change_request_id, ip_address, user_agent)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        [
          req.admin.uid,
          req.admin.email,
          `reject.${r.action}`,
          r.target_type,
          r.target_id,
          toJson(r.payload_before),
          r.id,
          req.ip,
          (req.get('user-agent') || '').slice(0, 255),
        ]
      );
      await conn.commit();
      return res.json({ success: true, status: 'rejected' });
    }

    await applyChange(conn, r);

    await conn.query(
      `UPDATE admin_change_requests
          SET status='consumed', checker_uid=?, checker_email=?, decision_at=NOW()
        WHERE id=?`,
      [req.admin.uid, req.admin.email, r.id]
    );

    await conn.query(
      `INSERT INTO admin_audit_log
         (admin_uid, admin_email, action, target_type, target_id,
          payload, change_request_id, ip_address, user_agent)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [
        req.admin.uid,
        req.admin.email,
        `approve.${r.action}`,
        r.target_type,
        r.target_id,
        toJson(r.payload_after),
        r.id,
        req.ip,
        (req.get('user-agent') || '').slice(0, 255),
      ]
    );

    await conn.commit();
    return res.json({ success: true, status: 'approved' });
  } catch (err) {
    await conn.rollback();
    console.error('[decideChangeRequest]', err);
    return res.status(500).json({ error: err.message });
  } finally {
    conn.release();
  }
};

// ============================================================
// SEND PASSWORD RESET (super-admin only)
//
// Uses the Firebase REST API directly. No Firebase Admin SDK here —
// the Admin SDK credentials were the source of "invalid_grant".
// The Web API key is sufficient for sending the password reset email.
// ============================================================
exports.sendPasswordReset = async (req, res) => {
  const { id } = req.params;

  try {
    // 1. Find the user
    const [rows] = await db.promise().query(
      'SELECT id, name, email FROM users WHERE id = ? LIMIT 1',
      [id]
    );
    if (!rows.length) {
      return res.status(404).json({ error: 'User not found' });
    }
    const user = rows[0];

    if (!user.email) {
      return res.status(400).json({ error: 'User has no email on file' });
    }

    // 2. Rate-limit: don't allow more than one reset per 2 minutes per user
    const twoMinAgo = new Date(Date.now() - 2 * 60 * 1000);
    const [recent] = await db.promise().query(
      `SELECT id FROM admin_audit_log
        WHERE action = 'user.passwordReset'
          AND target_id = ?
          AND created_at >= ?
        LIMIT 1`,
      [String(id), twoMinAgo]
    );
    if (recent.length) {
      return res.status(429).json({
        error: 'A reset email was just sent to this user. Wait 2 minutes before retrying.',
      });
    }

    // 3. Call Firebase REST API to send the password reset email
    const FIREBASE_API_KEY = process.env.FIREBASE_WEB_API_KEY;
    if (!FIREBASE_API_KEY) {
      return res.status(500).json({
        error: 'FIREBASE_WEB_API_KEY not configured on the server.',
      });
    }

    const axios = require('axios');
    const url = `https://identitytoolkit.googleapis.com/v1/accounts:sendOobCode?key=${FIREBASE_API_KEY}`;

    let fbResponse;
    try {
      fbResponse = await axios.post(
        url,
        { requestType: 'PASSWORD_RESET', email: user.email },
        { headers: { 'Content-Type': 'application/json' }, timeout: 15000 }
      );
    } catch (axiosErr) {
      const fbMsg = axiosErr.response?.data?.error?.message || axiosErr.message;
      console.error('[sendPasswordReset] Firebase REST error:', fbMsg);

      if (fbMsg === 'EMAIL_NOT_FOUND') {
        return res.status(404).json({
          error: `Firebase has no account for ${user.email}. Create the account in Firebase first.`,
        });
      }
      if (fbMsg === 'TOO_MANY_ATTEMPTS_TRY_LATER') {
        return res.status(429).json({
          error: 'Firebase has rate-limited reset emails for this address. Try later.',
        });
      }
      if (fbMsg === 'INVALID_EMAIL') {
        return res.status(400).json({ error: 'The email on file is not valid.' });
      }
      if (fbMsg === 'API_KEY_INVALID' || fbMsg === 'API key not valid. Please pass a valid API key.') {
        return res.status(500).json({
          error: 'FIREBASE_WEB_API_KEY is invalid. Check the value in Railway env vars.',
        });
      }
      return res.status(500).json({ error: `Firebase: ${fbMsg}` });
    }

    // 4. Audit log
    await audit({
      admin: req.admin,
      action: 'user.passwordReset',
      targetType: 'user',
      targetId: id,
      payload: { user_id: id, email: user.email },
      req,
    });

    res.json({
      success: true,
      message: `Password reset email sent to ${user.email}`,
      email: user.email,
    });
  } catch (err) {
    console.error('[sendPasswordReset]', err.message);
    res.status(500).json({ error: err.message });
  }
};