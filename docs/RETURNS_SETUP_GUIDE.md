# Returns Management System - Complete Setup Guide

This guide covers:
1. Running the database migration
2. Configuring environment variables
3. Creating the Shopify return request page
4. Setting up domain (erpkotty.in) with HTTPS
5. Testing the system

---

## Step 1: Run the Database Migration

Connect to your MySQL database and run the migration:

```bash
# Option 1: Using mysql command line
mysql -u your_username -p your_database_name < sql/returns_management_tables.sql

# Option 2: Using MySQL Workbench or phpMyAdmin
# Copy the contents of sql/returns_management_tables.sql and run it
```

Verify tables were created:
```sql
SHOW TABLES LIKE 'return%';
```

You should see:
- returns
- return_items
- return_bank_details
- return_refunds
- return_audit_log
- return_webhook_logs
- return_settings

---

## Step 2: Configure Environment Variables

### 2.1 Edit your .env.enc file

Add these variables to your `.env.enc` file:

```
# Shopify API Configuration
SHOPIFY_STORE_DOMAIN=your-store.myshopify.com
SHOPIFY_ACCESS_TOKEN=shpat_xxxxxxxxxxxxxxxxxxxxxxxxxx
SHOPIFY_API_VERSION=2024-01
SHOPIFY_WEBHOOK_SECRET=whsec_xxxxxxxxxxxxxxxxxxxxxxxxxx

# App URL (update after domain setup)
APP_URL=https://erpkotty.in
```

### 2.2 How to get Shopify credentials

1. **Go to Shopify Admin**: https://admin.shopify.com/store/011vaj-dt
2. **Settings** > **Apps and sales channels** > **Develop apps**
3. Click **Create an app** (or use existing one)
4. Configure **Admin API scopes**:
   - `read_orders`
   - `write_orders`
   - `read_customers`
   - `write_customers`
   - `read_returns`
   - `write_returns`
5. Click **Install app**
6. Copy the **Admin API access token** (starts with `shpat_`)

### 2.3 After editing .env.enc

Restart your application:
```bash
# If using PM2
pm2 restart kotty-track

# If running directly
# Stop the current process (Ctrl+C) and restart
node app.js

# Or if using nodemon
nodemon app.js
```

---

## Step 3: Create Shopify Return Request Page

This page goes on your Shopify store (kotty.in), NOT in the ERP.

### 3.1 Go to Shopify Admin

1. Open https://admin.shopify.com/store/011vaj-dt
2. Navigate to **Online Store** > **Pages**
3. Click **Add page**

### 3.2 Configure the page

- **Title**: Return Request
- **URL handle**: return-request (this creates kotty.in/pages/return-request)

### 3.3 Add the HTML/JavaScript code

In the page editor:
1. Click the **<>** (Show HTML) button in the content editor
2. Paste the following code:

