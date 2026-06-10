# 🎉 PFP Booking Request - Samantha Gonzales

**Received:** 2026-06-10 17:25 UTC  
**Source:** Fleet Chat (Vex)  
**Status:** ⏳ Processing - Need to create booking record

---

## 📋 Booking Details

| Field | Value |
|-------|-------|
| **Customer Name** | Samantha Gonzales |
| **Email** | Samanthagonzales919@gmail.com |
| **Phone** | 571-839-8119 |
| **Event Date** | Saturday, August 22nd, 2026 |
| **Service** | StudioStation Photo Booth - 3 Hours |
| **Quantity** | 1 |
| **Subtotal** | $747.00 |
| **Total** | **$747.00** |

---

## 🔄 Booking Flow Status

| Step | Status | Notes |
|------|--------|-------|
| 1. Website Form Submission | ✅ Complete | Received via fleet chat |
| 2. Create Leads Record | ⏳ Pending | Supabase DNS failing from Termux |
| 3. Send Stripe Checkout Link | ⏳ Pending | Need booking record first |
| 4. Customer Pays Deposit | ⏳ Pending | Awaiting Stripe link |
| 5. Create Booking Record | ⏳ Pending | After checkout.session.completed |
| 6. Event Confirmation | ⏳ Pending | After deposit paid |

---

## 📧 Required Follow-Up

### Email to Customer
**To:** Samanthagonzales919@gmail.com  
**Subject:** Party Favor Photo Booth - August 22nd Event

**Content:**
```
Hi Samantha!

Thanks for your interest in Party Favor Photo Booth for your event on 
Saturday, August 22nd, 2026!

Your selected package:
- StudioStation Photo Booth - 3 Hours
- Total: $747.00

Next Steps:
1. Click here to pay your deposit: [STRIPE_CHECKOUT_LINK]
2. Confirm your event venue/location
3. Let us know any theme requirements

Questions? Reply to this email or call/text us!

Best,
Party Favor Photo Team
```

### Missing Info to Confirm
- [ ] Event venue/location
- [ ] Event start time
- [ ] Theme/color scheme preferences
- [ ] Any special requirements

---

## 💰 Pipeline Impact

| Metric | Value |
|--------|-------|
| **This Booking** | $747 |
| **Da'Monique Lead** | ~$996 (quote sent) |
| **Total Pipeline** | **$1,743** |
| **Q3 2026 Target** | $50,000 |
| **Pipeline vs Target** | 3.5% |

---

## 🚀 Action Items

### Immediate (Today)
- [ ] Create leads record in Supabase
- [ ] Generate Stripe checkout link
- [ ] Send email with booking link
- [ ] Post confirmation to fleet chat

### Follow-Up (48hrs)
- [ ] Check if deposit paid
- [ ] If no payment: send reminder email
- [ ] If payment received: create booking record

### Event Prep (Before Aug 22)
- [ ] Confirm venue details
- [ ] Prepare equipment
- [ ] Send reminder 1 week before

---

## 📊 Booking System Notes

**Current Limitation:** Supabase DNS resolution failing from Termux

**Workaround:** Vex laptop has local Supabase emulator - can create booking record there

**Tables Needed:**
- `leads` - Pre-payment inquiry (this request)
- `bookings` - Confirmed (after Stripe deposit paid)

---

*Tracked by Hermes Agent for XMRT DAO*
