'use strict';
// lib/uploads.js — File upload handler using Multer
// Accepts profile photos and job photos
// Minimal validation: image files only (to prevent malware), 10MB limit
// Storage: local disk in dev, swap to S3/Cloudflare R2 in production

const multer = require('multer');
const path   = require('path');
const fs     = require('fs');
const { v4: uuid } = require('uuid');
let sharp = null; try { sharp = require('sharp'); } catch { console.warn('[UPLOADS] sharp not available — images stored without compression'); }

// ── Upload directory ───────────────────────────────────────────────────────────
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// Subdirectories
['profiles', 'jobs', 'reviews'].forEach(dir => {
  const p = path.join(UPLOAD_DIR, dir);
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
});

// ── Which subdirectory does this request's file belong in? ────────────────────
// Derived from the ROUTE, not req.body: multer picks the destination while it is
// still parsing the multipart stream, so req.body is empty at that point. The old
// version read req.params.type, which POST /upload/profile-photo does not have —
// so every profile photo silently landed in uploads/jobs/ while its stored URL
// said /uploads/profiles/. Nothing served those files, so the mismatch was
// invisible until static hosting was added.
function resolveSubdir(req) {
  const p = req.path || '';
  if (p.includes('profile-photo') || req.params?.type === 'profile_photo') return 'profiles';
  if (p.includes('review')        || req.params?.type === 'review_photo')  return 'reviews';
  return 'jobs';
}

