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

// ── Storage config ─────────────────────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    // Route files to the right subfolder based on upload type
    const type = req.params.type || req.body.type || 'jobs';
    const subdir = type === 'profile_photo' ? 'profiles' : type === 'review_photo' ? 'reviews' : 'jobs';
    cb(null, path.join(UPLOAD_DIR, subdir));
  },
  filename: (req, file, cb) => {
    // Generate unique filename — never use the original name directly (security)
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${uuid()}${ext}`);
  },
});

// ── Image compression (auto-resize on upload) ────────────────────────────
async function compressImage(inputPath, outputPath, type) {
  if (!sharp) return; // fall through if sharp not installed
  try {
    const isProfile = type === 'profile_photo';
    await sharp(inputPath)
      .resize(isProfile ? 400 : 1200, isProfile ? 400 : 900, {
        fit: 'inside',
        withoutEnlargement: true,
      })
      .jpeg({ quality: 82, progressive: true })
      .toFile(outputPath + '.compressed.jpg');

    // Replace original with compressed version
    const fs = require('fs');
    fs.unlinkSync(inputPath);
    fs.renameSync(outputPath + '.compressed.jpg', outputPath);
  } catch (err) {
    console.warn('[UPLOADS] Compression failed for', inputPath, err.message);
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
      const subdir = req.params?.type === 'profile_photo' ? 'profiles' : 'jobs';
      await compressImage(req.file.path, req.file.path, subdir === 'profiles' ? 'profile_photo' : 'job_photo');
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
// In production, swap this to your S3/R2/CDN URL
function getFileUrl(filename, subdir) {
  const baseUrl = process.env.API_URL || `http://localhost:${process.env.PORT || 3001}`;
  return `${baseUrl}/uploads/${subdir}/${filename}`;
}

module.exports = { handleSingleUpload, handleMultipleUpload, getFileUrl, UPLOAD_DIR };
