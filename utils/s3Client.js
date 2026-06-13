/**
 * AWS S3 Client for Video Operations
 * Used by Video Finder and Mail Manager features
 */

const { S3Client, ListObjectsV2Command, GetObjectCommand, DeleteObjectCommand, PutObjectCommand, HeadObjectCommand } = require('@aws-sdk/client-s3');
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

// How many date-folder listings to fetch from S3 concurrently when scanning
// the full upload history for an AWB (bounds wasted work while overlapping I/O).
const FOLDER_FETCH_CONCURRENCY = 10;

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
 * Generate a presigned PUT URL for browser uploads.
 * The browser must send the same Content-Type used here.
 */
async function generatePresignedPutUrl(key, contentType, expiresIn = 900) {
  const command = new PutObjectCommand({
    Bucket: S3_BUCKET,
    Key: key,
    ContentType: contentType,
  });
  return getSignedUrl(s3Client, command, { expiresIn });
}

/**
 * HEAD an object to confirm it exists and read its size after upload.
 */
async function headObject(key) {
  try {
    const out = await s3Client.send(new HeadObjectCommand({ Bucket: S3_BUCKET, Key: key }));
    return { exists: true, size: out.ContentLength, contentType: out.ContentType };
  } catch (err) {
    if (err?.$metadata?.httpStatusCode === 404 || err.name === 'NotFound') {
      return { exists: false };
    }
    throw err;
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

// Matches top-level date folders like "2026-04-20/"
const DATE_FOLDER_RE = /^\d{4}-\d{2}-\d{2}\/$/;

/**
 * List actual top-level YYYY-MM-DD/ date folders in the bucket, newest-first.
 * One delimited LIST per page (cheap); cached via listingCache (10-min TTL).
 * This replaces the old fixed "last N days" window so searches cover the
 * full upload history instead of silently missing older videos.
 */
async function listDateFolders(useCache = true) {
  const cacheKey = `datefolders:${S3_PREFIX}`;

  if (useCache) {
    const cached = listingCache.get(cacheKey);
    if (cached && Date.now() - cached.time < CACHE_TTL_MS) {
      return cached.data;
    }
  }

  const folders = [];
  let continuationToken = null;

  try {
    do {
      const command = new ListObjectsV2Command({
        Bucket: S3_BUCKET,
        Prefix: S3_PREFIX || undefined,
        Delimiter: '/',
        ContinuationToken: continuationToken,
        MaxKeys: 1000,
      });

      const response = await s3Client.send(command);
      for (const cp of response.CommonPrefixes || []) {
        // Strip the configured S3_PREFIX before matching the date pattern
        const rel = S3_PREFIX ? cp.Prefix.slice(S3_PREFIX.length) : cp.Prefix;
        if (DATE_FOLDER_RE.test(rel)) {
          folders.push(rel);
        }
      }

      continuationToken = response.IsTruncated ? response.NextContinuationToken : null;
    } while (continuationToken);

    // Newest date first so early-exit on full hits stays fast for recent AWBs
    folders.sort().reverse();
    listingCache.set(cacheKey, { data: folders, time: Date.now() });
    return folders;
  } catch (err) {
    console.error('S3 listDateFolders error:', err);
    return [];
  }
}

/**
 * Search for videos by AWB numbers across date folders
 * Returns a Map of AWB -> { key, url, size, lastModified }
 */
async function findVideosByAwb(awbList, packingDatesMap = {}) {
  if (!awbList || !awbList.length) return new Map();

  const awbSet = new Set(awbList.map((awb) => awb.toUpperCase().trim()).filter(Boolean));
  // Search the full upload history (newest-first). packingDatesMap is accepted
  // for backwards-compat but no longer narrows the window — older videos were
  // being silently missed by the old fixed 14-day window.
  const folders = await listDateFolders();

  const hits = new Map();

  // Process folders in newest-first batches: list each batch's folders
  // concurrently (overlaps S3 round-trips) but scan them in date order so the
  // early-exit still short-circuits once every AWB is found. A recent AWB is
  // found in the first batch; a full miss costs ceil(folders/BATCH) round-trips
  // instead of one per folder.
  for (let i = 0; i < folders.length; i += FOLDER_FETCH_CONCURRENCY) {
    if (awbSet.size === 0) break; // All found

    const batch = folders.slice(i, i + FOLDER_FETCH_CONCURRENCY);
    const listings = await Promise.all(batch.map((folder) => listObjects(folder)));

    for (const objects of listings) {
      if (awbSet.size === 0) break;
      for (const obj of objects) {
        const keyUpper = obj.keyUpper || obj.key.toUpperCase();

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
  }

  return hits;
}

/**
 * Pre-load all video objects from date folders (for bulk searches).
 * By default loads the ENTIRE upload history; pass `searchDays` to cap to the
 * N most-recent date folders. Each object carries a precomputed `keyUpper` so
 * repeated chunk searches don't re-uppercase the same keys.
 * Returns array of all objects across all folders.
 */
async function preloadAllVideos(searchDays = null) {
  let folders = await listDateFolders(); // already newest-first
  if (searchDays && searchDays > 0) {
    folders = folders.slice(0, searchDays);
  }

  const allObjects = [];
  for (const folder of folders) {
    const objects = await listObjects(folder);
    for (const obj of objects) {
      obj.keyUpper = obj.key.toUpperCase();
      allObjects.push(obj);
    }
  }

  return allObjects;
}

/**
 * Search for videos by AWB using pre-loaded objects (optimized for bulk)
 * @param {string[]} awbList - List of AWBs to search
 * @param {Object[]} preloadedObjects - Pre-loaded S3 objects from preloadAllVideos()
 * Returns a Map of AWB -> { key, url, size, lastModified }
 */
async function findVideosByAwbFromCache(awbList, preloadedObjects) {
  if (!awbList || !awbList.length) return new Map();

  const awbSet = new Set(awbList.map((awb) => awb.toUpperCase().trim()).filter(Boolean));
  const hits = new Map();

  for (const obj of preloadedObjects) {
    if (awbSet.size === 0) break; // All found

    const keyUpper = obj.keyUpper || obj.key.toUpperCase();

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
  generatePresignedPutUrl,
  headObject,
  deleteObject,
  findVideosByAwb,
  findVideoByAwb,
  findVideosByAwbFromCache,
  preloadAllVideos,
  getVideosForDate,
  listDateFolders,
  formatFileSize,
  clearCache,
  S3_BUCKET,
  S3_PREFIX,
};
