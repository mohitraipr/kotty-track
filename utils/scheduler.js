// Central place to register all node-cron jobs. Started once from app.js.
//
// Disable on a per-instance basis with DISABLE_CRON=1 (e.g. local dev,
// or to make sure only one Cloud Run revision runs them).

const cron = require('node-cron');
const { syncAjioShipments } = require('./ajioShipmentSync');
const { runMailAutoReply } = require('./mailAutoReplyJob');

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

  // Ajio shipment reconciliation cron — opt-in only. Default OFF because
  // AWBs now come from the vmsOperator manual upload sheet.
  if (process.env.AJIO_RECON_ENABLED === '1' || process.env.AJIO_RECON_ENABLED === 'true') {
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
  } else {
    console.log('[cron] ajio shipment recon DISABLED (set AJIO_RECON_ENABLED=1 to re-enable)');
  }

  // Mail auto-reply: 9 AM and 9 PM IST.
  // Scans inbox, resolves AWB via order_awb_mapping → ee_orders.reference_code,
  // sends Zoho reply with video link if found.
  cron.schedule(
    process.env.MAIL_REPLY_CRON || '0 9,21 * * *',
    async () => {
      try {
        await runMailAutoReply();
      } catch (err) {
        console.error('[cron] mail auto-reply failed:', err);
      }
    },
    { timezone: TZ }
  );

  console.log(`[cron] scheduled mail auto-reply (9 AM, 9 PM ${TZ})`);
}

module.exports = { startCronJobs };
