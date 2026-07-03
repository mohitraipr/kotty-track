# Dockerfile for Cloud Run deployment
# Optimized for fast cold starts and small image size

# Build stage
FROM node:20-alpine AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies (including dev for build if needed)
RUN npm ci --only=production && npm cache clean --force

# Frontend island builder stage (React + Vite + Tailwind + shadcn)
# Builds the Tasks UI bundle into /app/public/tasks (vite.config.ts) and the QC
# dashboard bundle into /app/public/qc (vite.qc.config.ts). Kept separate so the
# runtime image never ships front-end tooling.
FROM node:20-alpine AS frontend-builder
WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build && npm run build:qc

# Production stage
FROM node:20-alpine

# Install dumb-init for proper signal handling
RUN apk add --no-cache dumb-init

# Create non-root user
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001

WORKDIR /app

# Copy node_modules from builder
COPY --from=builder /app/node_modules ./node_modules

# Copy application files
COPY --chown=nodejs:nodejs . .

# Bring in the built islands AFTER `COPY . .` so they aren't shadowed by the
# (gitignored / dockerignored) local public/*. This is the only source of the
# built bundles in the image.
COPY --from=frontend-builder --chown=nodejs:nodejs /app/public/tasks ./public/tasks
COPY --from=frontend-builder --chown=nodejs:nodejs /app/public/qc ./public/qc

# Remove development files (drop frontend/ source + node_modules from the runtime image)
RUN rm -rf .git .gitignore .env* docs/*.md tests frontend

# Create logs and uploads directories
RUN mkdir -p logs uploads && chown -R nodejs:nodejs logs uploads

# Switch to non-root user
USER nodejs

# Cloud Run sets PORT automatically
ENV PORT=8080
ENV NODE_ENV=production

# Expose port
EXPOSE 8080

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:8080/health', (r) => process.exit(r.statusCode === 200 ? 0 : 1))"

# Use dumb-init to handle signals properly
ENTRYPOINT ["dumb-init", "--"]

# Start the application
CMD ["node", "app.js"]