```html
<div class="return-request-page" style="max-width: 600px; margin: 40px auto; padding: 0 20px;">
  <div style="background: #fff; border-radius: 12px; box-shadow: 0 4px 24px rgba(0,0,0,0.08); padding: 40px;">
    <h1 style="font-size: 28px; font-weight: 700; margin-bottom: 8px; color: #1a1a1a;">Request a Return</h1>
    <p style="color: #666; margin-bottom: 32px;">Enter your order details to initiate a return request</p>

    <form id="returnRequestForm">
      <div style="margin-bottom: 24px;">
        <label style="display: block; font-weight: 600; margin-bottom: 8px; color: #333;">Order Number or Phone Number *</label>
        <input
          type="text"
          id="orderIdentifier"
          name="orderIdentifier"
          placeholder="e.g., #12345 or 9876543210"
          required
          style="width: 100%; padding: 12px 16px; border: 1px solid #ddd; border-radius: 8px; font-size: 16px;"
        >
        <small style="display: block; margin-top: 6px; color: #888; font-size: 13px;">Enter your Kotty order number (starting with #) or your registered phone number</small>
      </div>

      <div style="margin-bottom: 24px;">
        <label style="display: block; font-weight: 600; margin-bottom: 8px; color: #333;">Email Address *</label>
        <input
          type="email"
          id="email"
          name="email"
          placeholder="your@email.com"
          required
          style="width: 100%; padding: 12px 16px; border: 1px solid #ddd; border-radius: 8px; font-size: 16px;"
        >
      </div>

      <div style="margin-bottom: 24px;">
        <label style="display: block; font-weight: 600; margin-bottom: 8px; color: #333;">Reason for Return *</label>
        <select id="returnReason" name="returnReason" required style="width: 100%; padding: 12px 16px; border: 1px solid #ddd; border-radius: 8px; font-size: 16px;">
          <option value="">Select a reason</option>
          <option value="size_issue">Size doesn't fit</option>
          <option value="quality_issue">Quality issue / Defect</option>
          <option value="wrong_product">Received wrong product</option>
          <option value="not_as_described">Product not as described</option>
          <option value="damaged_in_transit">Damaged during delivery</option>
          <option value="changed_mind">Changed my mind</option>
          <option value="missing_items">Missing items in order</option>
          <option value="other">Other</option>
        </select>
      </div>

      <div style="margin-bottom: 24px;">
        <label style="display: block; font-weight: 600; margin-bottom: 8px; color: #333;">Additional Details</label>
        <textarea
          id="notes"
          name="notes"
          rows="4"
          placeholder="Please provide any additional details about your return request..."
          style="width: 100%; padding: 12px 16px; border: 1px solid #ddd; border-radius: 8px; font-size: 16px; resize: vertical;"
        ></textarea>
      </div>

      <div style="margin-bottom: 24px;">
        <label style="display: flex; align-items: flex-start; gap: 10px; cursor: pointer;">
          <input type="checkbox" id="termsAccept" required style="margin-top: 4px;">
          <span style="font-size: 14px;">I understand and accept the <a href="/pages/return-policy" target="_blank" style="color: #2563eb;">Return Policy</a></span>
        </label>
      </div>

      <button type="submit" id="submitBtn" style="width: 100%; padding: 16px; background: #2563eb; color: white; border: none; border-radius: 8px; font-size: 16px; font-weight: 600; cursor: pointer;">
        Submit Return Request
      </button>

      <div id="formMessage" style="display: none; margin-top: 16px; padding: 12px 16px; border-radius: 8px; text-align: center;"></div>
    </form>

    <div id="successView" style="display: none; text-align: center; padding: 20px;">
      <div style="width: 80px; height: 80px; background: #22c55e; color: white; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 40px; margin: 0 auto 24px;">✓</div>
      <h2 style="font-size: 24px; margin-bottom: 12px;">Return Request Submitted</h2>
      <p style="color: #666;">Your return request ID is: <strong id="returnIdDisplay"></strong></p>
      <p style="color: #666;">We will review your request and contact you within 24-48 hours.</p>
      <a href="/" style="display: inline-block; margin-top: 24px; padding: 12px 32px; background: #2563eb; color: white; text-decoration: none; border-radius: 8px; font-weight: 600;">Continue Shopping</a>
    </div>
  </div>
</div>

<script>
document.getElementById('returnRequestForm').addEventListener('submit', async function(e) {
  e.preventDefault();

  const submitBtn = document.getElementById('submitBtn');
  const formMessage = document.getElementById('formMessage');

  submitBtn.disabled = true;
  submitBtn.textContent = 'Submitting...';
  formMessage.style.display = 'none';

  const formData = {
    orderIdentifier: document.getElementById('orderIdentifier').value.trim(),
    email: document.getElementById('email').value.trim(),
    returnReason: document.getElementById('returnReason').value,
    notes: document.getElementById('notes').value.trim(),
    source: 'shopify_website'
  };

  try {
    // UPDATE THIS URL after domain setup
    const response = await fetch('https://erpkotty.in/returns/api/request', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(formData)
    });

    const result = await response.json();

    if (result.success) {
      document.getElementById('returnRequestForm').style.display = 'none';
      document.getElementById('successView').style.display = 'block';
      document.getElementById('returnIdDisplay').textContent = result.returnId;
    } else {
      formMessage.style.cssText = 'display: block; background: #fef2f2; color: #dc2626; border: 1px solid #fecaca;';
      formMessage.textContent = result.message || 'Something went wrong. Please try again.';
    }
  } catch (error) {
    formMessage.style.cssText = 'display: block; background: #fef2f2; color: #dc2626; border: 1px solid #fecaca;';
    formMessage.textContent = 'Unable to submit request. Please try again later.';
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = 'Submit Return Request';
  }
});
</script>
```

### 3.4 Save and publish

1. Click **Save**
2. Make sure the page is **Visible**
3. Test by visiting: https://kotty.in/pages/return-request

### 3.5 Add to navigation (optional)

1. Go to **Online Store** > **Navigation**
2. Edit your footer menu
3. Add a link to "Return Request" pointing to `/pages/return-request`

---

## Step 4: Domain and HTTPS Setup for erpkotty.in

### 4.1 Prerequisites

- Domain: erpkotty.in (you already have this)
- Server: AWS EC2 at 13.203.180.77
- Current app running on port 3000

### 4.2 DNS Configuration

Go to your domain registrar (GoDaddy, Namecheap, etc.) and add these DNS records:

| Type | Name | Value | TTL |
|------|------|-------|-----|
| A | @ | 13.203.180.77 | 300 |
| A | www | 13.203.180.77 | 300 |

Wait 5-30 minutes for DNS propagation. Verify with:
```bash
nslookup erpkotty.in
# or
ping erpkotty.in
```

