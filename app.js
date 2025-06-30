// app.js

const express = require('express');
const session = require('express-session');
const flash = require('connect-flash');
const path = require('path');

// Load environment variables securely using secure-env
const secureEnv = require('secure-env');
global.env = secureEnv({ secret: 'mySecretPassword' }); // Replace with your actual secret

const app = express();

// Trust the ALB proxy so that Express correctly identifies the protocol
app.set('trust proxy', true);

// Middleware to redirect HTTP requests to HTTPS
/*app.use((req, res, next) => {
    // req.secure is set correctly because of trust proxy
    if (!req.secure) {
        return res.redirect('https://' + req.headers.host + req.url);
    }
    next();
});
*/
// Middleware
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Session Configuration
app.use(session({
    secret: global.env.SESSION_SECRET || 'your_session_secret',
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: global.env.NODE_ENV === 'production', // With ALB and redirection, ensure cookies are sent only over HTTPS
        httpOnly: true,
        maxAge: 1000 * 60 * 60 * 24 // 1 day
    }
}));

app.use(flash());

// Set EJS as the templating engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Serve Static Files
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use('/public', express.static(path.join(__dirname, 'public')));

// Global Variables for Views
app.use((req, res, next) => {
    res.locals.error = req.flash('error');
    res.locals.success = req.flash('success');
    next();
});

// Import Routes
const authRoutes = require('./routes/authRoutes');
const adminRoutes = require('./routes/adminRoutes');
const dashboardRoutes = require('./routes/dashboardRoutes');
const operatorRoutes = require('./routes/operatorRoutes');
const fabricManagerRoutes = require('./routes/fabricManagerRoutes'); // Import Fabric Manager Routes
const cuttingManagerRoutes = require('./routes/cuttingManagerRoutes');
const departmentRoutes = require('./routes/departmentRoutes');
const stitchingRoutes = require('./routes/stitchingRoutes');
const finishingRoutes = require('./routes/finishingRoutes');
const washingRoutes = require('./routes/washingRoutes');
const searchRoutes = require('./routes/searchRoutes');
const assigntowashingRoutes = require('./routes/assigntowashingRoutes');
const bulkUploadRoutes = require('./routes/bulkUploadRoutes');
const jeansAssemblyRoutes = require('./routes/jeansAssemblyRoutes.js');
const editCuttingLotRoutes = require("./routes/editcuttinglots.js");
const washingIN = require('./routes/washingInRoutes');
const catalogR = require('./routes/catalogupload');
const storeAdminRoutes = require('./routes/storeAdminRoutes');
const hrRoutes = require('./routes/hrRoutes');
const inventoryRoutes = require('./routes/inventoryRoutes');
const departmentMgmtRoutes = require('./routes/departmentMgmtRoutes');
const employeeRoutes = require('./routes/employeeRoutes');
const salaryRoutes = require('./routes/salaryRoutes');
const operatorEmployeeRoutes = require('./routes/operatorEmployeeRoutes');

// Use Routes
app.use('/', authRoutes);
app.use('/admin', adminRoutes);
app.use('/dashboard', dashboardRoutes);
app.use('/operator', operatorRoutes);
app.use('/fabric-manager', fabricManagerRoutes); // Use Fabric Manager Routes
app.use('/cutting-manager', cuttingManagerRoutes);
app.use('/department', departmentRoutes);
app.use('/stitchingdashboard', stitchingRoutes);
app.use('/finishingdashboard', finishingRoutes);
app.use('/washingdashboard', washingRoutes);
app.use('/', searchRoutes);
app.use('/assign-to-washing', assigntowashingRoutes);
app.use('/jeansassemblydashboard', jeansAssemblyRoutes);
app.use("/operator", editCuttingLotRoutes);
app.use('/operator', departmentMgmtRoutes);
app.use('/operator', operatorEmployeeRoutes);
app.use('/', bulkUploadRoutes);
app.use('/washingin', washingIN);
app.use('/catalogupload', catalogR);
app.use('/inventory', inventoryRoutes);
app.use('/store-admin', storeAdminRoutes);
app.use('/supervisor', employeeRoutes);
app.use('/', salaryRoutes);

app.use('/', hrRoutes);
// Home Route
app.get('/', (req, res) => {
    res.redirect('/login');
});

const challanDashboardRoutes = require('./routes/challanDashboardRoutes');
app.use('/challandashboard', challanDashboardRoutes);

app.get('/test', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="UTF-8">
            <title>Test Page</title>
            <!-- Google tag (gtag.js) -->
            <script async src="https://www.googletagmanager.com/gtag/js?id=G-W7PQ6S37K5"></script>
            <script>
              window.dataLayer = window.dataLayer || [];
              function gtag(){dataLayer.push(arguments);}
              gtag('js', new Date());
              gtag('config', 'G-W7PQ6S37K5');
            </script>
        </head>
        <body>
            <h1>Test Completed</h1>
        </body>
        </html>
    `);
});

// 404 Handler
app.use((req, res) => {
    res.status(404).send('404 Not Found');
});

// Start Server (ALB terminates SSL; your app listens over HTTP)
const PORT = global.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
