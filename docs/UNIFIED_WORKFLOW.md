# Unified PFP Workflow — Party Favor Photo + XMRT DAO

**Last Updated:** 2026-05-20  
**Repos:** github.com/xmrtdao/mobilemonero + github.com/xmrtdao/partyfavorphoto

---

## 📊 System Overview

| Component | Primary Repo | Tool | Purpose |
|-----------|--------------|------|---------|
| **Quotes** | partyfavorphoto | `quotes/generate.mjs` | Generate custom quote PDFs |
| **Quote Emails** | partyfavorphoto | `quotes/send-email.mjs` | Send HTML emails with branding |
| **Contracts** | partyfavorphoto | `contracts/*.pdf` | 10 pre-generated templates |
| **PDF Forms** | mobilemonero | `perfect_pdf_filler.py` | Fill vendor forms (100% accuracy) |
| **Web Forms** | partyfavorphoto | `forms/form-fill.mjs` | Auto-fill web forms (Playwright) |
| **Email Pipeline** | mobilemonero | Resend API | 50 inbox, 16 sent |
| **Fleet Chat** | mobilemonero | relay.mobilemonero.com | Vex, Eliza, Hermes coordination |
| **Mesh Network** | mobilemonero | `mesh/mesh-node.py` | P2P messaging (ports 4001-4003) |

---

## 🎯 Quick Start

### Scenario 1: Client Asks for Quote

```bash
# Use Vex's quote system (partyfavorphoto repo)
cd ~/partyfavorphoto

# Generate quote
node quotes/generate.mjs "Hannah Kuhns" "DC Jazz Festival 2026" 4 premium

# Send as HTML email (quote is email body, not attachment)
node quotes/send-email.mjs "hannah@dcjazzfest.org" "Hannah Kuhns" "DC Jazz Festival 2026" 4 premium
```

**What Happens:**
- ✅ Generates 4-hour premium quote ($349/hr × 4 = $1,396 - $100 discount = $1,296)
- ✅ Sends branded HTML email with service bullet points
- ✅ Includes correct Stripe link (4hr tier)
- ✅ Professional PFP branding

---

### Scenario 2: Client Ready to Book

```bash
# Send contract template (from partyfavorphoto repo)
# Choose based on hours + tier preference

# 2-hour Standard ($249/hr × 2 = $498)
cp ~/partyfavorphoto/contracts/PFP-2hr-Standard-Contract.pdf ~/mobilemonero/pdfs/

# 4-hour Premium ($349/hr × 4 = $1,396 - $100 = $1,296)
cp ~/partyfavorphoto/contracts/PFP-4hr-Premium-Contract.pdf ~/mobilemonero/pdfs/

# Email contract to client
python3 ~/mobilemonero/tools/pdf_tools.py send \
  --pdf ~/mobilemonero/pdfs/PFP-4hr-Premium-Contract.pdf \
  --to client@example.com \
  --subject "Party Favor Photo Contract - Your Event 2026" \
  --body "Please review and sign the attached contract. Return signed copy to secure your booking!"
```

---

### Scenario 3: Festival Sends Vendor Form (PDF)

```bash
# Use Hermes' perfect PDF filler (mobilemonero repo)
cd ~/mobilemonero

# Check inbox for form
python3 tools/pdf_form_processor.py check-inbox

# Download form from email
python3 tools/pdf_form_processor.py download \
  --email-id <id> \
  --output ~/mobilemonero/pdfs/festival-form.pdf

# Fill form with PFP data (100% accuracy)
python3 tools/perfect_pdf_filler.py \
  --form ~/mobilemonero/pdfs/festival-form.pdf \
  --output ~/mobilemonero/pdfs/filled-form.pdf \
  --data ~/mobilemonero/pdfs/pfp-data-UPDATED.json

# Sign form
python3 tools/pdf_form_processor.py sign \
  --input ~/mobilemonero/pdfs/filled-form.pdf \
  --output ~/mobilemonero/pdfs/signed-form.pdf \
  --signature ~/mobilemonero/signature.pdf

# Send back to festival
python3 tools/pdf_form_processor.py send \
  --pdf ~/mobilemonero/pdfs/signed-form.pdf \
  --to festival@example.com \
  --subject "Completed Vendor Form - Party Favor Photo" \
  --body "Please find attached our completed vendor registration form."
```

---

### Scenario 4: Festival Sends Web Form Link

```bash
# Use Vex's Playwright form filler (partyfavorphoto repo)
cd ~/partyfavorphoto

# Inspect form first
node forms/form-fill.mjs "https://forms.example.com/vendor-app" inspect

# Auto-fill from profile
node forms/form-fill.mjs "https://forms.example.com/vendor-app" fill default

# QC checklist:
# ✓ Phone: (202) 798-0610 (not 555-XXXX)
# ✓ Name: Joe Lee (not Joseph Andrew Lee)
# ✓ Pricing: $249/hr or $349/hr × hours
# ✓ Discount: flat $100 (not percentage)
# ✓ Signature: image, not text
```

