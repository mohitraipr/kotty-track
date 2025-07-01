const express = require('express');
const axios = require('axios');
const router = express.Router();

// GET /returns - proxy Flipkart Returns API
router.get('/returns', async (req, res) => {
  // Query params from request forwarded to Flipkart
  const params = {
    source: req.query.source,
    modifiedAfter: req.query.modifiedAfter,
    modifiedBefore: req.query.modifiedBefore,
    createdAfter: req.query.createdAfter,
    createdBefore: req.query.createdBefore,
    locationId: req.query.locationId,
    returnIds: req.query.returnIds,
    trackingIds: req.query.trackingIds
  };

  // Remove undefined values
  Object.keys(params).forEach(key => {
    if (!params[key]) delete params[key];
  });

  try {
    const url = 'https://api.flipkart.net/sellers/v2/returns';
    const headers = {
      // Authentication headers from environment variables
      Authorization: `Bearer ${global.env.FLIPKART_API_TOKEN}`,
      'Content-Type': 'application/json'
    };

    const response = await axios.get(url, { params, headers });
    res.json(response.data);
  } catch (err) {
    console.error('Flipkart API error:', err.response ? err.response.data : err.message);
    res.status(500).json({ error: 'Failed to fetch returns' });
  }
});

module.exports = router;
