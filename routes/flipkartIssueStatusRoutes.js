const express = require('express');
const axios  = require('axios');
const router = express.Router();
const { isAuthenticated } = require('../middlewares/auth');

// Only allow user ID 94
function isUser94(req, res, next) {
  if (req.session?.user?.id === 94) return next();
  if (req.headers.accept?.includes('application/json')) {
    return res.status(403).json({ error: 'Access denied' });
  }
  req.flash('error', 'Access denied');
  res.redirect('/');
}

router.get('/issue-status', isAuthenticated, isUser94, (req, res) => {
  res.render('issueStatus', {
    user: req.session.user,
    results: [],
    ticketIds: ''
  });
});

router.post('/issue-status', isAuthenticated, isUser94, async (req, res) => {
  const ids     = (req.body.ticketIds || '')
                    .split(/\r?\n/)
                    .map(s => s.trim())
                    .filter(Boolean);
  const results = [];

  // Forward the seller's Flipkart session cookies and XSRF token
  const axiosConfig = {
    headers: {
      Cookie: req.headers.cookie || '',
      'x-xsrf-token': req.cookies['XSRF-TOKEN'] || ''
    }
  };

  for (let id of ids) {
    const searchParam = encodeURIComponent(
      JSON.stringify([{ field: 'referenceNumber', operation: 'in', value: [id] }])
    );
    const url = `https://seller.flipkart.com/napi/case-manager/issues-search`
              + `?pageSize=1&search=${searchParam}&flow=&sellerId=qsm29nukm5dhxgl9`;

    try {
      const { data } = await axios.get(url, axiosConfig);
      const issue     = data?.result?.issueList?.[0];

      if (issue) {
        // Helper to extract named additionalFields
        const getField = name =>
          issue.additionalFields.find(f => f.name === name)?.value || '';

        results.push({
          ticketId:        id,
          issueId:         issue.issueId,
          displayStatus:   issue.displayStatus,
          createdDate:     issue.createdDate,
          lastUpdatedDate: issue.lastUpdatedDate,
          resolvedDate:    issue.resolvedDate,
          tat:             getField('TAT'),
          repromiseTat:    getField('REPROMISE_TAT'),
        });
      } else {
        results.push({ ticketId: id, error: 'Not found' });
      }
    } catch (err) {
      console.error('Failed to fetch issue', id, err);
      results.push({ ticketId: id, error: 'Error fetching data' });
    }
  }

  res.render('issueStatus', {
    user:      req.session.user,
    results,
    ticketIds: ids.join('\n')
  });
});

module.exports = router;
