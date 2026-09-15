'use strict';
// lib/jobPhotoUploads.js — before/after job photos and dispute evidence.
//
// Every photo is decoded and re-encoded by sharp before anything touches disk:
//   • EXIF is dropped, including the GPS position of the client's home.
//   • What gets stored is always a plain JPEG. A file that only pretends to be an
//     image is rejected, because sharp can't decode it.
//   • The original bytes and the original filename are never kept.
// iPhones shoot HEIC, which this sharp build can't decode, so the app converts
// photos to JPEG in the browser before uploading them.
//
// Files land in UPLOAD_DIR/job-photos, which is NOT publicly served (see server.js);
// routes/jobPhotos.js streams them to the job's cleaner, its client, and admins.

const multer = require('multer');
const sharp  = require('sharp');
const path   = require('path');
const fs     = require('fs');
const { v4: uuid } = require('uuid');

// Same env var lib/uploads.js reads, so a single Railway Volume covers every upload.
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, '..', 'uploads');
const PHOTO_DIR  = path.join(UPLOAD_DIR, 'job-photos');
fs.mkdirSync(PHOTO_DIR, { recursive: true });

const MAX_BYTES            = 10 * 1024 * 1024;
const MAX_INPUT_PIXELS     = 50_000_000;   // refuses decompression bombs; the app sends ≤ 2048px anyway
const FULL_EDGE            = 1600;
const THUMB_EDGE           = 320;
const MAX_PHOTOS_PER_STAGE = 10;

const ALLOWED_MIMETYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const PNG_SIGNATURE     = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);

class PhotoError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const upload = multer({
  // Held in memory, never written raw: only the re-encoded JPEG reaches the volume.
  storage: multer.memoryStorage(),
  limits:  { fileSize: MAX_BYTES, files: 1, fields: 5, parts: 6 },
  fileFilter: (req, file, cb) => (ALLOWED_MIMETYPES.has(file.mimetype)
    ? cb(null, true)
    : cb(new PhotoError(415, 'Please upload a JPG, PNG or WebP photo.'))),
}).single('photo');

// The mimetype is chosen by the uploader; these are the file's real first bytes.
function looksLikeImage(buf) {
  if (!buf || buf.length < 12) return false;
  if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return true;
  if (buf.subarray(0, 8).equals(PNG_SIGNATURE)) return true;
  return buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP';
}

// Parses one photo from the multipart field "photo". Mount it only AFTER the route
// has checked who is uploading and to which job, so a stranger's upload is refused
// before its bytes are even read.
function handlePhotoUpload(req, res, next) {
  upload(req, res, (err) => {
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ error: 'Photo too large. Maximum size is 10MB.' });
      }
      return res.status(400).json({ error: 'Upload one photo at a time, in a field named "photo".' });
    }
    if (err) return res.status(err.status || 400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'No photo received.' });
    if (!looksLikeImage(req.file.buffer)) {
      return res.status(415).json({ error: "That file isn't a photo we can read. Please upload a JPG, PNG or WebP." });
    }
    next();
  });
}

function reencode(buffer, edge, fit, quality) {
  return sharp(buffer, { limitInputPixels: MAX_INPUT_PIXELS })
    .rotate()                                   // bake in the EXIF orientation before EXIF is dropped
    .resize({ width: edge, height: edge, fit, withoutEnlargement: fit === 'inside' })
    .jpeg({ quality, mozjpeg: true })           // no withMetadata(): all metadata is stripped
    .toBuffer();
}

// Re-encodes and writes a full-size photo and a square thumbnail.
async function storePhoto(buffer) {
  let full, thumb;
  try {
    full  = await reencode(buffer, FULL_EDGE, 'inside', 82);
    thumb = await reencode(buffer, THUMB_EDGE, 'cover', 70);
  } catch {
    throw new PhotoError(415, "That photo couldn't be read — it may be damaged or in a format we don't support. Please try another.");
  }

  const id = uuid();
  const filename      = `${id}.jpg`;
  const thumbFilename = `${id}_thumb.jpg`;
  fs.writeFileSync(photoPath(filename), full, { flag: 'wx' });
  try {
    fs.writeFileSync(photoPath(thumbFilename), thumb, { flag: 'wx' });
  } catch (err) {
    removePhotoFiles({ filename });
    throw err;
  }
  return { filename, thumbFilename, sizeBytes: full.length };
}

// basename() keeps a stored name from ever escaping PHOTO_DIR.
function photoPath(filename) {
  return path.join(PHOTO_DIR, path.basename(String(filename)));
}

function removePhotoFiles({ filename, thumb_filename, thumbFilename }) {
  for (const f of [filename, thumb_filename || thumbFilename]) {
    if (f) { try { fs.unlinkSync(photoPath(f)); } catch {} }
  }
}

module.exports = {
  handlePhotoUpload, storePhoto, photoPath, removePhotoFiles, looksLikeImage,
  PhotoError, PHOTO_DIR, MAX_PHOTOS_PER_STAGE,
};
