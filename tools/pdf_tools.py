#!/usr/bin/env python3
"""
XMRT DAO PDF Tools - Contract & Document Generator
Creates, modifies, and sends PDFs for PFP bookings, contracts, and invoices.

Usage:
    python3 pdf_tools.py create --type contract --output booking.pdf
    python3 pdf_tools.py modify --input template.pdf --output final.pdf
    python3 pdf_tools.py send --pdf booking.pdf --to client@example.com
"""

import argparse
import json
import sys
from datetime import datetime
from pathlib import Path

from fpdf import FPDF
from reportlab.lib.pagesizes import letter
from reportlab.lib import colors
from reportlab.platypus import SimpleDocTemplate, Table, TableStyle, Paragraph, Spacer
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import inch

# Email integration
import requests

RELAY_URL = "https://relay.mobilemonero.com"
RESEND_ENDPOINT = "https://vawouugtzwmejxqkeqqj.supabase.co/functions/v1/resend-email"

class PDFContract(FPDF):
    """Party Favor Photo Contract Template"""
    
    def header(self):
        self.set_font('Helvetica', 'B', 16)
        self.cell(0, 10, 'Party Favor Photo - Service Contract', 0, 1, 'C')
        self.ln(10)
    
    def footer(self):
        self.set_y(-15)
        self.set_font('Helvetica', 'I', 8)
        self.cell(0, 10, f'Generated: {datetime.now().strftime("%Y-%m-%d %H:%M")}', 0, 0, 'C')

def create_contract(data: dict, output_path: str) -> str:
    """
    Create a service contract PDF
    
    Args:
        data: dict with keys:
            - client_name: str
            - client_email: str
            - event_name: str
            - event_date: str
            - event_location: str
            - package: str (e.g., "2-Day Festival")
            - price: float
            - deposit: float
            - balance_due: float
        output_path: str - Path to save PDF
    
    Returns:
        str: Absolute path to created PDF
    """
    pdf = PDFContract()
    pdf.add_page()
    pdf.set_auto_page_break(auto=True, margin=15)
    
    # Client Info
    pdf.set_font('Helvetica', 'B', 12)
    pdf.cell(0, 10, 'Client Information', 0, 1)
    pdf.set_font('Helvetica', '', 11)
    pdf.cell(0, 8, f"Client: {data.get('client_name', 'N/A')}", 0, 1)
    pdf.cell(0, 8, f"Email: {data.get('client_email', 'N/A')}", 0, 1)
    pdf.ln(5)
    
    # Event Details
    pdf.set_font('Helvetica', 'B', 12)
    pdf.cell(0, 10, 'Event Details', 0, 1)
    pdf.set_font('Helvetica', '', 11)
    pdf.cell(0, 8, f"Event: {data.get('event_name', 'N/A')}", 0, 1)
    pdf.cell(0, 8, f"Date: {data.get('event_date', 'N/A')}", 0, 1)
    pdf.cell(0, 8, f"Location: {data.get('event_location', 'N/A')}", 0, 1)
    pdf.ln(5)
    
    # Package & Pricing
    pdf.set_font('Helvetica', 'B', 12)
    pdf.cell(0, 10, 'Package & Pricing', 0, 1)
    
    package = data.get('package', 'Standard')
    price = data.get('price', 0)
    deposit = data.get('deposit', 0)
    balance = data.get('balance_due', price - deposit)
    
    pdf.set_font('Helvetica', '', 11)
    pdf.cell(0, 8, f"Package: {package}", 0, 1)
    pdf.cell(0, 8, f"Total Price: ${price:,.2f}", 0, 1)
    pdf.cell(0, 8, f"Deposit Paid: ${deposit:,.2f}", 0, 1)
    pdf.cell(0, 8, f"Balance Due: ${balance:,.2f}", 0, 1)
    pdf.ln(10)
    
    # Terms
    pdf.set_font('Helvetica', 'B', 12)
    pdf.cell(0, 10, 'Terms & Conditions', 0, 1)
    pdf.set_font('Helvetica', '', 10)
    
    terms = [
        "1. A 50% deposit is required to secure your booking date.",
        "2. Full payment is due 7 days before the event date.",
        "3. Party Favor Photo reserves the right to use photos for marketing.",
        "4. Cancellations within 48 hours forfeit the deposit.",
        "5. Overtime charged at $150/hour.",
        "6. Client responsible for providing power access (110V, 15A).",
        "7. Setup requires 2 hours before event start time."
    ]
    
    for term in terms:
        pdf.multi_cell(0, 6, term)
        pdf.ln(2)
    
    pdf.ln(10)
    
    # Signatures
    pdf.set_font('Helvetica', 'B', 11)
    pdf.cell(0, 10, 'Signatures', 0, 1)
    pdf.ln(15)
    
    pdf.set_font('Helvetica', '', 10)
    pdf.cell(90, 8, "Client Signature: _________________________", 0, 0)
    pdf.cell(0, 8, "Date: _______________", 0, 1)
    pdf.ln(10)
    pdf.cell(90, 8, "Party Favor Photo: _________________________", 0, 0)
    pdf.cell(0, 8, "Date: _______________", 0, 1)
    
    # Save
    pdf.output(output_path)
    return str(Path(output_path).absolute())

