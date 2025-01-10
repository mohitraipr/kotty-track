// routes/fabricManagerRoutes.js

const express = require('express');
const router = express.Router();
const { pool } = require('../config/db');
const { isAuthenticated, isFabricManager } = require('../middlewares/auth');
const multer = require('multer');
const xlsx = require('xlsx');
const fs = require('fs');
const { body, validationResult } = require('express-validator');
const path = require('path');

// Configure Multer for file uploads
const upload = multer({ 
    dest: 'uploads/',
    limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
    fileFilter: (req, file, cb) => {
        if (file.mimetype === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') {
            cb(null, true);
        } else {
            cb(new Error('Only .xlsx files are allowed!'), false);
        }
    }
});

/**
 * Helper Functions
 */

// Convert Excel serial date to JavaScript Date
function excelSerialDateToJSDate(serial) {
    const excelEpoch = new Date(Date.UTC(1899, 11, 30));
    const daysInMs = serial * 24 * 60 * 60 * 1000;
    return new Date(excelEpoch.getTime() + daysInMs);
}

// Format JavaScript Date to 'YYYY-MM-DD'
function formatDateToMySQL(dateObj) {
    const year = dateObj.getUTCFullYear();
    const month = String(dateObj.getUTCMonth() + 1).padStart(2, '0');
    const day = String(dateObj.getUTCDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

/**
 * Routes
 */

/**
 * GET /fabric-manager/dashboard
 * Display the Fabric Manager dashboard with all fabric invoices.
 */
router.get('/dashboard', isAuthenticated, isFabricManager, async (req, res) => {
    const searchTerm = req.query.search || '';
    const pageNum = parseInt(req.query.page || '1', 10);
    const pageSize = 25;
    const offset = (pageNum - 1) * pageSize;

    try {
        // Fetch total count for pagination
        let countQuery = `
            SELECT COUNT(*) AS total 
            FROM fabric_invoices fi
            JOIN vendors v ON fi.vendor_id = v.id
        `;
        let countParams = [];
        if (searchTerm) {
            countQuery += ' WHERE fi.invoice_no LIKE ? OR v.name LIKE ?';
            countParams.push(`%${searchTerm}%`, `%${searchTerm}%`);
        }

        const [countResult] = await pool.query(countQuery, countParams);
        const totalCount = countResult[0].total;
        const totalPages = Math.ceil(totalCount / pageSize);

        // Fetch paginated data
        let dataQuery = `
            SELECT 
                fi.id,
                fi.invoice_no,
                v.name AS vendor_name,
                fi.date_invoice,
                fi.date_received,
                fi.total_roll_quantity,
                fi.fabric_type,
                fi.invoice_weight,
                fi.short_weight,
                fi.received_weight,
                fi.user_id,
                u.username AS created_by
            FROM fabric_invoices fi
            JOIN vendors v ON fi.vendor_id = v.id
            JOIN users u ON fi.user_id = u.id
        `;
        let dataParams = [];
        if (searchTerm) {
            dataQuery += ' WHERE fi.invoice_no LIKE ? OR v.name LIKE ?';
            dataParams.push(`%${searchTerm}%`, `%${searchTerm}%`);
        }
        dataQuery += ' ORDER BY fi.total_roll_quantity DESC LIMIT ? OFFSET ?';
        dataParams.push(pageSize, offset);

        const [fabricInvoices] = await pool.query(dataQuery, dataParams);

        // Fetch all vendors for display purposes
        const [vendors] = await pool.query('SELECT id, name FROM vendors ORDER BY name ASC');

        // Pass variables to the EJS view
        res.render('fabricManagerDashboard', {
            user: req.session.user,
            fabricInvoices,
            searchTerm,
            currentPage: pageNum,
            totalPages,
            vendors, // Pass vendors to the view
            // Removed 'success' and 'error' to rely on res.locals
        });
    } catch (err) {
        console.error('Error loading Fabric Manager Dashboard:', err);
        req.flash('error', 'Failed to load Fabric Manager Dashboard.');
        res.redirect('/');
    }
});

/**
 * GET /fabric-manager/view
 * View fabric invoices with search and pagination.
 */
router.get('/view', isAuthenticated, isFabricManager, async (req, res) => {
    const tableName = 'fabric_invoices';
    const searchTerm = req.query.search || '';
    const pageNum = parseInt(req.query.page || '1', 10);
    const pageSize = 25;
    const offset = (pageNum - 1) * pageSize;

    try {
        // Fetch total count for pagination
        let countQuery = `
            SELECT COUNT(*) AS total 
            FROM fabric_invoices fi
            JOIN vendors v ON fi.vendor_id = v.id
        `;
        let countParams = [];
        if (searchTerm) {
            countQuery += ' WHERE fi.invoice_no LIKE ? OR v.name LIKE ?';
            countParams.push(`%${searchTerm}%`, `%${searchTerm}%`);
        }

        const [countResult] = await pool.query(countQuery, countParams);
        const totalCount = countResult[0].total;
        const totalPages = Math.ceil(totalCount / pageSize);

        // Fetch paginated data
        let dataQuery = `
            SELECT 
                fi.id,
                fi.invoice_no,
                v.name AS vendor_name,
                fi.date_invoice,
                fi.date_received,
                fi.total_roll_quantity,
                fi.fabric_type,
                fi.invoice_weight,
                fi.short_weight,
                fi.received_weight,
                fi.user_id,
                u.username AS created_by
            FROM fabric_invoices fi
            JOIN vendors v ON fi.vendor_id = v.id
            JOIN users u ON fi.user_id = u.id
        `;
        let dataParams = [];
        if (searchTerm) {
            dataQuery += ' WHERE fi.invoice_no LIKE ? OR v.name LIKE ?';
            dataParams.push(`%${searchTerm}%`, `%${searchTerm}%`);
        }
        dataQuery += ' ORDER BY fi.total_roll_quantity DESC LIMIT ? OFFSET ?';
        dataParams.push(pageSize, offset);

        const [fabricInvoices] = await pool.query(dataQuery, dataParams);

        res.render('fabricManagerView', {
            user: req.session.user,
            tableName,
            columns: ['id', 'invoice_no', 'vendor_name', 'date_invoice', 'date_received', 'total_roll_quantity', 'fabric_type', 'invoice_weight', 'short_weight','received_weight', 'user_id', 'created_by'],
            rows: fabricInvoices,
            searchTerm,
            currentPage: pageNum,
            totalPages
            // Removed 'success' and 'error' to rely on res.locals
        });
    } catch (err) {
        console.error('Error in /fabric-manager/view:', err);
        req.flash('error', 'Error loading table data.');
        res.redirect('/fabric-manager/dashboard');
    }
});

/**
 * GET /fabric-manager/download-excel
 * Download fabric invoices as Excel.
 */
router.get('/download-excel', isAuthenticated, isFabricManager, async (req, res) => {
    const searchTerm = req.query.search || '';

    try {
        // Fetch data based on search term
        let dataQuery = `
            SELECT 
                fi.id,
                fi.invoice_no,
                v.name AS vendor_name,
                fi.date_invoice,
                fi.date_received,
                fi.total_roll_quantity,
                fi.fabric_type,
                fi.invoice_weight,
                fi.short_weight,
                fi.received_weight,
                fi.user_id,
                u.username AS created_by
            FROM fabric_invoices fi
            JOIN vendors v ON fi.vendor_id = v.id
            JOIN users u ON fi.user_id = u.id
        `;
        let dataParams = [];
        if (searchTerm) {
            dataQuery += ' WHERE fi.invoice_no LIKE ? OR v.name LIKE ?';
            dataParams.push(`%${searchTerm}%`, `%${searchTerm}%`);
        }
        dataQuery += ' ORDER BY fi.total_roll_quantity DESC';

        const [fabricInvoices] = await pool.query(dataQuery, dataParams);

        if (!fabricInvoices.length) {
            req.flash('error', 'No data available to export.');
            return res.redirect('/fabric-manager/dashboard');
        }

        // Convert data to worksheet
        const worksheet = xlsx.utils.json_to_sheet(fabricInvoices);
        const workbook = xlsx.utils.book_new();
        xlsx.utils.book_append_sheet(workbook, worksheet, 'Fabric_Invoices');

        // Generate buffer
        const buffer = xlsx.write(workbook, { type: 'buffer', bookType: 'xlsx' });

        // Set headers and send the file
        res.setHeader('Content-Disposition', 'attachment; filename="fabric_invoices.xlsx"');
        res.setHeader(
            'Content-Type',
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        );

        res.send(buffer);
    } catch (err) {
        console.error('Error in /fabric-manager/download-excel:', err);
        req.flash('error', 'Error exporting data.');
        res.redirect('/fabric-manager/dashboard');
    }
});

/**
 * POST /fabric-manager/insert/invoice
 * Insert a new fabric invoice.
 */
router.post('/insert/invoice',
    isAuthenticated,
    isFabricManager,
    [
        body('invoice_no').notEmpty().withMessage('Invoice number is required.'),
        body('vendor_id').isInt().withMessage('Valid Vendor is required.'),
        body('date_invoice').isDate().withMessage('Invalid invoice date.'),
        body('date_received').isDate().withMessage('Invalid received date.'),
        body('total_roll_quantity').isInt({ min: 1 }).withMessage('Total roll quantity must be a positive integer.'),
        body('fabric_type').optional().isString().withMessage('Fabric type must be a string.'),
        body('invoice_weight').optional().isDecimal().withMessage('Invoice weight must be a decimal number.'),
        body('received_weight').optional().isDecimal().withMessage('Received weight must be a decimal number.'),
    ],
    async (req, res) => {
        const errors = validationResult(req);
        const user = req.session.user;

        if (!errors.isEmpty()) {
            // Set each error message individually
            errors.array().forEach(err => req.flash('error', err.msg));
            return res.redirect('/fabric-manager/dashboard');
        }

        const { invoice_no, vendor_id, date_invoice, date_received, total_roll_quantity, fabric_type, invoice_weight, received_weight } = req.body;

        // Calculate short_weight
        const short_weight = (invoice_weight && received_weight) ? (parseFloat(invoice_weight) - parseFloat(received_weight)).toFixed(2) : null;

        try {
            // Insert into fabric_invoices
            const insertQuery = `
                INSERT INTO fabric_invoices 
                (invoice_no, vendor_id, date_invoice, date_received, total_roll_quantity, fabric_type, invoice_weight, short_weight, received_weight, user_id)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `;
            await pool.query(insertQuery, [
                invoice_no,
                vendor_id,
                date_invoice,
                date_received,
                total_roll_quantity,
                fabric_type || null,
                invoice_weight || null,
                short_weight,
                received_weight || null,
                user.id
            ]);

            req.flash('success', 'Fabric Invoice inserted successfully.');
            res.redirect('/fabric-manager/dashboard');
        } catch (err) {
            console.error('Error inserting fabric invoice:', err);
            if (err.code === 'ER_DUP_ENTRY') {
                req.flash('error', 'Invoice number must be unique.');
            } else if (err.code === 'ER_NO_REFERENCED_ROW_2') {
                req.flash('error', 'Selected vendor does not exist.');
            } else {
                req.flash('error', 'Error inserting fabric invoice.');
            }
            res.redirect('/fabric-manager/dashboard');
        }
    }
);

/**
 * GET /fabric-manager/invoice/:id/rolls
 * View rolls for a specific fabric invoice.
 */
router.get('/invoice/:id/rolls', isAuthenticated, isFabricManager, async (req, res) => {
    const invoiceId = parseInt(req.params.id, 10);

    if (isNaN(invoiceId)) {
        req.flash('error', 'Invalid Invoice ID.');
        return res.redirect('/fabric-manager/dashboard');
    }

    try {
        // Fetch fabric invoice details
        const [invoiceRows] = await pool.query(`
            SELECT 
                fi.id,
                fi.invoice_no,
                v.name AS vendor_name,
                fi.date_invoice,
                fi.date_received,
                fi.total_roll_quantity,
                fi.fabric_type,
                fi.invoice_weight,
                fi.short_weight,
                fi.received_weight,
                fi.user_id,
                u.username AS created_by
            FROM fabric_invoices fi
            JOIN vendors v ON fi.vendor_id = v.id
            JOIN users u ON fi.user_id = u.id
            WHERE fi.id = ?
        `, [invoiceId]);

        if (invoiceRows.length === 0) {
            req.flash('error', 'Fabric Invoice not found.');
            return res.redirect('/fabric-manager/dashboard');
        }

        const invoice = invoiceRows[0];

        // Fetch associated rolls
        const [rolls] = await pool.query(`
            SELECT 
                fir.id,
                fir.roll_no,
                fir.per_roll_weight,
                fir.color,
                fir.gr_no_by_vendor,
                fir.unit,
                fir.user_id,
                u.username AS created_by
            FROM fabric_invoice_rolls fir
            JOIN users u ON fir.user_id = u.id
            WHERE fir.invoice_id = ?
            ORDER BY fir.roll_no ASC
        `, [invoiceId]);

        res.render('fabricInvoiceRolls', {
            user: req.session.user,
            invoice,
            rolls
            // Removed 'success' and 'error' to rely on res.locals
        });
    } catch (err) {
        console.error('Error fetching fabric invoice rolls:', err);
        req.flash('error', 'Error fetching fabric invoice rolls.');
        res.redirect('/fabric-manager/dashboard');
    }
});

/**
 * POST /fabric-manager/insert/roll
 * Insert a new fabric invoice roll.
 */
router.post('/insert/roll',
    isAuthenticated,
    isFabricManager,
    [
        body('invoice_id').isInt().withMessage('Invalid Invoice ID.'),
        body('roll_no').isInt({ min: 1 }).withMessage('Roll number must be a positive integer.'),
        body('per_roll_weight').isDecimal({ decimal_digits: '0,2' }).withMessage('Per Roll Weight must be a decimal number.'),
        body('color').optional().isString().withMessage('Color must be a string.'),
        body('gr_no_by_vendor').optional().isString().withMessage('GR No by Vendor must be a string.'),
        body('unit').isIn(['METER','KG']).withMessage('Unit must be either METER or KG.')
    ],
    async (req, res) => {
        const errors = validationResult(req);
        const user = req.session.user;

        if (!errors.isEmpty()) {
            // Set each error message individually
            errors.array().forEach(err => req.flash('error', err.msg));
            return res.redirect(`/fabric-manager/invoice/${req.body.invoice_id}/rolls`);
        }

        const { invoice_id, roll_no, per_roll_weight, color, gr_no_by_vendor, unit } = req.body;

        try {
            // Fetch vendor_id from the invoice
            const [invoiceRows] = await pool.query(
                'SELECT vendor_id FROM fabric_invoices WHERE id = ?',
                [invoice_id]
            );

            if (invoiceRows.length === 0) {
                req.flash('error', 'Associated Fabric Invoice not found.');
                return res.redirect('/fabric-manager/dashboard');
            }

            const vendor_id = invoiceRows[0].vendor_id;

            // Check if the roll_no already exists for the given vendor_id
            const [existingRoll] = await pool.query(
                'SELECT id FROM fabric_invoice_rolls WHERE vendor_id = ? AND roll_no = ?',
                [vendor_id, roll_no]
            );

            if (existingRoll.length > 0) {
                req.flash('error', 'Roll number must be unique for this vendor.');
                return res.redirect(`/fabric-manager/invoice/${invoice_id}/rolls`);
            }

            // Insert into fabric_invoice_rolls
            const insertQuery = `
                INSERT INTO fabric_invoice_rolls 
                (invoice_id, vendor_id, roll_no, per_roll_weight, color, gr_no_by_vendor, unit, user_id)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `;
            await pool.query(insertQuery, [
                invoice_id,
                vendor_id,
                roll_no,
                per_roll_weight,
                color || null,
                gr_no_by_vendor || null,
                unit,
                user.id
            ]);

            req.flash('success', 'Fabric Invoice Roll inserted successfully.');
            res.redirect(`/fabric-manager/invoice/${invoice_id}/rolls`);
        } catch (err) {
            console.error('Error inserting fabric invoice roll:', err);
            if (err.code === 'ER_DUP_ENTRY') {
                req.flash('error', 'Roll number must be unique for this vendor.');
            } else {
                req.flash('error', 'Error inserting fabric invoice roll.');
            }
            res.redirect(`/fabric-manager/invoice/${invoice_id}/rolls`);
        }
    }
);

/**
 * GET /fabric-manager/invoice/:id/download-rolls
 * Download rolls of a specific fabric invoice as Excel.
 */
router.get('/invoice/:id/download-rolls', isAuthenticated, isFabricManager, async (req, res) => {
    const invoiceId = parseInt(req.params.id, 10);

    if (isNaN(invoiceId)) {
        req.flash('error', 'Invalid Invoice ID.');
        return res.redirect('/fabric-manager/dashboard');
    }

    try {
        // Fetch fabric invoice
        const [invoiceRows] = await pool.query(`
            SELECT 
                fi.id,
                fi.invoice_no,
                v.name AS vendor_name,
                fi.date_invoice,
                fi.date_received,
                fi.total_roll_quantity,
                fi.fabric_type,
                fi.invoice_weight,
                fi.short_weight,
                fi.received_weight,
                fi.user_id,
                u.username AS created_by
            FROM fabric_invoices fi
            JOIN vendors v ON fi.vendor_id = v.id
            JOIN users u ON fi.user_id = u.id
            WHERE fi.id = ?
        `, [invoiceId]);

        if (invoiceRows.length === 0) {
            req.flash('error', 'Fabric Invoice not found.');
            return res.redirect('/fabric-manager/dashboard');
        }

        const invoice = invoiceRows[0];

        // Fetch associated rolls
        const [rolls] = await pool.query(`
            SELECT 
                fir.id,
                fir.roll_no,
                fir.per_roll_weight,
                fir.color,
                fir.gr_no_by_vendor,
                fir.unit,
                fir.user_id,
                u.username AS created_by
            FROM fabric_invoice_rolls fir
            JOIN users u ON fir.user_id = u.id
            WHERE fir.invoice_id = ?
            ORDER BY fir.roll_no ASC
        `, [invoiceId]);

        if (!rolls.length) {
            req.flash('error', 'No rolls found for this invoice.');
            return res.redirect(`/fabric-manager/invoice/${invoiceId}/rolls`);
        }

        // Convert data to worksheet
        const worksheet = xlsx.utils.json_to_sheet(rolls);
        const workbook = xlsx.utils.book_new();
        xlsx.utils.book_append_sheet(workbook, worksheet, 'Invoice_Rolls');

        // Generate buffer
        const buffer = xlsx.write(workbook, { type: 'buffer', bookType: 'xlsx' });

        // Set headers and send the file
        res.setHeader('Content-Disposition', `attachment; filename="invoice_${invoice.invoice_no}_rolls.xlsx"`);
        res.setHeader(
            'Content-Type',
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        );

        res.send(buffer);
    } catch (err) {
        console.error('Error downloading fabric invoice rolls:', err);
        req.flash('error', 'Error downloading fabric invoice rolls.');
        res.redirect('/fabric-manager/dashboard');
    }
});

/**
 * GET /fabric-manager/bulk-upload
 * Render the bulk upload page for fabric invoices.
 */
router.get('/bulk-upload', isAuthenticated, isFabricManager, async (req, res) => {
    try {
        // Fetch all vendors for the upload form
        const [vendors] = await pool.query('SELECT id, name FROM vendors ORDER BY name ASC');
        res.render('bulkUpload', {
            user: req.session.user,
            tableName: 'fabric_invoices',
            vendors, // Pass vendors to the view for selection
            // Removed 'success' and 'error' to rely on res.locals
        });
    } catch (err) {
        console.error('Error loading bulk upload page:', err);
        req.flash('error', 'Error loading bulk upload page.');
        res.redirect('/fabric-manager/dashboard');
    }
});

/**
 * POST /fabric-manager/bulk-upload/invoices
 * Handle bulk upload of fabric invoices via Excel.
 */
router.post('/bulk-upload/invoices',
    isAuthenticated,
    isFabricManager,
    upload.single('excelFile'),
    async (req, res) => {
        const tableName = 'fabric_invoices';
        const user = req.session.user;

        if (!req.file) {
            req.flash('error', 'No file was uploaded.');
            return res.redirect('/fabric-manager/bulk-upload');
        }

        try {
            // Read the uploaded Excel file
            const workbook = xlsx.readFile(req.file.path);
            const sheetName = workbook.SheetNames[0];
            const worksheet = workbook.Sheets[sheetName];
            const jsonData = xlsx.utils.sheet_to_json(worksheet, { defval: null }); // Use defval to handle empty cells

            // Validate and prepare data
            const preparedData = [];
            let rowNumber = 2; // Assuming the first row is headers

            for (const row of jsonData) {
                // Ensure mandatory fields are present
                const requiredFields = ['invoice_no', 'vendor_name', 'date_invoice', 'date_received', 'total_roll_quantity', 'invoice_weight', 'received_weight'];
                for (const field of requiredFields) {
                    if (row[field] === undefined || row[field] === null || row[field].toString().trim() === '') {
                        throw new Error(`Missing required field: ${field} in row ${rowNumber}`);
                    }
                }

                // Resolve vendor_id from vendor_name
                const vendorName = row.vendor_name.toString().trim();
                const [vendorRows] = await pool.query(
                    'SELECT id FROM vendors WHERE name = ?',
                    [vendorName]
                );

                let vendor_id;
                if (vendorRows.length > 0) {
                    vendor_id = vendorRows[0].id;
                } else {
                    // Option 1: Throw an error
                    // throw new Error(`Vendor "${vendorName}" does not exist in row ${rowNumber}`);

                    // Option 2: Create a new vendor
                    const insertVendorQuery = `
                        INSERT INTO vendors (name)
                        VALUES (?)
                    `;
                    const [newVendor] = await pool.query(insertVendorQuery, [vendorName]);
                    vendor_id = newVendor.insertId;
                }

                // Convert dates if necessary
                let formattedDateInvoice = row.date_invoice;
                let formattedDateReceived = row.date_received;

                if (typeof row.date_invoice === 'number') {
                    formattedDateInvoice = formatDateToMySQL(excelSerialDateToJSDate(row.date_invoice));
                }

                if (typeof row.date_received === 'number') {
                    formattedDateReceived = formatDateToMySQL(excelSerialDateToJSDate(row.date_received));
                }

                // Calculate short_weight
                const invoice_weight = parseFloat(row.invoice_weight);
                const received_weight = parseFloat(row.received_weight);
                const short_weight = (invoice_weight - received_weight).toFixed(2);

                // Prepare the data array
                preparedData.push([
                    row.invoice_no.toString().trim(),
                    vendor_id,
                    formattedDateInvoice,
                    formattedDateReceived,
                    row.total_roll_quantity,
                    row.fabric_type ? row.fabric_type.toString().trim() : null,
                    invoice_weight,
                    short_weight,
                    received_weight,
                    user.id
                ]);

                rowNumber++;
            }

            // Insert data into the database using a transaction
            const connection = await pool.getConnection();
            try {
                await connection.beginTransaction();

                const insertQuery = `
                    INSERT INTO fabric_invoices 
                    (invoice_no, vendor_id, date_invoice, date_received, total_roll_quantity, fabric_type, invoice_weight, short_weight, received_weight, user_id)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                `;

                for (const data of preparedData) {
                    await connection.query(insertQuery, data);
                }

                await connection.commit();
                connection.release();

                // Delete the uploaded file after processing
                fs.unlinkSync(req.file.path);

                req.flash('success', 'Bulk upload of Fabric Invoices was successful.');
                res.redirect('/fabric-manager/dashboard');
            } catch (transactionError) {
                await connection.rollback();
                connection.release();

                // Delete the uploaded file after processing
                fs.unlinkSync(req.file.path);

                console.error('Transaction Error during bulk upload:', transactionError);
                if (transactionError.code === 'ER_DUP_ENTRY') {
                    req.flash('error', 'One or more invoice numbers already exist.');
                } else {
                    req.flash('error', `Bulk upload failed: ${transactionError.message}`);
                }
                res.redirect('/fabric-manager/bulk-upload');
            }
        } catch (err) {
            console.error('Error during bulk upload:', err);
            // Delete the uploaded file after processing
            if (fs.existsSync(req.file.path)) {
                fs.unlinkSync(req.file.path);
            }
            req.flash('error', `Bulk upload failed: ${err.message}`);
            res.redirect('/fabric-manager/bulk-upload');
        }
    }
);

/**
 * GET /fabric-manager/bulk-upload/rolls
 * Render the bulk upload page for fabric invoice rolls.
 */
router.get('/bulk-upload/rolls', isAuthenticated, isFabricManager, async (req, res) => {
    try {
        // Fetch all vendors for the upload form
        const [vendors] = await pool.query('SELECT id, name FROM vendors ORDER BY name ASC');
        res.render('bulkUploadRolls', {
            user: req.session.user,
            tableName: 'fabric_invoice_rolls',
            vendors, // Pass vendors to the view for selection
            // Removed 'success' and 'error' to rely on res.locals
        });
    } catch (err) {
        console.error('Error loading bulk upload rolls page:', err);
        req.flash('error', 'Error loading bulk upload rolls page.');
        res.redirect('/fabric-manager/dashboard');
    }
});

/**
 * POST /fabric-manager/bulk-upload/rolls
 * Handle bulk upload of fabric invoice rolls via Excel.
 */
router.post('/bulk-upload/rolls',
    isAuthenticated,
    isFabricManager,
    upload.single('excelFile'),
    async (req, res) => {
        const tableName = 'fabric_invoice_rolls';
        const user = req.session.user;

        if (!req.file) {
            req.flash('error', 'No file was uploaded.');
            return res.redirect('/fabric-manager/bulk-upload/rolls');
        }

        try {
            // Read the uploaded Excel file
            const workbook = xlsx.readFile(req.file.path);
            const sheetName = workbook.SheetNames[0];
            const worksheet = workbook.Sheets[sheetName];
            const jsonData = xlsx.utils.sheet_to_json(worksheet, { defval: null }); // Use defval to handle empty cells

            // Validate and prepare data
            const preparedData = [];
            let rowNumber = 2; // Assuming the first row is headers

            for (const row of jsonData) {
                // Ensure mandatory fields are present
                const requiredFields = ['invoice_no', 'roll_no', 'per_roll_weight', 'unit'];
                for (const field of requiredFields) {
                    if (row[field] === undefined || row[field] === null || row[field].toString().trim() === '') {
                        throw new Error(`Missing required field: ${field} in row ${rowNumber}`);
                    }
                }

                // Validate unit
                const validUnits = ['METER', 'KG'];
                if (!validUnits.includes(row.unit)) {
                    throw new Error(`Invalid unit '${row.unit}' in row ${rowNumber}. Must be 'METER' or 'KG'.`);
                }

                // Resolve invoice_id from invoice_no
                const invoiceNo = row.invoice_no.toString().trim();
                const [invoiceRows] = await pool.query(
                    'SELECT id, vendor_id FROM fabric_invoices WHERE invoice_no = ?',
                    [invoiceNo]
                );

                if (invoiceRows.length === 0) {
                    throw new Error(`Fabric Invoice "${invoiceNo}" does not exist in row ${rowNumber}`);
                }

                const invoice_id = invoiceRows[0].id;
                const vendor_id = invoiceRows[0].vendor_id;

                // Check for duplicate roll_no within the same vendor in the uploaded data
                const duplicateInPreparedData = preparedData.find(
                    data => data[1] === row.roll_no && data[2] === vendor_id
                );
                if (duplicateInPreparedData) {
                    throw new Error(`Duplicate roll_no ${row.roll_no} for vendor_id ${vendor_id} in row ${rowNumber}`);
                }

                // Optional: Validate per_roll_weight is a positive number
                const per_roll_weight = parseFloat(row.per_roll_weight);
                if (isNaN(per_roll_weight) || per_roll_weight <= 0) {
                    throw new Error(`Invalid per_roll_weight '${row.per_roll_weight}' in row ${rowNumber}. Must be a positive number.`);
                }

                // Prepare the data array
                preparedData.push([
                    invoice_id,
                    row.roll_no,
                    vendor_id,
                    per_roll_weight,
                    row.color ? row.color.toString().trim() : null,
                    row.gr_no_by_vendor ? row.gr_no_by_vendor.toString().trim() : null,
                    row.unit,
                    user.id
                ]);

                rowNumber++;
            }

            // Insert data into the database using a transaction
            const connection = await pool.getConnection();
            try {
                await connection.beginTransaction();

                const insertQuery = `
                    INSERT INTO fabric_invoice_rolls 
                    (invoice_id, roll_no, vendor_id, per_roll_weight, color, gr_no_by_vendor, unit, user_id)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                `;

                for (const data of preparedData) {
                    await connection.query(insertQuery, data);
                }

                await connection.commit();
                connection.release();

                // Delete the uploaded file after processing
                fs.unlinkSync(req.file.path);

                req.flash('success', 'Bulk upload of Fabric Invoice Rolls was successful.');
                res.redirect('/fabric-manager/dashboard');
            } catch (transactionError) {
                await connection.rollback();
                connection.release();

                // Delete the uploaded file after processing
                fs.unlinkSync(req.file.path);

                // Handle duplicate entry error for (vendor_id, roll_no)
                if (transactionError.code === 'ER_DUP_ENTRY') {
                    req.flash('error', 'One or more roll numbers already exist for the specified vendors.');
                } else {
                    req.flash('error', `Bulk upload failed: ${transactionError.message}`);
                }
                console.error('Transaction Error during bulk upload of rolls:', transactionError);
                res.redirect('/fabric-manager/bulk-upload/rolls');
            }
        } catch (err) {
            console.error('Error during bulk upload of rolls:', err);
            // Delete the uploaded file after processing
            if (fs.existsSync(req.file.path)) {
                fs.unlinkSync(req.file.path);
            }
            req.flash('error', `Bulk upload failed: ${err.message}`);
            res.redirect('/fabric-manager/bulk-upload/rolls');
        }
    }
);

/**
 * GET /fabric-manager
 * Redirect to /fabric-manager/dashboard
 */
router.get('/', (req, res) => {
    res.redirect('/fabric-manager/dashboard');
});

/**
 * Additional Routes (e.g., Editing, Deleting) can be added similarly.
 */

module.exports = router;
