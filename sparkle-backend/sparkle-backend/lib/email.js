'use strict';
// lib/email.js — email sending via Nodemailer, and the emails Sparkle sends.
//
// HOW SENDING WORKS
//   SMTP_HOST + SMTP_USER + SMTP_PASS set        → sent for real through that provider
//   not set, development or tests                → nothing is sent: each message is kept in
//                                                  `outbox` (and its links are printed) so
//                                                  the flow can be tried without a mail account
//   not set, production                          → nothing is sent, and the caller is told
//
// It used to fall back to Ethereal, a PUBLIC test inbox, in every environment. In
// production without SMTP that meant people's password-reset links and login codes were
// handed to a third-party test service, and nobody was ever emailed. Production now
// refuses instead, and GET /api/config reports `email_enabled` so the app can say so.

const nodemailer = require('nodemailer');
const { appReturnUrl } = require('./frontendUrls');

const isProduction = () => process.env.NODE_ENV === 'production';

function smtpConfigured() {
  return !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}
// True when a message will really reach a person — or, outside production, will at least
// be captured so the flow can be exercised.
function emailEnabled() {
  return smtpConfigured() || !isProduction();
}

// Messages "sent" while no SMTP is configured (never in production). Newest last.
const outbox = [];
const OUTBOX_LIMIT = 50;

let smtp = null;
let smtpSignature = null;
let dryRun = null;
let warnedNotConfigured = false;