def create_invoice(data: dict, output_path: str) -> str:
    """
    Create an invoice PDF
    
    Args:
        data: dict with keys:
            - invoice_number: str
            - client_name: str
            - client_email: str
            - items: list of {description, amount}
            - total: float
            - due_date: str
        output_path: str
    
    Returns:
        str: Absolute path to created PDF
    """
    pdf = FPDF()
    pdf.add_page()
    pdf.set_auto_page_break(auto=True, margin=15)
    
    # Header
    pdf.set_font('Helvetica', 'B', 18)
    pdf.cell(0, 10, 'INVOICE', 0, 1, 'R')
    pdf.set_font('Helvetica', '', 12)
    pdf.cell(0, 8, f"Invoice #: {data.get('invoice_number', 'N/A')}", 0, 1, 'R')
    pdf.cell(0, 8, f"Date: {datetime.now().strftime('%Y-%m-%d')}", 0, 1, 'R')
    pdf.cell(0, 8, f"Due Date: {data.get('due_date', 'N/A')}", 0, 1, 'R')
    pdf.ln(10)
    
    # Bill To
    pdf.set_font('Helvetica', 'B', 12)
    pdf.cell(0, 10, 'Bill To:', 0, 1)
    pdf.set_font('Helvetica', '', 11)
    pdf.cell(0, 8, data.get('client_name', 'N/A'), 0, 1)
    pdf.cell(0, 8, data.get('client_email', 'N/A'), 0, 1)
    pdf.ln(10)
    
    # Items Table
    items = data.get('items', [])
    table_data = [['Description', 'Amount']]
    for item in items:
        table_data.append([item.get('description', ''), f"${item.get('amount', 0):,.2f}"])
    table_data.append(['TOTAL', f"${data.get('total', 0):,.2f}"])
    
    # Simple text-based table (fpdf2 doesn't have built-in tables)
    y = pdf.get_y()
    pdf.set_font('Helvetica', 'B', 10)
    pdf.cell(120, 8, 'Description', 1, 0)
    pdf.cell(50, 8, 'Amount', 1, 1, 'R')
    
    pdf.set_font('Helvetica', '', 10)
    for row in table_data[1:-1]:
        pdf.cell(120, 8, row[0], 1, 0)
        pdf.cell(50, 8, row[1], 1, 1, 'R')
    
    # Total
    pdf.set_font('Helvetica', 'B', 11)
    pdf.cell(120, 10, 'TOTAL DUE', 1, 0)
    pdf.cell(50, 10, f"${data.get('total', 0):,.2f}", 1, 1, 'R')
    
    pdf.ln(15)
    
    # Payment Info
    pdf.set_font('Helvetica', 'B', 11)
    pdf.cell(0, 10, 'Payment Information', 0, 1)
    pdf.set_font('Helvetica', '', 10)
    pdf.multi_cell(0, 6, "Pay via Stripe: https://buy.stripe.com/8x25kD7ezg6h4iC15YbZe03")
    pdf.multi_cell(0, 6, "Or send check to: Party Favor Photo, [Address]")
    
    pdf.ln(10)
    pdf.set_font('Helvetica', 'I', 9)
    pdf.multi_cell(0, 5, "Thank you for your business!")
    
    pdf.output(output_path)
    return str(Path(output_path).absolute())

