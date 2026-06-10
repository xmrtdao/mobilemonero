# 📧 Resend API Keys - XMRT DAO & PFP

**Date:** 2026-06-10 17:45 UTC  
**Status:** ✅ Verified & Tested

---

## Two SEPARATE Resend Accounts

### 1. Party Favor Photo (PFP)

| Field | Value |
|-------|-------|
| **Account Email** | pfpattendants@gmail.com |
| **API Key** | `re_BrGV9sSL_3b7F6XdV1NE8QufC1FNze69E` |
| **From Address** | bookings@partyfavorphoto.com |
| **Webhook Secret** | `whsec_1sdJm4hh1MbXX5wzifJLDMVsMlGM0gGc` |
| **Purpose** | PFP booking emails, lead follow-ups |

### 2. XMRT DAO

| Field | Value |
|-------|-------|
| **Account Email** | xmrtsolutions@gmail.com |
| **API Key** | `re_8ypZddMZ_AgCWwU5gn6Vj5HkoyAq5UdM4` |
| **From Address** | noreply@mobilemonero.com |
| **Purpose** | XMRT DAO notifications, fleet alerts |

---

## ⚠️ CRITICAL: Keep Accounts Separate

**DO NOT cross-reference:**
- PFP emails must use PFP Resend account
- XMRT emails must use XMRT Resend account
- Webhook secrets are account-specific

**Reason:** Separate domains, separate Stripe accounts, separate business entities

---

## API Endpoints

### Send Email (PFP)
```bash
curl -X POST https://api.resend.com/emails \
  -H "Authorization: Bearer re_BrGV9sSL_3b7F6XdV1NE8QufC1FNze69E" \
  -H "Content-Type: application/json" \
  -d '{
    "from": "Party Favor Photo <bookings@partyfavorphoto.com>",
    "to": "customer@example.com",
    "subject": "Booking Confirmation",
    "text": "Your booking is confirmed!"
  }'
```

### Send Email (XMRT)
```bash
curl -X POST https://api.resend.com/emails \
  -H "Authorization: Bearer re_8ypZddMZ_AgCWwU5gn6Vj5HkoyAq5UdM4" \
  -H "Content-Type: application/json" \
  -d '{
    "from": "XMRT DAO <noreply@mobilemonero.com>",
    "to": "agent@xmrtdao.com",
    "subject": "Fleet Update",
    "text": "Infrastructure update..."
  }'
```

### List Domains (PFP)
```bash
curl https://api.resend.com/domains \
  -H "Authorization: Bearer re_BrGV9sSL_3b7F6XdV1NE8QufC1FNze69E"
```

### List Domains (XMRT)
```bash
curl https://api.resend.com/domains \
  -H "Authorization: Bearer re_8ypZddMZ_AgCWwU5gn6Vj5HkoyAq5UdM4"
```

---

## Webhook Handling (PFP)

**Endpoint:** `/api/webhooks/resend` (or via Cloudflare Worker)

**Verify Signature:**
```javascript
const crypto = require('crypto');

function verifyWebhook(payload, signature, secret) {
  const expected = crypto
    .createHmac('sha256', secret)
    .update(payload)
    .digest('hex');
  
  return crypto.timingSafeEqual(
    Buffer.from(signature),
    Buffer.from(expected)
  );
}

// Usage
const isValid = verifyWebhook(
  req.body,
  req.headers['svix-signature'],
  'whsec_1sdJm4hh1MbXX5wzifJLDMVsMlGM0gGc'
);
```

**Webhook Events to Handle:**
- `email.sent` - Email delivered
- `email.delivered` - Reached inbox
- `email.opened` - Customer opened
- `email.clicked` - Customer clicked link
- `email.bounced` - Delivery failed
- `email.complained` - Marked as spam

---

## Email Templates

### PFP - Booking Inquiry Response

**Trigger:** New booking request from website

```html
From: Party Favor Photo <bookings@partyfavorphoto.com>
To: {{customer_email}}
Subject: Party Favor Photo Booth - {{event_date}} Event Inquiry

Hi {{customer_name}}!

Thanks for your interest in Party Favor Photo Booth for your event on {{event_date}}!

Your Selected Package:
- {{package_name}} - {{duration}} Hours
- Total: ${{total}}

To secure your date, please reply with:
1. Your event venue/address
2. Event start time
3. Any theme or color preferences

Once we have these details, we will send you a booking link to pay the deposit.

Questions? Reply to this email or call/text us!

Best,
Party Favor Photo Team
www.partyfavorphoto.com
```

### PFP - Quote Follow-Up (48hr)

**Trigger:** No response after 48 hours

```html
From: Party Favor Photo <bookings@partyfavorphoto.com>
To: {{customer_email}}
Subject: Re: Party Favor Photo Booth Quote - {{event_date}}

Hi {{customer_name}}!

Just following up on the quote we sent for your {{event_date}} event.

Quick reminder:
- {{package_details}}
- Total: ${{amount}}
- Deposit: ${{deposit}} to secure

We'd love to be part of your celebration! 📸

Ready to book? Click here: {{stripe_link}}

Questions? Just reply to this email!

Best,
Party Favor Photo Team
```

### XMRT - Fleet Notification

**Trigger:** Infrastructure updates, agent coordination

```html
From: XMRT DAO <noreply@mobilemonero.com>
To: {{agent_email}}
Subject: Fleet Update - {{topic}}

{{message_body}}

--
XMRT DAO Infrastructure
relay.mobilemonero.com
```

---

## Testing Checklist

- [x] PFP Resend API key verified
- [x] XMRT Resend API key verified
- [x] Email sent to Samantha Gonzales (PFP)
- [ ] Webhook endpoint configured
- [ ] Webhook signature verification tested
- [ ] Email templates tested
- [ ] Bounce handling configured

---

## Security Notes

**NEVER:**
- Commit API keys to GitHub
- Share webhook secrets
- Use PFP key for XMRT emails (or vice versa)
- Log full API key responses

**ALWAYS:**
- Use environment variables
- Rotate keys quarterly
- Verify webhook signatures
- Monitor for unusual activity

---

*Generated by Hermes Agent for XMRT DAO*
