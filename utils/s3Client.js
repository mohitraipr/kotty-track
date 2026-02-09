/**
 * AWS S3 Client for Video Operations
 * Used by Video Finder and Mail Manager features
 */

const { S3Client, ListObjectsV2Command, GetObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

// Configuration from environment
const AWS_REGION = process.env.AWS_REGION || 'ap-south-1';
const S3_BUCKET = process.env.S3_BUCKET || '';
const S3_PREFIX = process.env.S3_PREFIX || '';
const PRESIGN_TTL_SECONDS = parseInt(process.env.PRESIGN_TTL_SECONDS || '259200', 10); // 3 days

// Create S3 client (credentials from environment: AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY)
const s3Client = new S3Client({
  region: AWS_REGION,
  maxAttempts: 5,
});

// Cache for folder listings (10-minute TTL)
const listingCache = new Map();
const CACHE_TTL_MS = 10 * 60 * 1000;

/**
 * List objects under a prefix (with caching)
 */
async function listObjects(prefix, useCache = true) {
  const fullPrefix = S3_PREFIX ? `${S3_PREFIX}${prefix}` : prefix;
  const cacheKey = `list:${fullPrefix}`;

  if (useCache) {
    const cached = listingCache.get(cacheKey);
    if (cached && Date.now() - cached.time < CACHE_TTL_MS) {
      return cached.data;
    }
  }

  const objects = [];
  let continuationToken = null;

  try {
    do {
      const command = new ListObjectsV2Command({
        Bucket: S3_BUCKET,
        Prefix: fullPrefix,
        ContinuationToken: continuationToken,
        MaxKeys: 1000,
      });

      const response = await s3Client.send(command);
      if (response.Contents) {
        objects.push(...response.Contents.map((obj) => ({
          key: obj.Key,
          size: obj.Size,
          lastModified: obj.LastModified,
        })));
      }

      continuationToken = response.IsTruncated ? response.NextContinuationToken : null;
    } while (continuationToken);

    listingCache.set(cacheKey, { data: objects, time: Date.now() });
    return objects;
  } catch (err) {
    console.error('S3 listObjects error:', err);
    return [];
  }
}

/**
 * Generate a presigned URL for downloading an object
 */
async function generatePresignedUrl(key, expiresIn = PRESIGN_TTL_SECONDS) {
  try {
    const command = new GetObjectCommand({
      Bucket: S3_BUCKET,
      Key: key,
    });
    return await getSignedUrl(s3Client, command, { expiresIn });
  } catch (err) {
    console.error('S3 presign error:', err);
    return null;
  }
}

/**
 * Delete an object from S3
 */
async function deleteObject(key) {
  try {
    const command = new DeleteObjectCommand({
      Bucket: S3_BUCKET,
      Key: key,
    });
    await s3Client.send(command);
    return true;
  } catch (err) {
    console.error('S3 delete error:', err);
    return false;
  }
}

/**
 * Generate candidate date folders to search (today + last N days + packing date window)
 */
function getCandidateFolders(packingDates = [], searchDays = 14, packingBefore = 3, packingAfter = 5) {
  const candidateDates = new Set();
  const today = new Date();

  // Add last N days
  for (let i = 0; i < searchDays; i++) {
    const d = new Date(today.getTime() - i * 24 * 60 * 60 * 1000);
    candidateDates.add(formatDateFolder(d));
  }

  // Add packing date windows
  for (const packDate of packingDates) {
    if (packDate instanceof Date && !isNaN(packDate)) {
      for (let delta = -packingBefore; delta <= packingAfter; delta++) {
        const d = new Date(packDate.getTime() + delta * 24 * 60 * 60 * 1000);
        candidateDates.add(formatDateFolder(d));
      }
    }
  }

  return Array.from(candidateDates).sort().reverse();
}

function formatDateFolder(date) {
  return date.toISOString().slice(0, 10) + '/';
}

/**
 * Search for videos by AWB numbers across date folders
 * Returns a Map of AWB -> { key, url, size, lastModified }
 */
async function findVideosByAwb(awbList, packingDatesMap = {}) {
  if (!awbList || !awbList.length) return new Map();

  const awbSet = new Set(awbList.map((awb) => awb.toUpperCase().trim()).filter(Boolean));
  const packingDates = Object.values(packingDatesMap).filter((d) => d instanceof Date);
  const folders = getCandidateFolders(packingDates);

  const hits = new Map();

  // Search each folder
  for (const folder of folders) {
    if (awbSet.size === 0) break; // All found

    const objects = await listObjects(folder);
    for (const obj of objects) {
      const keyUpper = obj.key.toUpperCase();

      for (const awb of awbSet) {
        if (keyUpper.includes(awb)) {
          const url = await generatePresignedUrl(obj.key);
          hits.set(awb, {
            key: obj.key,
            url,
            size: obj.size,
            lastModified: obj.lastModified,
          });
          awbSet.delete(awb);
          break;
        }
      }
    }
  }

  return hits;
}

/**
 * Search for a single AWB
 */
async function findVideoByAwb(awb, packingDate = null) {
  const packingDatesMap = packingDate ? { [awb]: packingDate } : {};
  const hits = await findVideosByAwb([awb], packingDatesMap);
  return hits.get(awb.toUpperCase()) || null;
}

/**
 * Get all videos for a specific date folder
 */
async function getVideosForDate(dateStr) {
  const folder = dateStr.endsWith('/') ? dateStr : `${dateStr}/`;
  const objects = await listObjects(folder);

  const results = [];
  for (const obj of objects) {
    const url = await generatePresignedUrl(obj.key);
    results.push({
      key: obj.key,
      filename: obj.key.split('/').pop(),
      url,
      size: obj.size,
      sizeFormatted: formatFileSize(obj.size),
      lastModified: obj.lastModified,
    });
  }

  return results;
}

function formatFileSize(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (bytes >= 1024 && i < units.length - 1) {
    bytes /= 1024;
    i++;
  }
  return `${bytes.toFixed(1)} ${units[i]}`;
}

/**
 * Clear the listing cache
 */
function clearCache() {
  listingCache.clear();
}

module.exports = {
  listObjects,
  generatePresignedUrl,
  deleteObject,
  findVideosByAwb,
  findVideoByAwb,
  getVideosForDate,
  getCandidateFolders,
  formatFileSize,
  clearCache,
  S3_BUCKET,
  S3_PREFIX,
};
