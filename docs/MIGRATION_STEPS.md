# Step-by-Step AWS to GCP Migration Guide

## Prerequisites
- Google Cloud account with billing enabled
- `gcloud` CLI installed and authenticated
- Access to your current AWS MySQL database

---

## Step 1: Create GCP Project and Enable APIs

```bash
# Create new project (or use existing)
gcloud projects create kotty-track-prod --name="Kotty Track Production"

# Set as active project
gcloud config set project kotty-track-prod

# Enable required APIs
gcloud services enable \
  run.googleapis.com \
  sqladmin.googleapis.com \
  storage.googleapis.com \
  artifactregistry.googleapis.com \
  secretmanager.googleapis.com \
  cloudbuild.googleapis.com
```

---

## Step 2: Create Cloud Storage Bucket

```bash
# Create bucket in Mumbai region (same as your current ap-south-1)
gsutil mb -l asia-south1 -c STANDARD gs://kotty-track-uploads

# Set CORS for browser uploads
gsutil cors set cors-config.json gs://kotty-track-uploads

# Make service account the owner (Cloud Run will use this)
# This happens automatically when you deploy to Cloud Run
```

---

## Step 3: Create Cloud SQL Instance

```bash
# Create MySQL 8.0 instance (db-f1-micro is cheapest)
gcloud sql instances create kotty-mysql \
  --database-version=MYSQL_8_0 \
  --tier=db-f1-micro \
  --region=asia-south1 \
  --storage-size=10GB \
  --storage-auto-increase \
  --backup-start-time=02:00

# Create database
gcloud sql databases create kotty_db --instance=kotty-mysql

# Create user
gcloud sql users create kotty_user \
  --instance=kotty-mysql \
  --password=YOUR_SECURE_PASSWORD

# Note the connection name (you'll need this)
gcloud sql instances describe kotty-mysql --format='value(connectionName)'
# Output: PROJECT_ID:asia-south1:kotty-mysql
```

---

## Step 4: Migrate Database

```bash
# On your current server, export the database
mysqldump -h YOUR_EC2_IP -u root -p \
  --single-transaction \
  --routines \
  --triggers \
  kotty_db > kotty_backup.sql

# Upload to Cloud Storage
gsutil cp kotty_backup.sql gs://kotty-track-uploads/migration/

# Import to Cloud SQL
gcloud sql import sql kotty-mysql \
  gs://kotty-track-uploads/migration/kotty_backup.sql \
  --database=kotty_db

# Verify import
gcloud sql connect kotty-mysql --user=kotty_user --database=kotty_db
# Then run: SHOW TABLES;
```

---

## Step 5: Migrate Files from S3 to Cloud Storage

```bash
# Install gsutil with S3 support
pip install gsutil

# Configure S3 credentials in ~/.boto
# [Credentials]
# aws_access_key_id = YOUR_AWS_KEY
# aws_secret_access_key = YOUR_AWS_SECRET

# Copy all files from S3 to GCS
gsutil -m rsync -r s3://my-app-uploads-kotty gs://kotty-track-uploads

# Verify
gsutil ls -la gs://kotty-track-uploads/
```

---

## Step 6: Store Secrets in Secret Manager

```bash
# Store database password
echo -n "YOUR_DB_PASSWORD" | gcloud secrets create db-password --data-file=-

# Store session secret
echo -n "YOUR_SESSION_SECRET" | gcloud secrets create session-secret --data-file=-

# Store Shopify credentials
echo -n "YOUR_SHOPIFY_TOKEN" | gcloud secrets create shopify-token --data-file=-
echo -n "YOUR_SHOPIFY_WEBHOOK_SECRET" | gcloud secrets create shopify-webhook-secret --data-file=-

# Grant Cloud Run access to secrets
gcloud secrets add-iam-policy-binding db-password \
  --member="serviceAccount:PROJECT_NUMBER-compute@developer.gserviceaccount.com" \
  --role="roles/secretmanager.secretAccessor"
```

---

## Step 7: Update Application Code

### 7.1 Replace Route Files
```bash
# Backup original files
cp routes/vendorFilesRoutes.js routes/vendorFilesRoutes.aws.js
cp routes/catalogupload.js routes/catalogupload.aws.js

# Replace with GCP versions
cp routes/vendorFilesRoutes.gcp.js routes/vendorFilesRoutes.js
cp routes/catalogupload.gcp.js routes/catalogupload.js
```

### 7.2 Replace Database Config
```bash
cp config/db.js config/db.aws.js
cp config/db.gcp.js config/db.js
```

### 7.3 Update package.json
```bash
cp package.json package.aws.json
cp package.gcp.json package.json
npm install
```

### 7.4 Add Health Check Route
Add to `app.js` after other route imports:
```javascript
// Health check for Cloud Run
app.use('/health', require('./routes/healthRoutes'));
```

