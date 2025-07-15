const express = require('express');
const axios = require('axios');
const router = express.Router();
const { isAuthenticated } = require('../middlewares/auth');

function isUser94(req, res, next) {
  if (req.session && req.session.user && req.session.user.id === 94) {
    return next();
  }
  if (req.headers.accept && req.headers.accept.includes('application/json')) {
    return res.status(403).json({ error: 'Access denied' });
  }
  req.flash('error', 'Access denied');
  return res.redirect('/');
}

router.get('/issue-status', isAuthenticated, isUser94, (req, res) => {
  res.render('issueStatus', { user: req.session.user, results: null, ticketIds: '' });
});

router.post('/issue-status', isAuthenticated, isUser94, async (req, res) => {
  const { ticketIds = '' } = req.body;
  const ids = ticketIds.split(/\r?\n/).map(id => id.trim()).filter(Boolean);
  const results = [];

  for (const id of ids) {
    const searchParam = encodeURIComponent(JSON.stringify([{ field: 'referenceNumber', operation: 'in', value: [id] }]));
    const url = `https://seller.flipkart.com/napi/case-manager/issues-search?undefined=10&search=${searchParam}&flow=&sellerId=qsm29nukm5dhxgl9`;
    try {
      const { data } = await axios.get(url);
      const issue = data?.result?.issueList?.[0];
      if (issue) {
        results.push({
          ticketId: id,
          issueId: issue.issueId,
          displayStatus: issue.displayStatus,
          createdDate: issue.createdDate,
          lastUpdatedDate: issue.lastUpdatedDate,
          resolvedDate: issue.resolvedDate
        });
      } else {
        results.push({ ticketId: id, error: 'Not found' });
      }
    } catch (err) {
      console.error('Failed to fetch issue', id, err.message);
      results.push({ ticketId: id, error: 'Error fetching data' });
    }
  }

  res.render('issueStatus', { user: req.session.user, results, ticketIds });
});

module.exports = router;
