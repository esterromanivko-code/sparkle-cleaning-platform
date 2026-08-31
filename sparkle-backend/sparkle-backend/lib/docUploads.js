'use strict';
// lib/docUploads.js — verification-document uploads (business license / COI).
//
// Deliberately separate from lib/uploads.js, which cannot handle these files:
//   1. Its ALLOWED_MIMETYPES are image-only, so a PDF is rejected at the filter.
//   2. handleSingleUpload() pipes every file through sharp().jpeg(), which would
//      corrupt a PDF (and silently, since compressImage swallows its own errors).
//   3. Its field name is hard-coded 'photo' and it routes to profiles|jobs|reviews.
//
// Files written here are NEVER publicly served — see routes/credentials.js for the
// authenticated, owner-or-admin download route.

const multer = require('multer');
const path   = require('path');
const fs     = require('fs');
const { v4: uuid } = require('uuid');

// Same env var lib/uploads.js reads, so a single Railway Volume covers both.
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, '..', 'uploads');
const DOC_DIR    = path.join(UPLOAD_DIR, 'documents');
if (!fs.existsSync(DOC_DIR)) fs.mkdirSync(DOC_DIR, { recursive: true });

const MAX_BYTES = 15 * 1024 * 1024;   // 15MB — scans of multi-page COIs get large

// mimetype -> permitted extensions. Both must match; attackers fake either one.
const ALLOWED = {
  'application/pdf': ['.pdf'],
  'image/jpeg':      ['.jpg', '.jpeg'],
  'image/png':       ['.png'],
  'image/heic':      ['.heic'],
  'image/heif':      ['.heif'],
  'image/webp':      ['.webp'],
};

// Serving a stored mimetype back verbatim would let an attacker who bypassed the
// filter pick the Content-Type. The download route intersects with this set.
const SERVEABLE_MIMETYPES = new Set(Object.keys(ALLOWED));

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, DOC_DIR),
  // Never reuse the original filename — it is attacker-controlled.
  filename:    (req, file, cb) => cb(null, `${uuid()}${path.extname(file.originalname).toLowerCase()}`),
});

function fileFilter(req, file, cb) {
  const ext  = path.extname(file.originalname).toLowerCase();
  const exts = ALLOWED[file.mimetype];
  if (exts && exts.includes(ext)) return cb(null, true);
  cb(new Error('Please upload a PDF or a photo (JPG, PNG, HEIC, WebP) of your document.'), false);
}

const uploadDoc = multer({
  storage,
  fileFilter,
  limits: { fileSize: MAX_BYTES, files: 1 },
}).single('document');

// ── Magic byte verification ───────────────────────────────────────────────────
// MIME type and extension are both client-supplied and can be faked. This reads
// the real leading bytes. `file-type` is not a dependency here (it isn't in
// package.json), so the signatures are checked directly — there are only six.
function verifyDocMagic(filePath, mimetype) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(12);
    fs.readSync(fd, buf, 0, 12, 0);

    switch (mimetype) {
      case 'application/pdf':
        return buf.slice(0, 5).toString('latin1') === '%PDF-';
      case 'image/jpeg':
        return buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF;
      case 'image/png':
        return buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]));
      case 'image/webp':
        return buf.slice(0, 4).toString('latin1') === 'RIFF'
            && buf.slice(8, 12).toString('latin1') === 'WEBP';
      case 'image/heic':
      case 'image/heif':
        // ISO-BMFF: bytes 4-8 are 'ftyp'.
        return buf.slice(4, 8).toString('latin1') === 'ftyp';
      default:
        return false;
    }
  } catch {
    return false;
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
  }
}

// ── Express middleware wrapper ────────────────────────────────────────────────
// Mirrors handleSingleUpload in lib/uploads.js but WITHOUT the compressImage step,
// so document bytes are stored verbatim.
function handleDocUpload(req, res, next) {
  uploadDoc(req, res, (err) => {
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ error: 'File too large. Maximum size is 15MB.' });
      }
      return res.status(400).json({ error: `Upload error: ${err.message}` });
    }
    if (err) return res.status(400).json({ error: err.message });

    if (req.file && !verifyDocMagic(req.file.path, req.file.mimetype)) {
      try { fs.unlinkSync(req.file.path); } catch {}
      return res.status(400).json({
        error: 'File content does not match its type. Please re-upload the document.',
      });
    }
    next();
  });
}

// Delete a partially-processed upload. Multer writes to disk BEFORE route-level
// validation runs, so every 4xx path after handleDocUpload must call this or
// orphaned files accumulate on the volume forever.
function discardUpload(req) {
  if (req.file && req.file.path) {
    try { fs.unlinkSync(req.file.path); } catch {}
  }
}

module.exports = { handleDocUpload, discardUpload, DOC_DIR, SERVEABLE_MIMETYPES, MAX_BYTES };
