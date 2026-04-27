/**
 * Stage Payment Helper
 * Auto-creates payment records when lots are approved by the next stage
 */

const { pool } = require('../config/db');

/**
 * Create a stage payment record automatically when a lot is approved
 * @param {string} stage - The stage being paid (stitching, assembly, washing, finishing)
 * @param {Object} lotData - Lot details
 * @param {string} lotData.lot_no - Lot number
 * @param {string} lotData.sku - SKU code
 * @param {number} lotData.qty - Quantity
 * @param {number} lotData.user_id - Worker's user ID
 * @param {string} lotData.username - Worker's username
 * @returns {Promise<{success: boolean, paymentId?: number, rateConfigured: boolean, error?: string}>}
 */
async function createStagePayment(stage, lotData) {
    const { lot_no, sku, qty, user_id, username } = lotData;

    if (!lot_no || !sku || !qty || !user_id || !username) {
        return { success: false, error: 'Missing required fields', rateConfigured: false };
    }

    let connection;
    try {
        connection = await pool.getConnection();

        // No duplicate check - allow multiple payments for same lot+stage+user
        // Worker can submit partial quantities multiple times (e.g., 200+200+100 = 500)
        // Each submission creates a separate payment record
        // Cheating is prevented at submission layer (can't submit more than remaining pieces)

        // Look up rate for this SKU + stage
        const [rateRows] = await connection.query(
            `SELECT rate FROM stage_rates WHERE sku = ? AND stage = ?`,
            [sku, stage]
        );

        let baseRate = 0;
        let rateConfigured = false;
        let totalAmount = 0;

        if (rateRows.length > 0 && rateRows[0].rate > 0) {
            baseRate = parseFloat(rateRows[0].rate);
            rateConfigured = true;
            totalAmount = baseRate * qty;
        }

        // Look up extra rates
        let extraAmount = 0;
        let extraRatesJson = null;

        if (rateConfigured) {
            const [extraRows] = await connection.query(
                `SELECT extra_name, rate FROM stage_extra_rates WHERE sku = ? AND stage = ?`,
                [sku, stage]
            );

            if (extraRows.length > 0) {
                const extraRates = extraRows.map(e => ({
                    name: e.extra_name,
                    rate: parseFloat(e.rate)
                }));
                extraRatesJson = JSON.stringify(extraRates);
                extraAmount = extraRates.reduce((sum, e) => sum + (e.rate * qty), 0);
                totalAmount += extraAmount;
            }
        }

        // Insert payment record
        const [result] = await connection.query(
            `INSERT INTO stage_payments
             (user_id, username, lot_no, sku, stage, qty, base_rate, extra_rates_json, extra_amount, total_amount, rate_configured, status, created_by, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, NOW())`,
            [user_id, username, lot_no, sku, stage, qty, baseRate, extraRatesJson, extraAmount, totalAmount, rateConfigured ? 1 : 0]
        );

        console.log(`[StagePayment] Created payment for ${stage} - Lot: ${lot_no}, User: ${username}, Amount: ${totalAmount}, Rate Configured: ${rateConfigured}`);

        return {
            success: true,
            paymentId: result.insertId,
            rateConfigured,
            totalAmount
        };

    } catch (error) {
        console.error('[StagePayment] Error creating payment:', error);
        return { success: false, error: error.message, rateConfigured: false };
    } finally {
        if (connection) connection.release();
    }
}

/**
 * Update payment amount when rate is configured later
 * Called by operator when setting rate for a previously unconfigured SKU
 * @param {number} paymentId - Payment ID to update
 * @param {number} baseRate - New base rate
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function updatePaymentRate(paymentId, baseRate) {
    let connection;
    try {
        connection = await pool.getConnection();

        // Get payment details
        const [payment] = await connection.query(
            `SELECT qty, sku, stage, status FROM stage_payments WHERE id = ?`,
            [paymentId]
        );

        if (payment.length === 0) {
            return { success: false, error: 'Payment not found' };
        }

        if (payment[0].status === 'paid') {
            return { success: false, error: 'Cannot update paid payments' };
        }

        const qty = payment[0].qty;
        const sku = payment[0].sku;
        const stage = payment[0].stage;

        // Calculate extra amount
        const [extraRows] = await connection.query(
            `SELECT extra_name, rate FROM stage_extra_rates WHERE sku = ? AND stage = ?`,
            [sku, stage]
        );

        let extraAmount = 0;
        let extraRatesJson = null;

        if (extraRows.length > 0) {
            const extraRates = extraRows.map(e => ({
                name: e.extra_name,
                rate: parseFloat(e.rate)
            }));
            extraRatesJson = JSON.stringify(extraRates);
            extraAmount = extraRates.reduce((sum, e) => sum + (e.rate * qty), 0);
        }

        const totalAmount = (parseFloat(baseRate) * qty) + extraAmount;

        await connection.query(
            `UPDATE stage_payments
             SET base_rate = ?, extra_rates_json = ?, extra_amount = ?, total_amount = ?, rate_configured = 1, updated_at = NOW()
             WHERE id = ?`,
            [baseRate, extraRatesJson, extraAmount, totalAmount, paymentId]
        );

        return { success: true, totalAmount };

    } catch (error) {
        console.error('[StagePayment] Error updating payment rate:', error);
        return { success: false, error: error.message };
    } finally {
        if (connection) connection.release();
    }
}

module.exports = {
    createStagePayment,
    updatePaymentRate
};
