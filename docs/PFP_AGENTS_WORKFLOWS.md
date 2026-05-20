# AGENTS.md — Party Favor Photo Agent Workflows

This file tells you exactly how to handle any task for Party Favor Photo.

---

## 1. SENDING A QUOTE

**When a client asks about pricing or wants a proposal:**

```bash
# Step 1: Generate the quote PDF
node quotes/generate.mjs "Client Name" "Event Name" 4 premium

# Step 2: Send the quote as an HTML email
node quotes/send-email.mjs "client@email.com" "Client Name" "Event Name" 4 premium
```

The HTML email includes full branding, service bullet points, pricing, and the correct Stripe booking link for the package duration. No attachment needed — the quote is the email body.

**Pricing rules:**
- Standard (2×6 strips) = $249/hr
- Premium (4×6 prints) = $349/hr
- Discounts: flat $100 off max (military, school, pay-in-full)
- Only one discount per booking

**Stripe links match the package:**
- 2hr quote → 2hr Stripe link
- 3hr quote → 3hr Stripe link
- 4hr quote → 4hr Stripe link
- 5hr/6hr → fallback to 4hr link

---

## 2. FILLING OUT A FORM

### Scenario A: Someone emails a PDF form (vendor application, W-9, etc.)

**On a system with Python (Hermes/phone):**
```bash
python3 pdf_form_processor.py check-inbox
python3 pdf_form_processor.py download --email-id <id> --output form.pdf
python3 pdf_form_processor.py list-fields --input form.pdf
python3 pdf_form_processor.py fill --input form.pdf --data data/pfp-data.json --output filled.pdf
python3 pdf_form_processor.py sign --input filled.pdf --output signed.pdf --signature assets/signature.png
python3 pdf_form_processor.py send --pdf signed.pdf --to sender@email.com
```

### Scenario B: Someone sends a web form link (MS Forms, Google Forms)

**On a system with Playwright (Vex/laptop):**
```bash
node forms/form-fill.mjs <url> inspect     # See what fields exist
node forms/form-fill.mjs <url> fill [profile]  # Auto-fill from profile
```

**Available profiles** in `forms/profiles/`:
- `default.json` — Standard PFP business info
- Create new profiles for specific events as needed

**QC checklist before sending:**
- Phone must be (202) 798-0610 (not 555-XXXX)
- Name must be "Joe Lee" (not "Joseph Andrew Lee")
- Pricing math correct ($249/hr or $349/hr × hours)
- Discount is flat $100 (not percentage-based)
- Signature is an image, not just text

---

## 3. GENERATING CONTRACTS

When a client is ready to book:

```bash
# Generate all 10 contract templates
node contracts/generate.mjs
```

Output goes to `contracts/` with files named:
`PFP-{hours}hr-{Standard|Premium}-Contract.pdf`

Each contract includes:
- PFP logo header
- Client and event fillable fields
- Service bullet points (9 for Standard, 11 for Premium)
- Pricing with $100 discount option
- 8-section terms & conditions
- Joe's signature pre-signed
- Client signature line

**Which contract to send:**
- Ask client: how many hours? 2×6 strips or premium 4×6 prints?
- Send the matching PDF from `contracts/`
- They print, sign, scan, and return (or use DocuSign)

---

## 4. BRANDING RULES

- **Service name:** "StudioStation" (not "photo booth", not "tablet kit")
- **Company name:** "Party Favor Photo"
- **Contract title:** "Party Favor Photo Contract" (not "StudioStation Contract")
- **The strobe flash** is a "crowd magnet" — emphasize it draws people in
- **Pricing:** Compete on quality, not price
- **Never say:** "photo booth", "tablet kit", "ring light", "affordable option"
- **Always say:** "StudioStation", "bounce-diffused strobe lighting", "DSLR cameras", "premium"

---

## 5. KEY DATA

| Item | Value |
|------|-------|
| Email | bookings@partyfavorphoto.com |
| Phone | (202) 798-0610 |
| Owner | Joe Lee |
| Insurance | $1M General Liability |
| Service area | Washington DC + Dallas/Fort Worth |
| Logo | `assets/logo.png` |
| Signature | `assets/signature.png` |
| Stripe 2hr | https://buy.stripe.com/8x25kD7ezg6h4iC15YbZe03 |
| Stripe 3hr | https://buy.stripe.com/9B63cv9mH07j3eyeWObZe06 |
| Stripe 4hr | https://buy.stripe.com/eVqcN556r4nz16qeWObZe04 |

## 6. REQUIRED ENVIRONMENT

Copy `.env.example` to `.env` and fill in:
- `SUPABASE_SERVICE_ROLE_KEY` — for sending emails via Resend edge function
- `RESEND_API_KEY` — for checking inbox
- `GITHUB_TOKEN` — for posting to issues
