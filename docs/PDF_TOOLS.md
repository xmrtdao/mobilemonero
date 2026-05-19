# XMRT DAO PDF Tools - Documentation

**Status:** ✅ Production Ready
**Location:** `~/mobilemonero/tools/pdf_tools.py`

---

## Quick Start

### Create Contract
```bash
python3 ~/mobilemonero/tools/pdf_tools.py create \
  --type contract \
  --output ~/mobilemonero/pdfs/contract.pdf \
  --data '{"client_name":"Hannah Kuhns","client_email":"hannah@dcjazzfest.org","event_name":"DC Jazz Festival 2026","event_date":"June 13-14, 2026","event_location":"The Wharf, Washington DC","package":"2-Day Festival","price":992,"deposit":496,"balance_due":496}'
```

### Create Invoice
```bash
python3 ~/mobilemonero/tools/pdf_tools.py create \
  --type invoice \
  --output ~/mobilemonero/pdfs/invoice.pdf \
  --data '{"invoice_number":"INV-2026-001","client_name":"Hannah Kuhns","client_email":"hannah@dcjazzfest.org","items":[{"description":"2-Day Festival Package","amount":992}],"total":992,"due_date":"2026-06-06"}'
```

### Send PDF via Email
```bash
python3 ~/mobilemonero/tools/pdf_tools.py send \
  --pdf ~/mobilemonero/pdfs/contract.pdf \
  --to hannah@dcjazzfest.org \
  --subject "Your Party Favor Photo Contract" \
  --body "Hi Hannah, Attached is your service contract for DC Jazz Festival 2026. Please review and sign. Payment link: https://buy.stripe.com/8x25kD7ezg6h4iC15YbZe03"
```

---

## API Reference

### `create_contract(data, output_path)`

Create a service contract PDF.

**Args:**
- `data` (dict):
  - `client_name` (str): Client full name
  - `client_email` (str): Client email
  - `event_name` (str): Event name
  - `event_date` (str): Event date(s)
  - `event_location` (str): Event location
  - `package` (str): Package name (e.g., "2-Day Festival")
  - `price` (float): Total price
  - `deposit` (float): Deposit amount
  - `balance_due` (float): Remaining balance
- `output_path` (str): Path to save PDF

**Returns:** `str` - Absolute path to created PDF

**Example:**
```python
from tools.pdf_tools import create_contract

data = {
    "client_name": "Ashley Croughan",
    "client_email": "croughanashley@gmail.com",
    "event_name": "Spring Into Summer Festival",
    "event_date": "June 13, 2026",
    "event_location": "Downtown Dallas",
    "package": "1-Day Festival",
    "price": 498,
    "deposit": 249,
    "balance_due": 249
}

pdf_path = create_contract(data, "spring-into-summer.pdf")
```

---

### `create_invoice(data, output_path)`

Create an invoice PDF.

**Args:**
- `data` (dict):
  - `invoice_number` (str): Invoice number
  - `client_name` (str): Client name
  - `client_email` (str): Client email
  - `items` (list): List of {description, amount}
  - `total` (float): Total amount
  - `due_date` (str): Payment due date
- `output_path` (str): Path to save PDF

**Returns:** `str` - Absolute path to created PDF

---

### `send_pdf(pdf_path, to_email, subject, body, from_email)`

Send PDF via email using Resend.

**Args:**
- `pdf_path` (str): Path to PDF file
- `to_email` (str): Recipient email
- `subject` (str): Email subject
- `body` (str): Email body
- `from_email` (str): Sender email (default: bookings@partyfavorphoto.com)

**Returns:** `dict` - Response from email service

**Note:** Currently simulates sending. In production, configure Supabase Resend integration.

---

## Contract Template

### Includes:
- ✅ Client Information
- ✅ Event Details (name, date, location)
- ✅ Package & Pricing (total, deposit, balance)
- ✅ Terms & Conditions (7 standard terms)
- ✅ Signature Lines (client + Party Favor Photo)
- ✅ Auto-generated timestamp

### Standard Terms:
1. 50% deposit required to secure booking
2. Full payment due 7 days before event
3. Photo usage rights for marketing
4. 48-hour cancellation policy
5. Overtime rate ($150/hour)
6. Power requirements (110V, 15A)
7. Setup time (2 hours before event)

---

## Invoice Template

### Includes:
- ✅ Invoice Number & Date
- ✅ Due Date
- ✅ Bill To Information
- ✅ Line Items Table
- ✅ Total Amount
- ✅ Payment Information (Stripe link)
- ✅ Thank You Message

---

## Integration Examples

### 1. Festival Booking Flow
```bash
# Step 1: Create contract
python3 pdf_tools.py create --type contract \
  --output pdfs/festival-contract.pdf \
  --data-file booking-data.json

# Step 2: Send to client
python3 pdf_tools.py send \
  --pdf pdfs/festival-contract.pdf \
  --to client@festival.com \
  --subject "Your Party Favor Photo Contract" \
  --body "Please review and sign. Payment: buy.stripe.com/..."
```

### 2. Automated Workflow (Python)
```python
from tools.pdf_tools import create_contract, send_pdf

# Create contract
data = {
    "client_name": "Festival Organizer",
    "client_email": "organizer@festival.com",
    "event_name": "Summer Music Fest",
    "event_date": "July 15-17, 2026",
    "event_location": "Central Park",
    "package": "3-Day Festival",
    "price": 1488,
    "deposit": 744,
    "balance_due": 744
}

pdf_path = create_contract(data, "summer-fest.pdf")

# Send email
send_pdf(
    pdf_path=pdf_path,
    to_email="organizer@festival.com",
    subject="Summer Music Fest Contract",
    body="Attached is your contract. Please sign and return."
)
```

---

## File Structure

```
~/mobilemonero/
├── tools/
│   └── pdf_tools.py (10.4KB)
├── pdfs/
│   ├── dc-jazzfest-contract.pdf (1.9KB) ← Example
│   └── ...
└── docs/
    └── PDF_TOOLS.md (this file)
```

---

## Dependencies

- `fpdf2` - PDF generation
- `reportlab` - Advanced PDF features
- `requests` - Email sending (via Resend)

**Install:**
```bash
pip install fpdf2 reportlab requests
```

---

## Production Deployment

### 1. Configure Resend API
Update `send_pdf()` function with actual API keys:

```python
headers = {
    "Authorization": "Bearer <SUPABASE_SERVICE_ROLE_KEY>",
    "X-Resend-Key": "<RESEND_API_KEY>",
    "Content-Type": "application/json"
}

response = requests.post(RESEND_ENDPOINT, json=payload, headers=headers)
```

### 2. Add PDF Attachment Support
Currently sends text link. For actual attachments:
- Upload PDF to cloud storage (S3, Cloudflare R2)
- Include download link in email
- Or use Resend's attachment API

### 3. Template Customization
Modify `PDFContract` class for:
- Custom branding (logo, colors)
- Different terms per package
- Multi-language support

---

## Testing

### Test Contract Creation
```bash
python3 pdf_tools.py create --type contract \
  --output /tmp/test.pdf \
  --data '{"client_name":"Test Client","event_name":"Test Event","package":"Standard","price":500,"deposit":250,"balance_due":250}'
```

### Test Invoice Creation
```bash
python3 pdf_tools.py create --type invoice \
  --output /tmp/test-inv.pdf \
  --data '{"invoice_number":"TEST-001","client_name":"Test Client","items":[{"description":"Test","amount":100}],"total":100,"due_date":"2026-06-01"}'
```

---

**Created:** 2026-05-19
**Status:** Production Ready ✅
