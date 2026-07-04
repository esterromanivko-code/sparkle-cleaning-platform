'use strict';
// lib/email.js — Email sending via Nodemailer
// Supports Gmail, SendGrid, Mailgun, or any SMTP provider

const nodemailer = require('nodemailer');

// Create transporter — uses env vars set in .env
function createTransporter() {
  // If no SMTP config, use Ethereal (fake SMTP for testing — shows emails at ethereal.email)
  if (!process.env.SMTP_HOST || process.env.SMTP_HOST === 'smtp.gmail.com' && !process.env.SMTP_PASS) {
    return null; // will use test account
  }
  return nodemailer.createTransport({
    host:   process.env.SMTP_HOST,
    port:   parseInt(process.env.SMTP_PORT) || 587,
    secure: parseInt(process.env.SMTP_PORT) === 465,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
}

let transporter = createTransporter();

// Get or create a test transporter (for development)
async function getTransporter() {
  if (transporter) return transporter;
  // Create throwaway Ethereal test account
  const testAccount = await nodemailer.createTestAccount();
  transporter = nodemailer.createTransport({
    host: 'smtp.ethereal.email',
    port: 587,
    auth: { user: testAccount.user, pass: testAccount.pass },
  });
  console.log('[EMAIL] Using test SMTP — view emails at https://ethereal.email');
  console.log('[EMAIL] Test user:', testAccount.user);
  return transporter;
}

// ── Core send function ───────────────────────────────────────────────────────
async function sendEmail({ to, subject, html, text }) {
  try {
    const t = await getTransporter();
    const info = await t.sendMail({
      from:    process.env.EMAIL_FROM || 'Sparkle <hello@sparkle.com>',
      to,
      subject,
      html,
      text: text || html.replace(/<[^>]+>/g, ''), // plain text fallback
    });
    // In dev, log the Ethereal preview URL
    if (nodemailer.getTestMessageUrl(info)) {
      console.log('[EMAIL] Preview URL:', nodemailer.getTestMessageUrl(info));
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
      .small { font-size: 12px; color: #888780; }
    </style>
  </head>
  <body><div class="wrap">${content}</div></body>
  </html>`;
}

// ── Password Reset Email ──────────────────────────────────────────────────────
async function sendPasswordReset(to, firstName, resetToken) {
  const resetUrl = `${process.env.FRONTEND_URL || 'http://localhost:3000'}/reset-password?token=${resetToken}`;
  const html = baseTemplate(`
    <div class="header"><div class="logo">Sparkle</div></div>
    <div class="body">
      <div class="title">Reset your password</div>
      <div class="text">Hi ${firstName}, we received a request to reset your Sparkle password. Click the button below to set a new password:</div>
      <a href="${resetUrl}" class="btn">Reset my password</a>
      <div class="text">This link expires in <strong>1 hour</strong>. If you didn't request this, you can safely ignore this email — your password won't change.</div>
      <div class="small">Or copy this link: ${resetUrl}</div>
    </div>
    <div class="footer">© 2025 Sparkle Inc. · Seattle, WA · This email was sent to ${to}</div>
  `);
  return sendEmail({ to, subject: 'Reset your Sparkle password', html });
}

// ── 2FA Setup Email (sends QR code instructions) ─────────────────────────────
async function send2FASetupEmail(to, firstName, otpauthUrl) {
  const html = baseTemplate(`
    <div class="header"><div class="logo">Sparkle</div></div>
    <div class="body">
      <div class="title">Set up two-factor authentication</div>
      <div class="text">Hi ${firstName}, two-factor authentication has been enabled on your Sparkle account. Here's how to finish setting it up:</div>
      <div class="text">
        <strong>Step 1:</strong> Download Google Authenticator or Authy on your phone.<br><br>
        <strong>Step 2:</strong> Open the app and scan the QR code shown in your Sparkle account settings.<br><br>
        <strong>Step 3:</strong> Enter the 6-digit code from the app to confirm setup.
      </div>
      <div class="text small">If you didn't enable 2FA, contact Sparkle support immediately — someone may have accessed your account.</div>
    </div>
    <div class="footer">© 2025 Sparkle Inc. · Seattle, WA</div>
  `);
  return sendEmail({ to, subject: 'Two-factor authentication enabled on your Sparkle account', html });
}

// ── 2FA Login Code Email (for users without authenticator app) ────────────────
async function send2FACode(to, firstName, code) {
  const html = baseTemplate(`
    <div class="header"><div class="logo">Sparkle</div></div>
    <div class="body">
      <div class="title">Your login code</div>
      <div class="text">Hi ${firstName}, here's your Sparkle verification code:</div>
      <div class="code">${code}</div>
      <div class="text">This code expires in <strong>10 minutes</strong>. Never share this code with anyone — Sparkle staff will never ask for it.</div>
    </div>
    <div class="footer">© 2025 Sparkle Inc. · Seattle, WA</div>
  `);
  return sendEmail({ to, subject: `${code} — your Sparkle login code`, html });
}

// ── Welcome Email ─────────────────────────────────────────────────────────────
async function sendWelcomeEmail(to, firstName, role) {
  const isCleaner = role === 'cleaner';
  const html = baseTemplate(`
    <div class="header"><div class="logo">Sparkle</div></div>
    <div class="body">
      <div class="title">Welcome to Sparkle, ${firstName}! 🎉</div>
      <div class="text">${isCleaner
        ? 'Your cleaner account is ready. Set your rate, list your services, and start accepting jobs — you keep 100% of your hourly wage.'
        : 'Your account is ready. Post your first cleaning job and get matched with a verified cleaner near you — no subscription required.'
      }</div>
      <a href="${process.env.FRONTEND_URL || 'http://localhost:3000'}" class="btn">Go to my dashboard</a>
      ${isCleaner ? '<div class="text small">Don\'t forget to complete your background check ($40) to earn your Verified badge and get 3× more bookings.</div>' : ''}
    </div>
    <div class="footer">© 2025 Sparkle Inc. · Seattle, WA</div>
  `);
  return sendEmail({ to, subject: `Welcome to Sparkle, ${firstName}!`, html });
}

// ── Support Ticket Received Email ─────────────────────────────────────────────
async function sendSupportTicketReceived(to, name, ticketId, subject) {
  const html = baseTemplate(`
    <div class="header"><div class="logo">Sparkle</div></div>
    <div class="body">
      <div class="title">We got your message</div>
      <div class="text">Hi ${name}, thanks for reaching out to Sparkle support. We've received your request${subject ? ` about "<strong>${subject}</strong>"` : ''} and a team member will get back to you soon — usually within one business day.</div>
      <div class="small">Reference number: ${ticketId}</div>
    </div>
    <div class="footer">© 2025 Sparkle Inc. · Seattle, WA · This email was sent to ${to}</div>
  `);
  return sendEmail({ to, subject: 'We received your support request — Sparkle', html });
}

// ── Support Ticket Reply Email ────────────────────────────────────────────────
async function sendSupportReply(to, name, replyBody, ticketId) {
  const html = baseTemplate(`
    <div class="header"><div class="logo">Sparkle</div></div>
    <div class="body">
      <div class="title">Sparkle support replied to your ticket</div>
      <div class="text">Hi ${name}, here's the latest reply on your support request:</div>
      <div class="text" style="background:#F8F8F6;border-radius:10px;padding:16px;white-space:pre-wrap;">${replyBody}</div>
      <a href="${process.env.FRONTEND_URL || 'http://localhost:3000'}/app" class="btn">View ticket</a>
      <div class="small">Reference number: ${ticketId}</div>
    </div>
    <div class="footer">© 2025 Sparkle Inc. · Seattle, WA · This email was sent to ${to}</div>
  `);
  return sendEmail({ to, subject: 'Sparkle support replied to your ticket', html });
}

module.exports = { sendEmail, sendPasswordReset, send2FASetupEmail, send2FACode, sendWelcomeEmail, sendSupportTicketReceived, sendSupportReply };
