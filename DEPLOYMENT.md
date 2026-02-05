# Kotty-Track GCP Deployment Guide

## Quick Reference

| Task | Command |
|------|---------|
| Deploy code | `gcloud builds submit --config cloudbuild.yaml --project=kotty-track-prod` |
| View logs | `gcloud logging read "resource.type=cloud_run_revision AND resource.labels.service_name=kotty-track" --project=kotty-track-prod --limit=30` |
| Add env var | `gcloud run services update kotty-track --region=asia-south1 --project=kotty-track-prod --set-env-vars="KEY=value"` |
| Check SSL | `gcloud compute ssl-certificates describe kotty-track-cert --global --project=kotty-track-prod` |
| Restart service | `gcloud run services update kotty-track --region=asia-south1 --project=kotty-track-prod --update-env-vars=RESTART=$(date +%s)` |

---

## 1. Deploying Code Changes (Frontend/Backend)

When you make changes to your code locally:

```bash
# Step 1: Test locally (optional)
npm start

# Step 2: Build and deploy to GCP
gcloud builds submit --config cloudbuild.yaml --project=kotty-track-prod
```

**Deployment takes ~3-4 minutes.**

The `cloudbuild.yaml` automatically:
- Builds Docker image
- Pushes to Artifact Registry
- Deploys to Cloud Run

---

## 2. Making Database Changes

### Option A: Via Cloud Console (GUI)

1. Go to https://console.cloud.google.com/sql/instances/kotty-mysql/overview?project=kotty-track-prod
2. Click **"Cloud SQL Studio"** on the left sidebar
3. Login with:
   - Username: `kotty_user`
   - Password: `Kotty2026Pass`
   - Database: `kotty_db`
4. Run your SQL queries

### Option B: Via Command Line

First, install Cloud SQL Proxy (one-time):
```bash
gcloud components install cloud-sql-proxy
```

Then connect:
```bash
# Terminal 1: Start proxy
cloud-sql-proxy kotty-track-prod:asia-south1:kotty-mysql --port=3307

# Terminal 2: Connect with mysql client
mysql -h 127.0.0.1 -P 3307 -u kotty_user -p kotty_db
# Enter password: Kotty2026Pass
```

---

## 3. Adding Environment Variables

```bash
# Add single variable
gcloud run services update kotty-track \
  --region=asia-south1 \
  --project=kotty-track-prod \
  --set-env-vars="NEW_VAR=value"

# Add multiple variables
gcloud run services update kotty-track \
  --region=asia-south1 \
  --project=kotty-track-prod \
  --set-env-vars="VAR1=value1,VAR2=value2"
```

---

## 4. Adding Secrets (passwords, API keys)

```bash
# Step 1: Create secret file (Windows)
powershell -Command "[System.IO.File]::WriteAllText('temp.txt', 'your_secret_value')"

# Step 2: Create secret in GCP
gcloud secrets create SECRET_NAME --data-file=temp.txt --project=kotty-track-prod

# Step 3: Clean up temp file
del temp.txt

# Step 4: Grant Cloud Run access to the secret
gcloud secrets add-iam-policy-binding SECRET_NAME \
  --member="serviceAccount:209072063916-compute@developer.gserviceaccount.com" \
  --role="roles/secretmanager.secretAccessor" \
  --project=kotty-track-prod

# Step 5: Add secret to Cloud Run as environment variable
gcloud run services update kotty-track \
  --region=asia-south1 \
  --project=kotty-track-prod \
  --set-secrets="ENV_VAR_NAME=SECRET_NAME:latest"
```

---

## 5. Viewing Logs

### Command Line
```bash
# Recent logs (last 50 entries)
gcloud logging read "resource.type=cloud_run_revision AND resource.labels.service_name=kotty-track" \
  --project=kotty-track-prod \
  --limit=50 \
  --format="table(timestamp,textPayload)"

# Filter by specific text
gcloud logging read "resource.type=cloud_run_revision AND resource.labels.service_name=kotty-track AND textPayload:error" \
  --project=kotty-track-prod \
  --limit=20
```

### Cloud Console (GUI)
https://console.cloud.google.com/logs?project=kotty-track-prod

---

## 6. Rollback to Previous Version

```bash
# List all revisions
gcloud run revisions list --service=kotty-track --region=asia-south1 --project=kotty-track-prod

# Route traffic to a specific revision
gcloud run services update-traffic kotty-track \
  --region=asia-south1 \
  --project=kotty-track-prod \
  --to-revisions=REVISION_NAME=100
```

---

## GCP Resources

| Resource | URL |
|----------|-----|
| Cloud Run | https://console.cloud.google.com/run?project=kotty-track-prod |
| Cloud SQL | https://console.cloud.google.com/sql?project=kotty-track-prod |
| Cloud Storage | https://console.cloud.google.com/storage/browser/kotty-track-uploads |
| Logs | https://console.cloud.google.com/logs?project=kotty-track-prod |
| Secret Manager | https://console.cloud.google.com/security/secret-manager?project=kotty-track-prod |
| Load Balancer | https://console.cloud.google.com/net-services/loadbalancing?project=kotty-track-prod |

---

## Infrastructure Details

| Component | Value |
|-----------|-------|
| GCP Project | `kotty-track-prod` |
| Region | `asia-south1` (Mumbai) |
| Cloud Run Service | `kotty-track` |
| Cloud SQL Instance | `kotty-mysql` |
| Database | `kotty_db` |
| DB User | `kotty_user` |
| Storage Bucket | `kotty-track-uploads` |
| Domain | `erpkotty.in` |
| Load Balancer IP | `35.227.205.19` |

---

## Troubleshooting

### Container fails to start
```bash
# Check recent logs for errors
gcloud logging read "resource.type=cloud_run_revision AND resource.labels.service_name=kotty-track" \
  --project=kotty-track-prod --limit=30
```

### Database connection issues
```bash
# Verify Cloud SQL is running
gcloud sql instances describe kotty-mysql --project=kotty-track-prod --format="value(state)"
```

### SSL certificate issues
```bash
# Check SSL status
gcloud compute ssl-certificates describe kotty-track-cert --global --project=kotty-track-prod
```
