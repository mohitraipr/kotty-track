const express = require('express');
const axios   = require('axios');
const { getAccessToken } = require('./flipkartAuth');

const router = express.Router();
const SOURCE = 'courier_return';

router.get('/returns', async (req, res) => {
  // Build params
  const { modifiedAfter, modifiedBefore, createdAfter, createdBefore, locationId } = req.query;
  const params = { source: SOURCE, modifiedAfter, modifiedBefore, createdAfter, createdBefore, locationId };

  ['returnIds','trackingIds'].forEach(key => {
    if (req.query[key]) {
      params[key] = Array.isArray(req.query[key]) 
        ? req.query[key].join(',') 
        : req.query[key];
    }
  });

  try {
    const token = await getAccessToken();
    const { data } = await axios.get(
      'https://api.flipkart.net/sellers/v2/returns',
      {
        params,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept:        'application/json'
        }
      }
    );
    res.json(data);

  } catch (err) {
    console.error('Flipkart API error:', err.response?.data || err.message);
    const status = err.response?.status || 500;
    res.status(status).json({ error: err.response?.data || 'Failed to fetch returns' });
  }
});

module.exports = router;
