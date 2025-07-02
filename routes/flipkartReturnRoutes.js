require('dotenv').config();
const express = require('express');
const axios = require('axios');
const router = express.Router();

router.get('/returns', async (req, res) => {
  // 1. Always use courier_return as source
  const source = 'courier_return';

  // 2. Build the rest of your params
  const { modifiedAfter, modifiedBefore, createdAfter, createdBefore, locationId } = req.query;
  const params = { source, modifiedAfter, modifiedBefore, createdAfter, createdBefore, locationId };

  // 3. Normalize returnIds/trackingIds
  if (req.query.returnIds) {
    params.returnIds = Array.isArray(req.query.returnIds)
      ? req.query.returnIds.join(',')
      : req.query.returnIds;
  }
  if (req.query.trackingIds) {
    params.trackingIds = Array.isArray(req.query.trackingIds)
      ? req.query.trackingIds.join(',')
      : req.query.trackingIds;
  }

  try {
    const url = 'https://api.flipkart.net/sellers/v2/returns';
    const headers = {
      Authorization: `Bearer ${process.env.FLIPKART_API_TOKEN}`,
      Accept: 'application/json',
    };

    const { data } = await axios.get(url, { params, headers });
    res.json(data);
  } catch (err) {
    console.error('Flipkart API error:', err.response?.data || err.message);
    res.status(err.response?.status || 500).json({
      error: err.response?.data || 'Failed to fetch returns'
    });
  }
});

module.exports = router;