---

## 📞 Updated Contact Information

| Field | Old Value | New Value | Source |
|-------|-----------|-----------|--------|
| **Phone** | (202) 555-0123 | **(202) 798-0610** | partyfavorphoto |
| **Contact Name** | Joseph Andrew Lee | **Joe Lee** | partyfavorphoto |
| **Business Type** | Photo Booth Services | **StudioStation Photo Services** | partyfavorphoto |
| **Equipment** | Photo Booth with DSLR | **StudioStation with DSLR** | partyfavorphoto |

---

## 💳 Stripe Payment Links (Tiered)

| Duration | Standard ($249/hr) | Premium ($349/hr) | Stripe Link |
|----------|-------------------|-------------------|-------------|
| 2hr | $498 | $698 | https://buy.stripe.com/8x25kD7ezg6h4iC15YbZe03 |
| 3hr | $747 | $1,047 | https://buy.stripe.com/9B63cv9mH07j3eyeWObZe06 |
| 4hr | $996 | $1,396 | https://buy.stripe.com/eVqcN556r4nz16qeWObZe04 |
| 5hr | $1,245 | $1,745 | Use 4hr link + manual adjustment |
| 6hr | $1,494 | $2,094 | Use 4hr link + manual adjustment |

**Discount Rules:**
- Flat $100 off max (military, school, pay-in-full)
- Only one discount per booking
- Never percentage-based

---

## 📁 Key Files

### From partyfavorphoto
```
partyfavorphoto/
├── AGENTS.md                     ← Workflow documentation
├── contracts/
│   ├── PFP-2hr-Standard-Contract.pdf
│   ├── PFP-2hr-Premium-Contract.pdf
│   ├── PFP-3hr-Standard-Contract.pdf
│   ├── PFP-3hr-Premium-Contract.pdf
│   ├── PFP-4hr-Standard-Contract.pdf
│   ├── PFP-4hr-Premium-Contract.pdf
│   ├── PFP-5hr-Standard-Contract.pdf
│   ├── PFP-5hr-Premium-Contract.pdf
│   ├── PFP-6hr-Standard-Contract.pdf
│   └── PFP-6hr-Premium-Contract.pdf
├── quotes/
│   ├── generate.mjs              ← Quote generator
│   └── send-email.mjs            ← Quote email sender
├── forms/
│   ├── form-fill.mjs             ← Web form filler
│   └── profiles/default.json     ← Business info
└── data/pfp-data.json            ← Updated contact info
```

### From mobilemonero
```
mobilemonero/
├── docs/PFP_AGENTS_WORKFLOWS.md  ← AGENTS.md copy
├── docs/UNIFIED_WORKFLOW.md      ← This file
├── pdfs/pfp-data-UPDATED.json    ← Updated business data
├── tools/
│   ├── perfect_pdf_filler.py     ← 100% accurate PDF filler
│   ├── pdf_form_processor.py     ← Form processor
│   └── pdf_tools.py              ← Contract sender
└── fleet/
    └── hermes_relay_listener.py  ← Fleet relay (port 9090)
```

---

## 🎯 Active Leads

### 1. Hannah Kuhns - DC Jazz Festival 2026
- **Status:** ✅ Quote sent (4hr premium)
- **Email:** hannah@dcjazzfest.org
- **Quote:** $1,296 ($349 × 4 - $100 discount)
- **Stripe:** 4hr link
- **Next:** Wait for response, follow up in 2 days

### 2. Ashley Croughan - Spring Into Summer Festival
- **Status:** ⏳ Needs quote
- **Email:** croughanashley@gmail.com
- **Quote:** Send 4hr standard or premium?
- **Next:** Generate and send quote

### 3. Dallas Farmers Market
- **Status:** ⏳ Needs vendor form
- **Email:** ashley.andrews@spectrumprop.com
- **Form:** Use perfect_pdf_filler.py
- **Next:** Fill and send vendor form

---

## 🚀 Next Steps

1. ✅ **Sync contracts** - Copy 10 templates to mobilemonero/pdfs/
2. ✅ **Update data** - Use pfp-data-UPDATED.json with correct phone/name
3. ✅ **Document workflows** - This unified workflow doc
4. ⏳ **Send Ashley quote** - Use Vex's quote generator
5. ⏳ **Process Dallas form** - Use perfect_pdf_filler.py

---

**Both repos working together = Complete PFP + XMRT DAO system!** 🎉
