// routes/admin.js
const express = require('express');
const router = express.Router();
const { requireAdmin, requireRole } = require('../middleware/adminAuth');
const admin = require('../controllers/adminController');

// ===== PHASE 2 TEST ROUTES (delete after verifying) =====
router.get('/_test/whoami', requireAdmin, (req, res) => {
  res.json({ ok: true, admin: req.admin });
});

router.get('/_test/super-only', requireAdmin, requireRole('super_admin'), (req, res) => {
  res.json({ ok: true, message: 'You are a super_admin', admin: req.admin });
});