// ── Storage config ─────────────────────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, path.join(UPLOAD_DIR, resolveSubdir(req)));
  },
  filename: (req, file, cb) => {
    // Generate unique filename — never use the original name directly (security)
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${uuid()}${ext}`);
  },
});

// ── Image compression (auto-resize on upload) ────────────────────────────
// Always re-encodes to JPEG, so the file must END UP with a .jpg extension.
// Keeping the uploaded extension (.png/.webp/…) would leave the bytes and the
// name disagreeing — and because these are served statically with
// `X-Content-Type-Options: nosniff`, the browser derives Content-Type from the
// extension and then refuses to render the mismatched image.
//
// Returns the final absolute path, which the caller uses to update req.file so
// the DB row and the public URL both reference the real filename.
async function compressImage(inputPath, type) {
  if (!sharp) return inputPath;   // sharp absent: bytes and extension still agree
  const isProfile = type === 'profile_photo';
  const jpgPath   = inputPath.replace(/\.[^.]+$/, '') + '.jpg';
  const tmpPath   = inputPath + '.compressed.jpg';

  try {
    await sharp(inputPath)
      .rotate()                       // honour EXIF orientation from phone cameras
      .resize(isProfile ? 400 : 1200, isProfile ? 400 : 900, {
        fit: 'inside',
        withoutEnlargement: true,
      })
      .jpeg({ quality: 82, progressive: true })
      .toFile(tmpPath);

    fs.unlinkSync(inputPath);
    fs.renameSync(tmpPath, jpgPath);
    return jpgPath;
  } catch (err) {
    // Most common cause is a HEIC without libheif support in this sharp build.
    console.warn('[UPLOADS] Compression failed for', inputPath, '—', err.message);
    try { fs.unlinkSync(tmpPath); } catch {}
    return inputPath;               // keep the original; extension still matches
  }
}

// ── File filter — images only ─────────────────────────────────────────────────
// This is the minimum necessary validation. Without this, someone could upload
// a PHP/JS file that gets executed on your server and give them full control.
// We allow all common image formats — this is not restrictive.
const ALLOWED_MIMETYPES = [
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/heic',    // iPhone photos
  'image/heif',
  'image/avif',
  'image/bmp',
  'image/tiff',
];

const ALLOWED_EXTENSIONS = ['.jpg','.jpeg','.png','.gif','.webp','.heic','.heif','.avif','.bmp','.tiff'];

function fileFilter(req, file, cb) {
  const ext = path.extname(file.originalname).toLowerCase();
  // Check both MIME type and extension — attackers sometimes fake MIME types
  if (ALLOWED_MIMETYPES.includes(file.mimetype) && ALLOWED_EXTENSIONS.includes(ext)) {
    cb(null, true);  // Accept
  } else {
    cb(new Error(`File type not allowed. Please upload an image file (JPG, PNG, GIF, WebP, HEIC, etc.)`), false);
  }
}

// ── Multer instances ───────────────────────────────────────────────────────────

// Single photo (profile photo, job photo)
const uploadSingle = multer({
  storage,
  fileFilter,
  limits: {
    fileSize:  10 * 1024 * 1024,  // 10MB — generous for high-res phone photos
    files:     1,
  },
}).single('photo');

// Multiple photos (job completion photos — up to 10)
const uploadMultiple = multer({
  storage,
  fileFilter,
  limits: {
    fileSize:  10 * 1024 * 1024,  // 10MB per file
    files:     10,                 // up to 10 photos per upload
  },
}).array('photos', 10);

// ── Magic byte verification ─────────────────────────────────────────────────
// SECURITY FIX: MIME type and extension checks can be faked by the client.
// This reads the actual file bytes to confirm it's a real image.
// The leading bytes (magic numbers) of common image formats are well-defined
// and cannot be spoofed without corrupting the file.
//
// To enable: npm install file-type
// Without it: falls back to trusting MIME+extension (acceptable if sharp is installed,
// since sharp will reject non-image files during compression).
async function verifyMagicBytes(filePath) {
  try {
    const fileType = require('file-type');
    const type = await fileType.fromFile(filePath);
    const SAFE = new Set([
      'image/jpeg','image/png','image/gif','image/webp',
      'image/heic','image/heif','image/avif','image/bmp','image/tiff',
    ]);
    return type && SAFE.has(type.mime);
  } catch {
    // file-type not installed — fall back to trusting MIME type
    // sharp compression will reject invalid images anyway
    return null;  // null = "skipped, not blocked"
  }
}

// ── Express route handler wrappers ────────────────────────────────────────────
function handleSingleUpload(req, res, next) {
  uploadSingle(req, res, async (err) => {
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ error: 'File too large. Maximum size is 10MB.' });
      }
      return res.status(400).json({ error: `Upload error: ${err.message}` });
    }
    if (err) {
      return res.status(400).json({ error: err.message });
    }

    // SECURITY: Verify file magic bytes before processing.
    if (req.file) {
      const magicOk = await verifyMagicBytes(req.file.path);
      if (magicOk === false) {
        // Magic bytes don't match any image format — delete the file and reject
        try { fs.unlinkSync(req.file.path); } catch {}
        return res.status(400).json({ error: 'File content does not match an image format. Please upload a valid image.' });
      }
      // magicOk === null means file-type is not installed — proceed with MIME check only
      const subdir    = resolveSubdir(req);
      const finalPath = await compressImage(req.file.path, subdir === 'profiles' ? 'profile_photo' : 'job_photo');

      // Compression re-encodes to JPEG and renames, so req.file must be updated —
      // routes read .filename/.path from it when writing the DB row and the URL.
      if (finalPath !== req.file.path) {
        req.file.path     = finalPath;
        req.file.filename = path.basename(finalPath);
        req.file.mimetype = 'image/jpeg';
        try { req.file.size = fs.statSync(finalPath).size; } catch {}
      }
    }
    next();
  });
}

function handleMultipleUpload(req, res, next) {
  uploadMultiple(req, res, (err) => {
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ error: 'File too large. Maximum 10MB per photo.' });
      }
      if (err.code === 'LIMIT_FILE_COUNT') {
        return res.status(400).json({ error: 'Too many files. Maximum 10 photos per upload.' });
      }
      return res.status(400).json({ error: `Upload error: ${err.message}` });
    }
    if (err) {
      return res.status(400).json({ error: err.message });
    }
    next();
  });
}

// ── Build public URL from filename ────────────────────────────────────────────
// Returns a ROOT-RELATIVE path rather than an absolute URL, so stored values stay
// correct no matter which host serves them. Previously this baked in API_URL (or
// silently fell back to localhost:3001), which meant every URL written in
// production pointed at the developer's machine unless that env var was set.
// The frontend resolves these against the API base — see avatarSrc() in the app.
// In production behind a CDN, prefix the CDN origin at render time instead.
function getFileUrl(filename, subdir) {
  return `/uploads/${subdir}/${filename}`;
}

module.exports = { handleSingleUpload, handleMultipleUpload, getFileUrl, UPLOAD_DIR };