---

## Step 8: Create Artifact Registry Repository

```bash
gcloud artifacts repositories create kotty-track \
  --repository-format=docker \
  --location=asia-south1 \
  --description="Kotty Track Docker images"

# Configure Docker to use Artifact Registry
gcloud auth configure-docker asia-south1-docker.pkg.dev
```

---

## Step 9: Build and Push Docker Image

```bash
# Build the image
docker build -t asia-south1-docker.pkg.dev/kotty-track-prod/kotty-track/app:v1 .

# Push to Artifact Registry
docker push asia-south1-docker.pkg.dev/kotty-track-prod/kotty-track/app:v1
```

---

## Step 10: Deploy to Cloud Run

```bash
gcloud run deploy kotty-track \
  --image asia-south1-docker.pkg.dev/kotty-track-prod/kotty-track/app:v1 \
  --region asia-south1 \
  --platform managed \
  --allow-unauthenticated \
  --add-cloudsql-instances kotty-track-prod:asia-south1:kotty-mysql \
  --memory 512Mi \
  --cpu 1 \
  --min-instances 0 \
  --max-instances 10 \
  --set-secrets "DB_PASSWORD=db-password:latest,SESSION_SECRET=session-secret:latest" \
  --set-env-vars "\
NODE_ENV=production,\
GCP_PROJECT_ID=kotty-track-prod,\
GCS_BUCKET_NAME=kotty-track-uploads,\
DB_HOST=/cloudsql/kotty-track-prod:asia-south1:kotty-mysql,\
DB_USER=kotty_user,\
DB_NAME=kotty_db,\
SHOPIFY_STORE_DOMAIN=your-store.myshopify.com,\
APP_URL=https://kotty-track-xxxxx-xx.a.run.app"
```

---

## Step 11: Configure Custom Domain (Optional)

```bash
# Map your domain to Cloud Run
gcloud run domain-mappings create \
  --service kotty-track \
  --domain erpkotty.in \
  --region asia-south1

# Update DNS records as shown in the output
```

---

## Step 12: Set Up CI/CD with Cloud Build

```bash
# Connect your GitHub repository
gcloud builds triggers create github \
  --repo-name=kotty-track \
  --repo-owner=YOUR_GITHUB_USERNAME \
  --branch-pattern="^main$" \
  --build-config=cloudbuild.yaml
```

---

## Step 13: Verify Deployment

```bash
# Get the Cloud Run URL
gcloud run services describe kotty-track --region asia-south1 --format='value(status.url)'

# Test health endpoint
curl https://YOUR_CLOUD_RUN_URL/health

# Test the application
# - Login to the ERP
# - Upload a file to vendor files
# - Check database connectivity
```

---

## Step 14: DNS Migration

After verifying everything works:

1. Update your DNS records to point to Cloud Run
2. If using erpkotty.in, update the A/CNAME records

---

## Step 15: Decommission AWS (After 2 Weeks)

Only after confirming GCP is working properly:

```bash
# Stop EC2 instances
aws ec2 stop-instances --instance-ids i-xxxxx

# Delete after final verification
aws ec2 terminate-instances --instance-ids i-xxxxx

# Empty and delete S3 bucket (if no longer needed)
aws s3 rm s3://my-app-uploads-kotty --recursive
aws s3 rb s3://my-app-uploads-kotty
```

---

## Troubleshooting

### Database Connection Issues
```bash
# Check Cloud SQL instance status
gcloud sql instances describe kotty-mysql

# Test connection locally with Cloud SQL Proxy
./cloud_sql_proxy -instances=kotty-track-prod:asia-south1:kotty-mysql=tcp:3306 &
mysql -h 127.0.0.1 -u kotty_user -p kotty_db
```

### Cloud Run Logs
```bash
# View recent logs
gcloud logging read "resource.type=cloud_run_revision AND resource.labels.service_name=kotty-track" --limit 50

# Stream logs
gcloud beta run services logs tail kotty-track --region asia-south1
```

### Storage Issues
```bash
# Check bucket permissions
gsutil iam get gs://kotty-track-uploads

# Test upload
echo "test" | gsutil cp - gs://kotty-track-uploads/test.txt
gsutil cat gs://kotty-track-uploads/test.txt
gsutil rm gs://kotty-track-uploads/test.txt
```

---

## Cost Monitoring

Set up budget alerts:

```bash
gcloud billing budgets create \
  --billing-account=YOUR_BILLING_ACCOUNT_ID \
  --display-name="Kotty Track Monthly Budget" \
  --budget-amount=50USD \
  --threshold-rule=percent=50 \
  --threshold-rule=percent=90 \
  --threshold-rule=percent=100
```