### 4.3 Install Nginx on your server

SSH into your EC2 instance:
```bash
ssh -i your-key.pem ubuntu@13.203.180.77

# Update packages
sudo apt update
sudo apt upgrade -y

# Install Nginx
sudo apt install nginx -y

# Start and enable Nginx
sudo systemctl start nginx
sudo systemctl enable nginx
```

### 4.4 Install Certbot for SSL

```bash
# Install Certbot
sudo apt install certbot python3-certbot-nginx -y
```

### 4.5 Configure Nginx

Create Nginx configuration:
```bash
sudo nano /etc/nginx/sites-available/erpkotty
```

Paste this configuration:
```nginx
server {
    listen 80;
    server_name erpkotty.in www.erpkotty.in;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
        proxy_read_timeout 90;
    }
}
```

Enable the site:
```bash
# Create symbolic link
sudo ln -s /etc/nginx/sites-available/erpkotty /etc/nginx/sites-enabled/

# Remove default site (optional)
sudo rm /etc/nginx/sites-enabled/default

# Test configuration
sudo nginx -t

# Reload Nginx
sudo systemctl reload nginx
```

### 4.6 Get SSL Certificate

```bash
sudo certbot --nginx -d erpkotty.in -d www.erpkotty.in
```

Follow the prompts:
1. Enter your email
2. Agree to terms
3. Choose whether to redirect HTTP to HTTPS (recommended: Yes)

Certbot will automatically update your Nginx config for HTTPS.

### 4.7 Verify SSL auto-renewal

```bash
# Test renewal
sudo certbot renew --dry-run
```

### 4.8 Open firewall ports

Make sure your EC2 security group allows:
- Port 80 (HTTP)
- Port 443 (HTTPS)

In AWS Console:
1. Go to EC2 > Security Groups
2. Find your instance's security group
3. Edit inbound rules
4. Add rules for ports 80 and 443 from 0.0.0.0/0

### 4.9 Update your app.js

Uncomment the HTTPS redirect in app.js (lines 24-30):
```javascript
// Middleware to redirect HTTP requests to HTTPS
app.use((req, res, next) => {
    if (!req.secure) {
        return res.redirect('https://' + req.headers.host + req.url);
    }
    next();
});
```

### 4.10 Update APP_URL in .env.enc

```
APP_URL=https://erpkotty.in
```

### 4.11 Restart everything

```bash
# Restart your Node.js app
pm2 restart kotty-track

# Restart Nginx
sudo systemctl restart nginx
```

---

## Step 5: Update Shopify Page URL

After domain setup, update the fetch URL in your Shopify return request page:

Change from:
```javascript
const response = await fetch('http://13.203.180.77:3000/returns/api/request', {
```

To:
```javascript
const response = await fetch('https://erpkotty.in/returns/api/request', {
```

---

## Step 6: Configure CORS (if needed)

If you get CORS errors when the Shopify page tries to call your ERP, add this to app.js:

```javascript
// Add near the top after other requires
const cors = require('cors');

// Add before route definitions
app.use(cors({
  origin: ['https://kotty.in', 'https://www.kotty.in'],
  methods: ['GET', 'POST'],
  credentials: true
}));
```

Install cors package:
```bash
npm install cors
```

---

## Step 7: Test the Complete System

1. **Test Returns Dashboard**
   - Visit: https://erpkotty.in/returns/dashboard
   - Login as mohitOperator
   - Should see empty dashboard with stats

2. **Test Customer Return Request**
   - Visit: https://kotty.in/pages/return-request
   - Submit a test return with a real order number
   - Check if it appears in the ERP dashboard

3. **Test Full Workflow**
   - Approve a return
   - Initiate pickup (AWB will be manual if EasyEcom not configured)
   - Mark as picked up
   - Mark as received
   - Process refund

4. **Test Bank Details Form**
   - For a COD return, click "Send Bank Link"
   - Open the generated link
   - Submit test bank details

---

## Troubleshooting

### CORS Error
Add CORS middleware as shown in Step 6.

### SSL Certificate Issues
```bash
# Check certificate status
sudo certbot certificates

# Force renewal
sudo certbot renew --force-renewal
```

### App not accessible
```bash
# Check if app is running
pm2 status

# Check Nginx logs
sudo tail -f /var/log/nginx/error.log

# Check app logs
pm2 logs kotty-track
```

### Database connection issues
Make sure your database allows connections from the new domain/IP.

---

## Quick Reference

| URL | Purpose |
|-----|---------|
| https://erpkotty.in/returns/dashboard | Operator returns dashboard |
| https://erpkotty.in/returns/cash-flow | Pending refunds view |
| https://kotty.in/pages/return-request | Customer return form |
| https://erpkotty.in/returns/bank-details/:token | Customer bank details form |
