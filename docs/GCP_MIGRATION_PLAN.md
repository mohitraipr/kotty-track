# GCP Migration Plan - Kotty Track

## Executive Summary
Migrating from AWS (EC2 + S3 + self-managed MySQL) to GCP (Cloud Run + Cloud Storage + Cloud SQL) for cost optimization.

## Cost Comparison (Estimated Monthly)

### Current AWS Setup
| Service | Specification | Est. Cost/Month |
|---------|--------------|-----------------|
| EC2 (t3.medium) | 2 vCPU, 4GB RAM, always-on | ~$30-40 |
| ALB | Load balancer | ~$20-25 |
| EC2 for MySQL | Self-managed database | ~$30-40 |
| S3 | Storage + requests | ~$5-15 |
| Data Transfer | Egress | ~$10-20 |
| **Total** | | **~$95-140/month** |

### GCP Cloud Run Setup
| Service | Specification | Est. Cost/Month |
|---------|--------------|-----------------|
| Cloud Run | Pay-per-request, scales to zero | ~$5-20 |
| Cloud SQL (MySQL) | db-f1-micro or db-g1-small | ~$10-30 |
| Cloud Storage | Similar to S3 | ~$5-10 |
| Data Transfer | Free within GCP | ~$0-5 |
| **Total** | | **~$20-65/month** |

**Estimated Savings: 50-70%**

---

## Migration Steps

### Phase 1: GCP Project Setup
1. Create GCP Project
2. Enable required APIs:
   - Cloud Run API
   - Cloud SQL Admin API
   - Cloud Storage API
   - Artifact Registry API
   - Secret Manager API

```bash
gcloud services enable run.googleapis.com sqladmin.googleapis.com storage.googleapis.com artifactregistry.googleapis.com secretmanager.googleapis.com
```

### Phase 2: Cloud Storage Setup (Replace S3)
1. Create a Cloud Storage bucket:
```bash
gsutil mb -l asia-south1 gs://kotty-track-uploads
```

2. Set up CORS for the bucket:
```bash
gsutil cors set cors-config.json gs://kotty-track-uploads
```

### Phase 3: Cloud SQL Setup (Replace MySQL on EC2)
1. Create Cloud SQL instance:
```bash
gcloud sql instances create kotty-mysql \
  --database-version=MYSQL_8_0 \
  --tier=db-f1-micro \
  --region=asia-south1 \
  --storage-size=10GB \
  --storage-auto-increase
```

2. Create database and user:
```bash
gcloud sql databases create kotty_db --instance=kotty-mysql
gcloud sql users create kotty_user --instance=kotty-mysql --password=YOUR_PASSWORD
```

3. Export data from current MySQL and import to Cloud SQL

### Phase 4: Code Changes
See files:
- `utils/gcsClient.js` - New GCS client (replaces S3)
- `Dockerfile` - Container configuration
- `cloudbuild.yaml` - CI/CD configuration
- `.env.gcp.example` - New environment variables

### Phase 5: Deploy to Cloud Run
```bash
gcloud run deploy kotty-track \
  --image asia-south1-docker.pkg.dev/PROJECT_ID/kotty-track/app:latest \
  --region asia-south1 \
  --platform managed \
  --allow-unauthenticated \
  --add-cloudsql-instances PROJECT_ID:asia-south1:kotty-mysql \
  --set-env-vars "NODE_ENV=production" \
  --memory 512Mi \
  --cpu 1 \
  --min-instances 0 \
  --max-instances 10
```

---

## Files to Modify

### 1. Storage Client Changes
| File | Change |
|------|--------|
| `routes/vendorFilesRoutes.js` | Replace AWS SDK with GCS client |
| `routes/catalogupload.js` | Replace AWS SDK with GCS client |

### 2. New Files to Create
| File | Purpose |
|------|---------|
| `utils/gcsClient.js` | Google Cloud Storage client wrapper |
| `Dockerfile` | Container configuration |
| `cloudbuild.yaml` | Cloud Build CI/CD |
| `.env.gcp.example` | GCP environment template |
| `cors-config.json` | CORS config for Cloud Storage |

### 3. Configuration Updates
| File | Change |
|------|--------|
| `config/db.js` | Add Cloud SQL socket connection option |
| `package.json` | Add @google-cloud/storage dependency |

---

## Environment Variables Mapping

| AWS Variable | GCP Variable | Notes |
|--------------|--------------|-------|
| `AWS_REGION` | `GCP_PROJECT_ID` | Project identifier |
| `AWS_BUCKET_NAME` | `GCS_BUCKET_NAME` | Storage bucket |
| `AWS_ACCESS_KEY_ID` | Service Account | Use IAM instead |
| `AWS_SECRET_ACCESS_KEY` | Service Account | Use IAM instead |
| `DB_HOST` | `/cloudsql/PROJECT:REGION:INSTANCE` | Unix socket |

---

## Database Migration Steps

### Export from Current MySQL
```bash
mysqldump -h YOUR_EC2_IP -u root -p kotty_db > kotty_backup.sql
```

### Import to Cloud SQL
```bash
# Upload to Cloud Storage first
gsutil cp kotty_backup.sql gs://kotty-track-uploads/backups/

# Import
gcloud sql import sql kotty-mysql gs://kotty-track-uploads/backups/kotty_backup.sql --database=kotty_db
```

---

## Rollback Plan
1. Keep AWS infrastructure running for 2 weeks after migration
2. DNS can be switched back within minutes
3. Database sync can be set up if needed

---

## Timeline
1. **Day 1-2**: GCP project setup, Cloud SQL migration
2. **Day 3-4**: Code changes for Cloud Storage
3. **Day 5**: Deploy to Cloud Run, testing
4. **Day 6-7**: DNS migration, monitoring
5. **Day 8-14**: Parallel running, then decommission AWS

