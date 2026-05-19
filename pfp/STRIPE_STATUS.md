# PFP Booking & Stripe Integration — Status

**Last Updated:** 2026-05-18 23:00 UTC

---

## ✅ What's Working

### Email Pipeline
- ✅ Resend integration active
- ✅ 50 emails in PFP inbox
- ✅ 16 sent emails logged
- ✅ Auto-responders working

### Stripe Payment Link
- ✅ Link live: https://buy.stripe.com/8x25kD7ezg6h4iC15YbZe03
- ✅ Returns HTTP 200
- ✅ Product: Festival booth ($498 for 2 days = $992 total)

### Recent Email Activity
| To | Subject | Status |
|----|---------|--------|
| hannah@dcjazzfest.org | Re: DC JazzFest pricing | ✅ Delivered |
| croughanashley@gmail.com | Spring Into Summer - partnership | ✅ Sent |
| hannah@dcjazzfest.org | DC JazzFest pricing | ✅ Sent |
| croughanashley@gmail.com | Re: Spring Into Summer Festival | ✅ Delivered |

---

## ⏳ What Needs Deployment

### Edge Functions (Supabase)
| Function | Status | Purpose |
|----------|--------|---------|
| `generate-stripe-link` | ❌ Not Found | Generate dynamic payment links |
| `stripe-payment-webhook` | ❌ Not Found | Handle payment callbacks |
| `pfp-booking` | ❌ Not Found | Booking intake form |
| `pfp-quote` | ❌ Not Found | Generate itemized quotes |
| `pfp-template` | ❌ Not Found | AI template generator |

### API Gateway Routes
| Route | Backend | Status |
|-------|---------|--------|
| `/api/generate-stripe-link` | Supabase Function | ❌ 404 |
| `/api/pfp-booking` | Supabase Function | ❌ 404 |
| `/api/pfp-quote` | Supabase Function | ❌ 404 |

---

## Current Booking Flow (Manual)

1. **Lead inquiry** → PFP inbox (`bookings@partyfavorphoto.com`)
2. **Joe responds** with Stripe link: `https://buy.stripe.com/8x25kD7ezg6h4iC15YbZe03`
3. **Customer pays** → Stripe webhook → Supabase
4. **Booking logged** → Sent emails log
5. **Auto-responder** → Sends confirmation + next steps

---

## Desired Flow (Automated)

1. **Lead inquiry** → Auto-detected in inbox
2. **Auto-responder** → Sends quote + Stripe link
3. **Payment** → Webhook triggers booking confirmation
4. **Calendar sync** → Event added to Google Calendar
5. **Follow-up** → Automated sequence (T-7 days, T-1 day, post-event)

---

## Action Items

### High Priority (Revenue)
- [ ] Deploy `generate-stripe-link` edge function
- [ ] Deploy `pfp-booking` edge function
- [ ] Test end-to-end booking flow
- [ ] Add webhook handler for payment confirmation

### Medium Priority (Automation)
- [ ] Google Calendar integration
- [ ] Auto-responder with dynamic pricing
- [ ] Follow-up email sequence

### Low Priority (Nice-to-have)
- [ ] PFP template generator (AI photo booth templates)
- [ ] Quote generator (itemized PDF)

---

## Testing Plan

### Test 1: Manual Stripe Link
```bash
curl -I https://buy.stripe.com/8x25kD7ezg6h4iC15YbZe03
# Expected: HTTP 200
```

### Test 2: Email Auto-Responder
```bash
# Send test email to bookings@partyfavorphoto.com
# Expected: Auto-reply within 1 minute with Stripe link
```

### Test 3: Booking Flow
```bash
# POST to /api/pfp-booking with test data
# Expected: Stripe link + booking confirmation
```

---

## Current Blockers

1. **Edge functions not deployed** to Supabase
2. **API gateway routes** returning 404
3. **Webhook handler** not configured

---

## Next Steps

1. ✅ Verify Stripe link works (DONE)
2. ⏳ Deploy edge functions to Supabase
3. ⏳ Configure webhook handler
4. ⏳ Test booking flow end-to-end
5. ⏳ Add calendar integration

---

**Status:** Stripe link working, edge functions need deployment
**Revenue Impact:** Manual flow working, automation pending