def send_pdf(pdf_path: str, to_email: str, subject: str, body: str, from_email: str = "bookings@partyfavorphoto.com") -> dict:
    """
    Send PDF via email using Resend
    
    Args:
        pdf_path: str - Path to PDF file
        to_email: str - Recipient email
        subject: str - Email subject
        body: str - Email body
        from_email: str - Sender email (default: bookings@partyfavorphoto.com)
    
    Returns:
        dict: Response from Resend API
    """
    # Note: Resend API requires attachment handling
    # For now, we'll send a link to the PDF instead
    
    # In production, you'd upload PDF to cloud storage and include link
    pdf_link = f"Attachment: {Path(pdf_path).name}"
    
    full_body = f"{body}\n\n---\n{pdf_link}"
    
    payload = {
        "to": to_email,
        "subject": subject,
        "body": full_body,
        "from": from_email
    }
    
    # This would need actual Supabase keys in production
    # headers = {
    #     "Authorization": "Bearer <SUPABASE_KEY>",
    #     "X-Resend-Key": "<RESEND_API_KEY>",
    #     "Content-Type": "application/json"
    # }
    
    # For demo, just log
    print(f"Would send email to {to_email}")
    print(f"Subject: {subject}")
    print(f"Body: {body}")
    print(f"PDF: {pdf_path}")
    
    return {
        "status": "simulated",
        "to": to_email,
        "subject": subject,
        "pdf": pdf_path
    }

def main():
    parser = argparse.ArgumentParser(description='XMRT DAO PDF Tools')
    subparsers = parser.add_subparsers(dest='command', help='Command')
    
    # Create command
    create_parser = subparsers.add_parser('create', help='Create PDF')
    create_parser.add_argument('--type', choices=['contract', 'invoice'], required=True)
    create_parser.add_argument('--output', required=True, help='Output PDF path')
    create_parser.add_argument('--data', type=str, help='JSON data string')
    create_parser.add_argument('--data-file', type=str, help='JSON data file')
    
    # Send command
    send_parser = subparsers.add_parser('send', help='Send PDF via email')
    send_parser.add_argument('--pdf', required=True, help='PDF path')
    send_parser.add_argument('--to', required=True, help='Recipient email')
    send_parser.add_argument('--subject', required=True, help='Email subject')
    send_parser.add_argument('--body', required=True, help='Email body')
    send_parser.add_argument('--from', dest='from_email', default='bookings@partyfavorphoto.com')
    
    args = parser.parse_args()
    
    if args.command == 'create':
        # Load data
        if args.data:
            data = json.loads(args.data)
        elif args.data_file:
            with open(args.data_file) as f:
                data = json.load(f)
        else:
            data = {}
        
        # Create PDF
        if args.type == 'contract':
            path = create_contract(data, args.output)
        elif args.type == 'invoice':
            path = create_invoice(data, args.output)
        else:
            print(f"Unknown type: {args.type}")
            sys.exit(1)
        
        print(f"Created: {path}")
        
    elif args.command == 'send':
        result = send_pdf(args.pdf, args.to, args.subject, args.body, args.from_email)
        print(f"Email status: {result.get('status')}")
    
    else:
        parser.print_help()
        sys.exit(1)

if __name__ == '__main__':
    main()
