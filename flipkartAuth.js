require('dotenv').config();
const axios = require('axios');
const qs    = require('querystring');

let cached = { token: null, expiresAt: 0 };

/**
 * Fetches a fresh access token, or returns the cached one if still valid.
 */
async function getAccessToken() {
  const now = Date.now();
  if (cached.token && now < cached.expiresAt - 60*1000) {
    return cached.token;    // still valid (with 1m buffer)
  }

  // Build Basic auth header
  const basic = Buffer.from(
    `${process.env.FLIPKART_APP_ID}:${process.env.FLIPKART_APP_SECRET}`
  ).toString('base64');

  // Call the token endpoint
  const resp = await axios.get(
    'https://api.flipkart.net/oauth-service/oauth/token',
    {
      params: {
        grant_type: 'client_credentials',
        scope:      'Seller_Api,Default'
      },
      headers: {
        Authorization: `Basic ${basic}`
      }
    }
  );

  const { access_token, expires_in } = resp.data;
  // Cache it, calculating absolute expiry time
  cached.token     = access_token;
  cached.expiresAt = now + (expires_in * 1000);
  return access_token;
}

module.exports = { getAccessToken };
