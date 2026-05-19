# 📧 Email Tools — Payload Schemas

Complete documentation for sending/receiving emails via XMRT DAO relay.

---

## 1. Send Email (Resend)

### Endpoint
```
POST https://vawouugtzwmejxqkeqqj.supabase.co/functions/v1/resend-email
```

### Headers
```
Authorization: Bearer <SUPABASE_SERVICE_ROLE_KEY>
X-Resend-Key: <RESEND_API_KEY>
Content-Type: application/json
```

### Payload
```json
{
  "to": "recipient@example.com",
  "subject": "Your subject line",
  "body": "Plain text email body",
  "from": "bookings@partyfavorphoto.com"
}
```

### Fields
| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `to` | ✅ Yes | - | Recipient email address |
| `subject` | ✅ Yes | - | Email subject line |
| `body` | ✅ Yes | - | Plain text body (HTML not supported) |
| `from` | ❌ No | `bookings@partyfavorphoto.com` | Sender address |

### Domain Routing
| Domain | From Address | API Key |
|--------|-------------|---------|
| partyfavorphoto.com | `bookings@partyfavorphoto.com` | `RESEND_API_KEY` |
| mobilemonero.com | `vex@mobilemonero.com` | `RESEND_XMRT_API_KEY` |

### Response
```json
{
  "status": "sent",
  "id": "<resend-message-id>",
  "to": ["recipient@example.com"],
  "subject": "Your subject line",
  "from": "Party Favor Photo <bookings@partyfavorphoto.com>"
}
```

### Example (curl)
```bash
curl -X POST https://vawouugtzwmejxqkeqqj.supabase.co/functions/v1/resend-email \
  -H "Authorization: Bearer eyJhbG...zxU" \
  -H "X-Resend-Key: re_..." \
  -H "Content-Type: application/json" \
  -d '{
    "to": "client@example.com",
    "subject": "Hello from Party Favor Photo",
    "body": "Hi there,\n\nWe provide photo booth services...",
    "from": "bookings@partyfavorphoto.com"
  }'
```

---

## 2. Read Inbox (Party Favor Photo)

### Endpoint
```
GET https://relay.mobilemonero.com/resend/inbox
```

### Auth
None required (public endpoint via relay)

### Response
```json
{
  "count": 50,
  "emails": [
    {
      "email_id": "uuid",
      "from": "sender@example.com",
      "to": ["bookings@partyfavorphoto.com"],
      "cc": ["cc@example.com"],
      "subject": "Email subject",
      "body": "Full email body text...",
      "text": "Plain text version",
      "html": "<html>...</html>",
      "created_at": "2026-05-18T20:46:34.498Z",
      "message_id": "<message-id>",
      "attachments": [],
      "received_at": "2026-05-18T20:46:35.634Z"
    }
  ]
}
```

### Brief Mode (Metadata Only)
```
GET https://relay.mobilemonero.com/resend/inbox/brief
```
Returns same structure but without `body`, `text`, `html` fields (~10KB vs ~200KB).

---

## 3. Read Inbox (MobileMonero)

### Endpoint
```
GET https://relay.mobilemonero.com/resend/mobilemonero/inbox
```

### Brief Mode
```
GET https://relay.mobilemonero.com/resend/mobilemonero/inbox/brief
```

Response format identical to PFP inbox.

---

## 4. Sent Email Log

### Endpoint
```
GET https://relay.mobilemonero.com/sent-emails?limit=20
```

### Response
```json
{
  "count": 16,
  "emails": [
    {
      "to": "recipient@example.com",
      "subject": "Email subject",
      "body": "Email body preview",
      "type": "reply | auto-responder | social",
      "status": "sent | delivered | failed",
      "logged_at": "2026-05-18T20:46:36.258Z"
    }
  ]
}
```

---

## 5. Log Sent Email (Manual)

### Endpoint
```
POST https://relay.mobilemonero.com/log/sent
```

### Payload
```json
{
  "to": "recipient@example.com",
  "subject": "Email subject",
  "body": "Email body",
  "type": "reply"
}
```

---

## Common Use Cases

### 1. Send Partnership Inquiry
```bash
curl -X POST https://vawouugtzwmejxqkeqqj.supabase.co/functions/v1/resend-email \
  -H "Authorization: Bearer $SUPABASE_KEY" \
  -H "X-Resend-Key: $RESEND_API_KEY" \
  -d '{
    "to": "festival@example.com",
    "subject": "Partnership Opportunity: Party Favor Photo",
    "body": "Hi,\n\nWe'\''d love to become your official photo station...\n\nBest,\nJoe Lee",
    "from": "bookings@partyfavorphoto.com"
  }'
```

### 2. Check for New Emails
```bash
curl https://relay.mobilemonero.com/resend/inbox/brief | python3 -c "
import json,sys
data=json.load(sys.stdin)
for email in data['emails'][:5]:
    print(f\"{email['from']}: {email['subject']}\")
"
```

### 3. Auto-Responder Pattern
```python
# Check inbox
inbox = requests.get('https://relay.mobilemonero.com/resend/inbox/brief').json()

# Find unanswered emails
for email in inbox['emails']:
    if not email['subject'].startswith('Re:'):
        # Send auto-reply
        requests.post('https://vawouugtzwmejxqkeqqj.supabase.co/functions/v1/resend-email',
            headers={...},
            json={
                'to': email['from'],
                'subject': f"Re: {email['subject']}",
                'body': 'Thanks for reaching out! Joe will follow up soon.',
                'from': 'bookings@partyfavorphoto.com'
            })
```

---

## Environment Variables

Store these in your agent's config:

```bash
SUPABASE_URL="https://vawouugtzwmejxqkeqqj.supabase.co"
SUPABASE_SERVICE_ROLE_KEY="eyJhbG...zxU"
RESEND_API_KEY="re_..."  # For partyfavorphoto.com
RESEND_XMRT_API_KEY="re_..."  # For mobilemonero.com
```

---

## Rate Limits

| Service | Limit | Notes |
|---------|-------|-------|
| Resend (free tier) | 3,000 emails/month | ~100/day |
| Relay inbox endpoint | No limit | Cached, ~200KB response |
| Sent log | No limit | Append-only |

---

## Error Codes

| Code | Meaning | Fix |
|------|---------|-----|
| 401 | Invalid API key | Check `Authorization` and `X-Resend-Key` headers |
| 400 | Missing fields | Ensure `to`, `subject`, `body` are present |
| 429 | Rate limited | Wait 1 hour or upgrade Resend plan |
| 500 | Resend API error | Retry with exponential backoff |

---

**Last Updated:** 2026-05-18  
**Maintained By:** XMRT DAO Fleet
