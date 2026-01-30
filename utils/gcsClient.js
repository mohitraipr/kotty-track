/**
 * Google Cloud Storage Client
 * Drop-in replacement for AWS S3 SDK used in this project
 *
 * Usage:
 *   const { storage, bucket, getSignedUrl, streamToBuffer } = require('./utils/gcsClient');
 */

const { Storage } = require('@google-cloud/storage');
const path = require('path');

// Initialize storage client
// In Cloud Run, credentials are automatic via service account
// Locally, use GOOGLE_APPLICATION_CREDENTIALS env var pointing to service account key
const storage = new Storage({
  projectId: global.env?.GCP_PROJECT_ID || process.env.GCP_PROJECT_ID
});

const BUCKET_NAME = global.env?.GCS_BUCKET_NAME || process.env.GCS_BUCKET_NAME || 'kotty-track-uploads';
const bucket = storage.bucket(BUCKET_NAME);

/**
 * List objects in bucket with prefix (equivalent to ListObjectsV2Command)
 * @param {string} prefix - Folder prefix to list
 * @param {string} delimiter - Delimiter for folder simulation (usually '/')
 * @returns {Promise<{files: Array, prefixes: Array}>}
 */
async function listObjects(prefix, delimiter = null) {
  const options = { prefix };
  if (delimiter) {
    options.delimiter = delimiter;
    options.autoPaginate = false;
  }

  if (delimiter) {
    // Get both files and "folders" (common prefixes)
    const [files, , apiResponse] = await bucket.getFiles(options);
    const prefixes = apiResponse?.prefixes || [];
    return {
      files: files.map(file => ({
        Key: file.name,
        Size: parseInt(file.metadata.size, 10),
        LastModified: new Date(file.metadata.updated),
        ContentType: file.metadata.contentType
      })),
      prefixes: prefixes.map(p => ({ Prefix: p }))
    };
  }

  const [files] = await bucket.getFiles(options);
  return {
    files: files.map(file => ({
      Key: file.name,
      Size: parseInt(file.metadata.size, 10),
      LastModified: new Date(file.metadata.updated),
      ContentType: file.metadata.contentType
    })),
    prefixes: []
  };
}

/**
 * Upload file to bucket (equivalent to PutObjectCommand)
 * @param {string} key - Object key/path
 * @param {Buffer|Stream|string} body - File content
 * @param {Object} options - Upload options
 * @returns {Promise<void>}
 */
async function putObject(key, body, options = {}) {
  const file = bucket.file(key);
  const writeOptions = {
    contentType: options.contentType || options.ContentType || 'application/octet-stream',
    metadata: {
      metadata: options.metadata || options.Metadata || {}
    }
  };

  if (Buffer.isBuffer(body) || typeof body === 'string') {
    await file.save(body, writeOptions);
  } else {
    // Stream
    return new Promise((resolve, reject) => {
      const writeStream = file.createWriteStream(writeOptions);
      body.pipe(writeStream)
        .on('error', reject)
        .on('finish', resolve);
    });
  }
}

/**
 * Get object from bucket (equivalent to GetObjectCommand)
 * @param {string} key - Object key/path
 * @returns {Promise<{Body: ReadableStream, ContentType: string, ContentLength: number}>}
 */
async function getObject(key) {
  const file = bucket.file(key);
  const [metadata] = await file.getMetadata();
  const readStream = file.createReadStream();

  return {
    Body: readStream,
    ContentType: metadata.contentType,
    ContentLength: parseInt(metadata.size, 10)
  };
}

/**
 * Delete object from bucket
 * @param {string} key - Object key/path
 * @returns {Promise<void>}
 */
async function deleteObject(key) {
  const file = bucket.file(key);
  await file.delete({ ignoreNotFound: true });
}

/**
 * Generate signed URL for upload or download
 * @param {string} key - Object key/path
 * @param {Object} options - Signed URL options
 * @returns {Promise<string>}
 */
async function getSignedUrl(key, options = {}) {
  const file = bucket.file(key);
  const action = options.action || (options.method === 'PUT' ? 'write' : 'read');
  const expires = Date.now() + (options.expiresIn || 3600) * 1000;

  const signedUrlOptions = {
    version: 'v4',
    action,
    expires,
  };

  if (options.contentType) {
    signedUrlOptions.contentType = options.contentType;
  }

  const [url] = await file.getSignedUrl(signedUrlOptions);
  return url;
}

/**
 * Check if object exists
 * @param {string} key - Object key/path
 * @returns {Promise<boolean>}
 */
async function objectExists(key) {
  const file = bucket.file(key);
  const [exists] = await file.exists();
  return exists;
}

/**
 * Convert stream to buffer (helper for xlsx parsing)
 * @param {ReadableStream} stream
 * @returns {Promise<Buffer>}
 */
async function streamToBuffer(stream) {
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/**
 * Multer storage engine for GCS (replacement for multer-s3)
 */
function multerGcsStorage(options = {}) {
  const MulterGoogleStorage = require('multer-google-storage');

  return new MulterGoogleStorage.storageEngine({
    bucket: options.bucket || BUCKET_NAME,
    projectId: global.env?.GCP_PROJECT_ID || process.env.GCP_PROJECT_ID,
    keyFilename: process.env.GOOGLE_APPLICATION_CREDENTIALS,
    filename: options.key || options.filename,
    contentType: options.contentType,
    metadata: options.metadata
  });
}

/**
 * Custom multer storage for GCS (simpler implementation)
 */
class GCSStorage {
  constructor(opts) {
    this.bucket = opts.bucket || bucket;
    this.getKey = opts.key;
    this.getContentType = opts.contentType;
    this.getMetadata = opts.metadata;
  }

  _handleFile(req, file, cb) {
    this.getKey(req, file, (err, key) => {
      if (err) return cb(err);

      const gcsFile = this.bucket.file(key);

      let contentType = 'application/octet-stream';
      if (this.getContentType) {
        if (typeof this.getContentType === 'function') {
          contentType = this.getContentType(req, file);
        } else {
          contentType = file.mimetype;
        }
      }

      const metadata = {};
      if (this.getMetadata) {
        this.getMetadata(req, file, (metaErr, meta) => {
          if (!metaErr && meta) {
            Object.assign(metadata, meta);
          }
        });
      }

      const writeStream = gcsFile.createWriteStream({
        contentType,
        metadata: { metadata }
      });

      file.stream.pipe(writeStream)
        .on('error', (uploadErr) => cb(uploadErr))
        .on('finish', () => {
          cb(null, {
            bucket: BUCKET_NAME,
            key: key,
            location: `https://storage.googleapis.com/${BUCKET_NAME}/${key}`,
            contentType,
            size: file.size
          });
        });
    });
  }

  _removeFile(req, file, cb) {
    this.bucket.file(file.key).delete({ ignoreNotFound: true })
      .then(() => cb(null))
      .catch(cb);
  }
}

/**
 * Create multer storage for GCS (drop-in replacement for multerS3)
 */
function createGCSStorage(opts) {
  return new GCSStorage({
    bucket: opts.bucket ? storage.bucket(opts.bucket) : bucket,
    key: opts.key,
    contentType: opts.contentType,
    metadata: opts.metadata
  });
}

// Export S3-like interface for easier migration
module.exports = {
  // Core client
  storage,
  bucket,
  BUCKET_NAME,

  // S3-equivalent operations
  listObjects,
  putObject,
  getObject,
  deleteObject,
  getSignedUrl,
  objectExists,

  // Helpers
  streamToBuffer,

  // Multer storage
  createGCSStorage,
  GCSStorage
};