function transport() {
  if (smtpConfigured()) {
    const signature = [process.env.SMTP_HOST, process.env.SMTP_PORT, process.env.SMTP_USER, process.env.SMTP_PASS].join('|');
    if (!smtp || smtpSignature !== signature) {
      smtp = nodemailer.createTransport({
        host:   process.env.SMTP_HOST,
        port:   parseInt(process.env.SMTP_PORT) || 587,
        secure: parseInt(process.env.SMTP_PORT) === 465,
        auth:   { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
      });
      smtpSignature = signature;
    }
    return { mailer: smtp, dryRun: false };
  }
  if (!isProduction()) {
    dryRun = dryRun || nodemailer.createTransport({ jsonTransport: true });
    return { mailer: dryRun, dryRun: true };
  }
  return null;
}

// ── Helpers for the templates ────────────────────────────────────────────────
// Everything a person typed is escaped before it goes into an email's HTML.
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// Subjects are one line; a line break in one is how headers get injected.
const oneLine = value => String(value ?? '').replace(/[\r\n]+/g, ' ').trim();
// Where the app lives: the first FRONTEND_URL, as https://host/app.
const appUrl = (suffix = '') => `${appReturnUrl()}${suffix}`;
const footerLine = to => `© ${new Date().getFullYear()} Sparkle · Seattle, WA${to ? ` · This email was sent to ${esc(to)}` : ''}`;

// ── Core send function ───────────────────────────────────────────────────────
async function sendEmail({ to, subject, html, text }) {
  const t = transport();
  if (!t) {
    if (!warnedNotConfigured) {
      warnedNotConfigured = true;
      console.error('[EMAIL] Not sent: SMTP_HOST, SMTP_USER and SMTP_PASS are not set. Password resets and other emails will not arrive until they are.');
    }
    return { ok: false, error: 'Email is not configured' };
  }
  try {
    const message = {
      from: process.env.EMAIL_FROM || 'Sparkle <hello@sparkle.com>',
      to,
      subject: oneLine(subject),
      html,
      text: text || html.replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/[ \t]+/g, ' ').trim(),
    };
    const info = await t.mailer.sendMail(message);
    if (t.dryRun) {
      outbox.push({ to, subject: message.subject, html, text: message.text, at: new Date().toISOString() });
      if (outbox.length > OUTBOX_LIMIT) outbox.shift();
      const links = [...new Set([...html.matchAll(/href="([^"]+)"/g)].map(m => m[1]))].filter(u => !/^mailto:/.test(u));
      console.log(`[EMAIL] (not sent: no SMTP configured) to ${to}: ${message.subject}${links.length ? '\n        ' + links.join('\n        ') : ''}`);
    }
    return { ok: true, messageId: info.messageId };
  } catch (err) {
    console.error('[EMAIL] Send failed:', err.message);
    return { ok: false, error: err.message };
  }
}

// ── Email templates ───────────────────────────────────────────────────────────

function baseTemplate(content) {
  return `
  <!DOCTYPE html>
  <html>
  <head>
    <meta charset="UTF-8">
    <style>
      body { font-family: 'DM Sans', Arial, sans-serif; background: #F8F8F6; margin: 0; padding: 0; }
      .wrap { max-width: 520px; margin: 40px auto; background: #fff; border-radius: 16px; overflow: hidden; box-shadow: 0 4px 20px rgba(0,0,0,0.08); }
      .header { background: linear-gradient(135deg, #0F6E56, #1D9E75); padding: 28px 32px; }
      .logo { font-size: 24px; color: #fff; font-weight: 500; letter-spacing: -0.5px; }
      .body { padding: 32px; color: #1a1a18; }
      .title { font-size: 20px; font-weight: 500; margin-bottom: 12px; }
      .text { font-size: 15px; color: #5F5E5A; line-height: 1.6; margin-bottom: 20px; }
      .btn { display: inline-block; padding: 13px 28px; background: #1D9E75; color: #fff !important; border-radius: 10px; text-decoration: none; font-weight: 500; font-size: 15px; margin: 8px 0 20px; }
      .code { font-size: 32px; font-weight: 600; letter-spacing: 8px; color: #0F6E56; background: #E1F5EE; border-radius: 10px; padding: 14px 24px; display: inline-block; margin: 12px 0; font-family: monospace; }
      .footer { padding: 20px 32px; background: #F8F8F6; font-size: 12px; color: #888780; border-top: 1px solid #F1EFE8; }
      .small { font-size: 12px; color: #888780; word-break: break-all; }
    </style>
  </head>
  <body><div class="wrap">${content}</div></body>
  </html>`;
}

// ── Password Reset Email ──────────────────────────────────────────────────────
// The token travels in the link's #fragment, not in a query string. A fragment is never
// sent to a server, a log or another site in a Referer header, so the secret stays in
// the person's own browser until they use it.
async function sendPasswordReset(to, firstName, resetToken) {
  const resetUrl = appUrl(`#reset=${resetToken}`);
  const html = baseTemplate(`
    <div class="header"><div class="logo">Sparkle</div></div>
    <div class="body">
      <div class="title">Reset your password</div>
      <div class="text">Hi ${esc(firstName)}, we received a request to reset your Sparkle password. Click the button below to choose a new one:</div>
      <a href="${resetUrl}" class="btn">Reset my password</a>
      <div class="text">This link expires in <strong>1 hour</strong> and works once. If you didn't ask for this, you can safely ignore this email: your password won't change.</div>
      <div class="small">Or copy this link into your browser:<br>${resetUrl}</div>
    </div>
    <div class="footer">${footerLine(to)}</div>
  `);
  return sendEmail({ to, subject: 'Reset your Sparkle password', html });
}

// ── 2FA Setup Email (sends QR code instructions) ─────────────────────────────
async function send2FASetupEmail(to, firstName, otpauthUrl) {
  const html = baseTemplate(`
    <div class="header"><div class="logo">Sparkle</div></div>
    <div class="body">
      <div class="title">Set up two-factor authentication</div>
      <div class="text">Hi ${esc(firstName)}, two-factor authentication has been enabled on your Sparkle account. Here's how to finish setting it up:</div>
      <div class="text">
        <strong>Step 1:</strong> Download Google Authenticator or Authy on your phone.<br><br>
        <strong>Step 2:</strong> Open the app and scan the QR code shown in your Sparkle account settings.<br><br>
        <strong>Step 3:</strong> Enter the 6-digit code from the app to confirm setup.
      </div>
      <div class="text small">If you didn't enable 2FA, contact Sparkle support immediately — someone may have accessed your account.</div>
    </div>
    <div class="footer">${footerLine()}</div>
  `);
  return sendEmail({ to, subject: 'Two-factor authentication enabled on your Sparkle account', html });
}

// ── 2FA Login Code Email (for users without authenticator app) ────────────────
async function send2FACode(to, firstName, code) {
  const html = baseTemplate(`
    <div class="header"><div class="logo">Sparkle</div></div>
    <div class="body">
      <div class="title">Your login code</div>
      <div class="text">Hi ${esc(firstName)}, here's your Sparkle verification code:</div>
      <div class="code">${esc(code)}</div>
      <div class="text">This code expires in <strong>10 minutes</strong>. Never share this code with anyone — Sparkle staff will never ask for it.</div>
    </div>
    <div class="footer">${footerLine()}</div>
  `);
  return sendEmail({ to, subject: `${oneLine(code)} — your Sparkle login code`, html });
}

// ── Welcome Email ─────────────────────────────────────────────────────────────
// Says only what is true today: cleaners quote on open jobs and Sparkle keeps a 10% fee
// when a client books them; clients compare quotes and pay after the clean.
async function sendWelcomeEmail(to, firstName, role) {
  const isCleaner = role === 'cleaner';
  const html = baseTemplate(`
    <div class="header"><div class="logo">Sparkle</div></div>
    <div class="body">
      <div class="title">Welcome to Sparkle, ${esc(firstName)}!</div>
      <div class="text">${isCleaner
        ? 'Your cleaner account is ready. Set your rate, list your services, and send quotes on open jobs. Sparkle keeps a 10% fee only when a client books you.'
        : 'Your account is ready. Post your first cleaning job, compare quotes from local cleaners, and pay only after the clean is done. There is no subscription.'
      }</div>
      <a href="${appUrl()}" class="btn">Go to my dashboard</a>
      ${isCleaner ? '<div class="text small">Tip: upload your license and insurance in your profile. After our team reviews them, a badge appears on your profile for clients to see.</div>' : ''}
    </div>
    <div class="footer">${footerLine()}</div>
  `);
  return sendEmail({ to, subject: `Welcome to Sparkle, ${oneLine(firstName)}!`, html });
}

// ── Support Ticket Received Email ─────────────────────────────────────────────
async function sendSupportTicketReceived(to, name, ticketId, subject) {
  const html = baseTemplate(`
    <div class="header"><div class="logo">Sparkle</div></div>
    <div class="body">
      <div class="title">We got your message</div>
      <div class="text">Hi ${esc(name)}, thanks for reaching out to Sparkle support. We've received your request${subject ? ` about "<strong>${esc(subject)}</strong>"` : ''} and a team member will get back to you as soon as they can.</div>
      <div class="small">Reference number: ${esc(ticketId)}</div>
    </div>
    <div class="footer">${footerLine(to)}</div>
  `);
  return sendEmail({ to, subject: 'We received your support request — Sparkle', html });
}

// ── Support Ticket Reply Email ────────────────────────────────────────────────
async function sendSupportReply(to, name, replyBody, ticketId) {
  const html = baseTemplate(`
    <div class="header"><div class="logo">Sparkle</div></div>
    <div class="body">
      <div class="title">Sparkle support replied to your ticket</div>
      <div class="text">Hi ${esc(name)}, here's the latest reply on your support request:</div>
      <div class="text" style="background:#F8F8F6;border-radius:10px;padding:16px;white-space:pre-wrap;">${esc(replyBody)}</div>
      <a href="${appUrl()}" class="btn">View ticket</a>
      <div class="small">Reference number: ${esc(ticketId)}</div>
    </div>
    <div class="footer">${footerLine(to)}</div>
  `);
  return sendEmail({ to, subject: 'Sparkle support replied to your ticket', html });
}

// ── Credential Approved Email ─────────────────────────────────────────────────
async function sendCredentialApproved(to, firstName, docLabel, fullyVerified) {
  const html = baseTemplate(`
    <div class="header"><div class="logo">Sparkle</div></div>
    <div class="body">
      <div class="title">Your ${esc(docLabel)} is verified ✅</div>
      <div class="text">Hi ${esc(firstName)}, we've reviewed and approved your ${esc(String(docLabel).toLowerCase())}.</div>
      <div class="text">${fullyVerified
        ? "You're now <strong>fully verified</strong> — the Licensed &amp; Insured badge is live on your profile, and you'll rank higher when clients search for cleaners."
        : 'Your badge is live on your profile. Add your other document to earn the full <strong>Licensed &amp; Insured</strong> badge and rank even higher in search.'
      }</div>
      <a href="${appUrl()}" class="btn">View my profile</a>
    </div>
    <div class="footer">${footerLine(to)}</div>
  `);
  return sendEmail({ to, subject: `Your ${oneLine(docLabel)} is verified — Sparkle`, html });
}

// ── Credential Rejected Email ─────────────────────────────────────────────────
async function sendCredentialRejected(to, firstName, docLabel, reason) {
  const html = baseTemplate(`
    <div class="header"><div class="logo">Sparkle</div></div>
    <div class="body">
      <div class="title">We couldn't verify your ${esc(docLabel)}</div>
      <div class="text">Hi ${esc(firstName)}, we reviewed the ${esc(String(docLabel).toLowerCase())} you submitted but weren't able to approve it. Here's why:</div>
      <div class="text" style="background:#F8F8F6;border-radius:10px;padding:16px;white-space:pre-wrap;">${esc(reason)}</div>
      <div class="text">You can upload a corrected document any time — there's no penalty, and your account is unaffected.</div>
      <a href="${appUrl()}" class="btn">Upload a new document</a>
    </div>
    <div class="footer">${footerLine(to)}</div>
  `);
  return sendEmail({ to, subject: `Action needed: your ${oneLine(docLabel)} — Sparkle`, html });
}

// ── Credential Expiring Soon Email ────────────────────────────────────────────
async function sendCredentialExpiringSoon(to, firstName, docLabel, expiresOn, daysLeft) {
  const label = String(docLabel).toLowerCase();
  const html = baseTemplate(`
    <div class="header"><div class="logo">Sparkle</div></div>
    <div class="body">
      <div class="title">Your ${esc(label)} expires in ${esc(daysLeft)} day${daysLeft === 1 ? '' : 's'}</div>
      <div class="text">Hi ${esc(firstName)}, your ${esc(label)} on file expires on <strong>${esc(expiresOn)}</strong>.</div>
      <div class="text">Upload a renewal before then and your badge stays live the whole time — we'll only swap it over once the new document is approved. If it lapses, the badge comes down until you re-verify.</div>
      <a href="${appUrl()}" class="btn">Upload a renewal</a>
    </div>
    <div class="footer">${footerLine(to)}</div>
  `);
  return sendEmail({ to, subject: `Your ${oneLine(label)} expires in ${oneLine(daysLeft)} days — Sparkle`, html });
}

// ── Credential Expired Email ──────────────────────────────────────────────────
async function sendCredentialExpired(to, firstName, docLabel) {
  const label = String(docLabel).toLowerCase();
  const html = baseTemplate(`
    <div class="header"><div class="logo">Sparkle</div></div>
    <div class="body">
      <div class="title">Your ${esc(label)} has expired</div>
      <div class="text">Hi ${esc(firstName)}, the ${esc(label)} we had on file has passed its expiry date, so your verification badge has been removed and you'll rank lower in client search until it's back.</div>
      <div class="text">Upload a current document and we'll review it as soon as we can.</div>
      <a href="${appUrl()}" class="btn">Upload a current document</a>
    </div>
    <div class="footer">${footerLine(to)}</div>
  `);
  return sendEmail({ to, subject: `Your ${oneLine(label)} expired — Sparkle`, html });
}

module.exports = {
  sendEmail, emailEnabled, outbox, esc, oneLine, appUrl,
  sendPasswordReset, send2FASetupEmail, send2FACode, sendWelcomeEmail,
  sendSupportTicketReceived, sendSupportReply,
  sendCredentialApproved, sendCredentialRejected, sendCredentialExpiringSoon, sendCredentialExpired,
};
