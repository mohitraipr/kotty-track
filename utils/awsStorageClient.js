/**
 * AWS S3 Storage Client — drop-in replacement for utils/gcsClient.js
 *
 * Same exported interface (putObject/getObject/deleteObject/getSignedUrl/
 * listObjects/objectExists + a multer storage engine) so the two call sites
 * (routes/vendorFilesRoutes.js, routes/catalogupload.js) only need their
 * `require('./gcsClient')` swapped for `require('./awsStorageClient')`.
 *
 * Deliberately a separate file from utils/s3Client.js, which is a different,
 * unrelated integration (Video Finder / VMS AWB video search against a
 * different bucket/account) — do not merge these.
 *
 * Usage:
 *   const { putObject, getObject, deleteObject, getSignedUrl, listObjects,
 *           objectExists, createGCSStorage } = require('./awsStorageClient');
 */

const {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  HeadObjectCommand,
} = require('@aws-sdk/client-s3');
const { getSignedUrl: presign } = require('@aws-sdk/s3-request-presigner');
const { Upload } = require('@aws-sdk/lib-storage');

const AWS_REGION = global.env?.AWS_REGION || process.env.AWS_REGION || 'ap-south-1';
const BUCKET_NAME = global.env?.S3_BUCKET_NAME || process.env.S3_BUCKET_NAME || 'kotty-track-uploads';

// Credentials come from the ECS task role (no static keys needed once running
// on Fargate) — falls back to the default provider chain (env vars/profile)
// for local development.
const s3Client = new S3Client({ region: AWS_REGION });

/**
 * List objects with a prefix (equivalent to gcsClient's listObjects).
 */
async function listObjects(prefix, delimiter = null) {
  const options = { Bucket: BUCKET_NAME, Prefix: prefix };
  if (delimiter) options.Delimiter = delimiter;

  const [files, prefixes] = [[], []];
  let continuationToken;
  do {
    const response = await s3Client.send(new ListObjectsV2Command({
      ...options,
      ContinuationToken: continuationToken,
    }));
    for (const obj of response.Contents || []) {
      files.push({
        Key: obj.Key,
        Size: obj.Size,
        LastModified: obj.LastModified,
        ContentType: undefined, // S3 ListObjectsV2 doesn't return content-type; HEAD if needed
      });
    }
    for (const cp of response.CommonPrefixes || []) {
      prefixes.push({ Prefix: cp.Prefix });
    }
    continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
  } while (continuationToken);

  return { files, prefixes };
}

/**
 * Upload an object (equivalent to gcsClient's putObject).
 */
async function putObject(key, body, options = {}) {
  const upload = new Upload({
    client: s3Client,
    params: {
      Bucket: BUCKET_NAME,
      Key: key,
      Body: body,
      ContentType: options.contentType || options.ContentType || 'application/octet-stream',
      Metadata: options.metadata || options.Metadata || {},
    },
  });
  await upload.done();
}

/**
 * Get an object (equivalent to gcsClient's getObject).
 */
async function getObject(key) {
  const out = await s3Client.send(new GetObjectCommand({ Bucket: BUCKET_NAME, Key: key }));
  return {
    Body: out.Body,
    ContentType: out.ContentType,
    ContentLength: out.ContentLength,
  };
}

/**
 * Delete an object.
 */
async function deleteObject(key) {
  await s3Client.send(new DeleteObjectCommand({ Bucket: BUCKET_NAME, Key: key }));
}

/**
 * Presigned URL for upload or download (equivalent to gcsClient's getSignedUrl).
 */
async function getSignedUrl(key, options = {}) {
  const expiresIn = options.expiresIn || 3600;
  if (options.method === 'PUT' || options.action === 'write') {
    const command = new PutObjectCommand({
      Bucket: BUCKET_NAME,
      Key: key,
      ContentType: options.contentType,
    });
    return presign(s3Client, command, { expiresIn });
  }
  const command = new GetObjectCommand({
    Bucket: BUCKET_NAME,
    Key: key,
    ResponseContentDisposition: options.responseDisposition,
  });
  return presign(s3Client, command, { expiresIn });
}

/**
 * Check if an object exists.
 */
async function objectExists(key) {
  try {
    await s3Client.send(new HeadObjectCommand({ Bucket: BUCKET_NAME, Key: key }));
    return true;
  } catch (err) {
    if (err?.$metadata?.httpStatusCode === 404 || err.name === 'NotFound') return false;
    throw err;
  }
}

/**
 * Stream helper (parity with gcsClient's streamToBuffer).
 */
async function streamToBuffer(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

/**
 * Multer storage engine — same contract as gcsClient's GCSStorage
 * (_handleFile/_removeFile, same returned object shape).
 */
class S3Storage {
  constructor(opts) {
    this.getKey = opts.key;
    this.getContentType = opts.contentType;
    this.getMetadata = opts.metadata;
  }

  _handleFile(req, file, cb) {
    this.getKey(req, file, async (err, key) => {
      if (err) return cb(err);

      let contentType = 'application/octet-stream';
      if (this.getContentType) {
        contentType = typeof this.getContentType === 'function'
          ? this.getContentType(req, file)
          : file.mimetype;
      }

      let metadata = {};
      if (this.getMetadata) {
        await new Promise((resolve) => {
          this.getMetadata(req, file, (metaErr, meta) => {
            if (!metaErr && meta) metadata = meta;
            resolve();
          });
        });
      }

      try {
        const upload = new Upload({
          client: s3Client,
          params: {
            Bucket: BUCKET_NAME,
            Key: key,
            Body: file.stream,
            ContentType: contentType,
            Metadata: metadata,
          },
        });
        await upload.done();
        cb(null, {
          bucket: BUCKET_NAME,
          key,
          location: `https://${BUCKET_NAME}.s3.${AWS_REGION}.amazonaws.com/${key}`,
          contentType,
          size: file.size,
        });
      } catch (uploadErr) {
        cb(uploadErr);
      }
    });
  }

  _removeFile(req, file, cb) {
    s3Client.send(new DeleteObjectCommand({ Bucket: BUCKET_NAME, Key: file.key }))
      .then(() => cb(null))
      .catch(cb);
  }
}

function createGCSStorage(opts) {
  return new S3Storage({
    key: opts.key,
    contentType: opts.contentType,
    metadata: opts.metadata,
  });
}

module.exports = {
  s3Client,
  BUCKET_NAME,
  listObjects,
  putObject,
  getObject,
  deleteObject,
  getSignedUrl,
  objectExists,
  streamToBuffer,
  createGCSStorage,
  GCSStorage: S3Storage,
};
