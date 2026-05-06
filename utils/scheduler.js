// Central place to register all node-cron jobs. Started once from app.js.
//
// Disable on a per-instance basis with DISABLE_CRON=1 (e.g. local dev,
// or to make sure only one Cloud Run revision runs them).

const cron = require('node-cron');
const { syncAjioShipments } = require('./ajioShipmentSync');

const TZ = process.env.CRON_TIMEZONE || 'Asia/Kolkata';
const disabled = process.env.DISABLE_CRON === '1' || process.env.DISABLE_CRON === 'true';

let started = false;

function startCronJobs() {
  if (started) return;
  started = true;
  if (disabled) {
    console.log('[cron] DISABLE_CRON set, no jobs scheduled');
    return;
  }

  // Ajio shipment reconciliation: every 30 min.
  // Pulls Printed/Shipped Ajio orders and upserts AWBs into ee_shipments.
  cron.schedule(
    process.env.AJIO_RECON_CRON || '*/30 * * * *',
    async () => {
      try {
        await syncAjioShipments();
      } catch (err) {
        console.error('[cron] ajio recon failed:', err);
      }
    },
    { timezone: TZ }
  );

  console.log(`[cron] scheduled ajio shipment recon (every 30 min, TZ=${TZ})`);
}

module.exports = { startCronJobs };
