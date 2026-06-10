# 📧 Resend DNS Fix - partyfavorphoto.com

**Date:** 2026-06-10  
**Priority:** P0 - Blocking $1,743 Pipeline  
**Status:** 403 Forbidden - DNS Records Missing

---

## Problem

**Domain:** partyfavorphoto.com  
**Resend Status:** "Verified" but cannot send (403 Forbidden)  
**Root Cause:** DNS records not configured in Cloudflare

---

## Required DNS Records

Add these to **Cloudflare DNS** for partyfavorphoto.com:

### 1. MX Record (Email Routing)

| Field | Value |
|-------|-------|
| **Type** | MX |
| **Name** | @ |
| **Mail Server** | `feedback-smtp.us-east-1.amazonses.com` |
| **Priority** | 10 |
| **Proxy** | ❌ DNS Only (gray cloud) |

### 2. TXT Record (SPF)

| Field | Value |
|-------|-------|
| **Type** | TXT |
| **Name** | @ |
| **Content** | `v=spf1 include:resend.com ~all` |
| **Proxy** | N/A (TXT can't be proxied) |

### 3. CNAME Record (DKIM)

**⚠️ Get exact value from Resend dashboard!**

| Field | Value |
|-------|-------|
| **Type** | CNAME |
| **Name** | `resend._domainkey` |
| **Target** | `[RESEND_PROVIDES_THIS].dkim.amazonses.com` |
| **Proxy** | ❌ DNS Only (gray cloud) |

**How to get DKIM value:**
1. Go to https://resend.com/domains
2. Select partyfavorphoto.com
3. Copy the CNAME target value
4. Add to Cloudflare DNS

### 4. TXT Record (DMARC - Recommended)

| Field | Value |
|-------|-------|
| **Type** | TXT |
| **Name** | `_dmarc` |
| **Content** | `v=DMARC1; p=quarantine; rua=mailto:dmarc@partyfavorphoto.com` |
| **Proxy** | N/A (TXT can't be proxied) |

---

## Step-by-Step Fix

### Step 1: Get DKIM Value from Resend

```bash
curl https://api.resend.com/domains/partyfavorphoto.com \
  -H "Authorization: Bearer re_BrGV9sSL_3b7F6XdV1NE8QufC1FNze69E"
```

Look for the CNAME record in the response.

### Step 2: Add DNS Records to Cloudflare

1. Log into Cloudflare Dashboard
2. Select partyfavorphoto.com zone
3. Go to DNS → Records
4. Add 4 records (above)

### Step 3: Wait for Propagation

- **MX:** 1-2 hours
- **TXT:** 5-30 minutes
- **CNAME:** 1-2 hours
- **DMARC:** 5-30 minutes

### Step 4: Verify in Resend

1. Go to Resend dashboard
2. Click "Verify DNS" for partyfavorphoto.com
3. All records should show ✅

### Step 5: Test Sending

```bash
curl -X POST https://api.resend.com/emails \
  -H "Authorization: Bearer re_BrGV9sSL_3b7F6XdV1NE8QufC1FNze69E" \
  -H "Content-Type: application/json" \
  -d '{
    "from": "Party Favor Photo <bookings@partyfavorphoto.com>",
    "to": "test@gmail.com",
    "subject": "DNS Test",
    "text": "Testing email sending after DNS fix"
  }'
```

---

## Quick Add via Cloudflare API

If you have Cloudflare API token:

```bash
# Get Zone ID
ZONE_ID=$(curl -s "https://api.cloudflare.com/client/v4/zones?name=partyfavorphoto.com" \
  -H "Authorization: Bearer $CF_API_TOKEN" | \
  python3 -c "import sys,json; print(json.load(sys.stdin)['result'][0]['id'])")

# Add MX Record
curl -X POST "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/dns_records" \
  -H "Authorization: Bearer $CF_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "type":"MX",
    "name":"partyfavorphoto.com",
    "content":"feedback-smtp.us-east-1.amazonses.com",
    "priority":10,
    "proxied":false
  }'

# Add SPF Record
curl -X POST "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/dns_records" \
  -H "Authorization: Bearer $CF_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "type":"TXT",
    "name":"partyfavorphoto.com",
    "content":"v=spf1 include:resend.com ~all"
  }'

# Add DMARC Record
curl -X POST "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/dns_records" \
  -H "Authorization: Bearer $CF_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "type":"TXT",
    "name":"_dmarc.partyfavorphoto.com",
    "content":"v=DMARC1; p=quarantine; rua=mailto:dmarc@partyfavorphoto.com"
  }'

# Add DKIM CNAME (replace VALUE with actual from Resend)
curl -X POST "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/dns_records" \
  -H "Authorization: Bearer $CF_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "type":"CNAME",
    "name":"resend._domainkey.partyfavorphoto.com",
    "content":"VALUE.dkim.amazonses.com",
    "proxied":false
  }'
```

---

## Verification Commands

### Check MX Record
```bash
nslookup -type=MX partyfavorphoto.com
# Should show: feedback-smtp.us-east-1.amazonses.com
```

### Check SPF Record
```bash
nslookup -type=TXT partyfavorphoto.com
# Should show: v=spf1 include:resend.com ~all
```

### Check DKIM Record
```bash
nslookup -type=CNAME resend._domainkey.partyfavorphoto.com
# Should show: [VALUE].dkim.amazonses.com
```

### Check DMARC Record
```bash
nslookup -type=TXT _dmarc.partyfavorphoto.com
# Should show: v=DMARC1; p=quarantine; ...
```

---

## Pipeline Impact

| Lead | Value | Status |
|------|-------|--------|
| **Samantha Gonzales** (Aug 22) | $747 | ⏳ Email blocked - DNS issue |
| **Da'Monique** (July 4th) | ~$996 | ⏳ Quote sent, awaiting response |
| **Total at Risk** | **$1,743** | 🔴 DNS fix needed |

---

## After DNS is Fixed

1. ✅ Send email to Samantha Gonzales
2. ✅ Send booking confirmation with Stripe link
3. ✅ Set up webhook for email events (sent, delivered, opened)
4. ✅ Test all PFP email templates

---

## Troubleshooting

### Still Getting 403 After Adding Records

**Cause:** DNS propagation delay  
**Solution:** Wait 1-2 hours, then click "Verify DNS" in Resend

### DKIM Record Wrong

**Cause:** Copy/paste error  
**Solution:** Double-check the exact value from Resend dashboard

### Email Goes to Spam

**Cause:** SPF/DMARC not configured  
**Solution:** Verify both records are present and correct

---

*Generated by Hermes Agent for XMRT DAO*
