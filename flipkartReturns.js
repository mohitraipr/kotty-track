const fetch = require('node-fetch');
const crypto = require('crypto');

/**
 * Fetch return details from the Flipkart Seller API.
 * Environment variables needed:
 *   FLIPKART_API_URL    - Base URL for the returns endpoint
 *   FLIPKART_APP_ID     - Your Flipkart application ID
 *   FLIPKART_APP_SECRET - Your Flipkart application secret
 */
async function getReturns() {
  const url = process.env.FLIPKART_API_URL || 'https://api.flipkart.net/sellers/v2/returns';
  const appId = process.env.FLIPKART_APP_ID;
  const appSecret = process.env.FLIPKART_APP_SECRET;
  const timestamp = new Date().toISOString();
  const signature = createSignature(appId, appSecret, timestamp);

  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
      'Fk-Affiliate-Id': appId,
      'Fk-Affiliate-Token': signature,
      'Timestamp': timestamp
    }
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`API request failed with status ${response.status}: ${text}`);
  }

  const data = await response.json();
  console.log(JSON.stringify(data, null, 2));
}

function createSignature(appId, secret, timestamp) {
  const baseString = `${appId}${timestamp}`;
  return crypto
    .createHmac('sha256', secret)
    .update(baseString)
    .digest('base64');
}

getReturns().catch(err => {
  console.error('Error fetching returns:', err.message);
});
