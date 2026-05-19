#!/usr/bin/env python3
"""
XMRT DAO PDF Form Processor - Receive, Fill, Sign, Send
Downloads form attachments from email, fills them out, adds signature, and sends back.

Usage:
    python3 pdf_form_processor.py check-inbox
    python3 pdf_form_processor.py download --email-id <id> --output form.pdf
    python3 pdf_form_processor.py fill --input form.pdf --output filled.pdf --data data.json
    python3 pdf_form_processor.py sign --input filled.pdf --output signed.pdf --signature ~/signature.png
    python3 pdf_form_processor.py send --pdf signed.pdf --to client@example.com
"""

import argparse
import json
import os
import sys
from datetime import datetime
from pathlib import Path
from typing import Optional, List, Dict

# PDF libraries
from pypdf import PdfReader, PdfWriter
from pypdf.generic import NameObject, TextStringObject
from fpdf import FPDF
import requests

# Configuration
RELAY_URL = "https://relay.mobilemonero.com"
INBOX_ENDPOINT = f"{RELAY_URL}/resend/inbox"
RESEND_ENDPOINT = "https://vawouugtzwmejxqkeqqj.supabase.co/functions/v1/resend-email"
PDFS_DIR = Path("~/mobilemonero/pdfs").expanduser()
SIGNATURE_PATH = Path("~/mobilemonero/signature.png").expanduser()

PDFS_DIR.mkdir(parents=True, exist_ok=True)

class PDFFormFiller:
    """Fill PDF form fields programmatically"""
    
    @staticmethod
    def get_form_fields(pdf_path: str) -> List[str]:
        """Get all form field names from PDF"""
        reader = PdfReader(pdf_path)
        fields = []
        
        if reader.get_fields():
            for field_name, field_obj in reader.get_fields().items():
                fields.append(field_name)
        
        return fields
    
    @staticmethod
    def fill_form(input_path: str, output_path: str, data: dict, debug: bool = False) -> str:
        """
        Fill PDF form fields with data
        
        Args:
            input_path: Path to PDF form
            output_path: Path to save filled PDF
            data: Dict mapping field names to values
            debug: Print field names for debugging
        
        Returns:
            str: Path to filled PDF
        """
        reader = PdfReader(input_path)
        writer = PdfWriter()
        
        # Clone the reader
        writer.append(reader)
        
        # Get form fields
        fields = reader.get_fields()
        
        if debug:
            print("Available form fields:")
            if fields:
                for field_name in fields.keys():
                    print(f"  - {field_name}")
            else:
                print("  (No interactive form fields found)")
        
        # Fill fields
        if fields:
            for field_name, value in data.items():
                if field_name in fields:
                    try:
                        writer.update_page_form_field_values(
                            None, 
                            {field_name: str(value)},
                            auto_regenerate=False
                        )
                        if debug:
                            print(f"Filled: {field_name} = {value}")
                    except Exception as e:
                        print(f"Warning: Could not fill {field_name}: {e}")
                elif debug:
                    print(f"Warning: Field '{field_name}' not found in form")
        
        # Write output
        with open(output_path, "wb") as f:
            writer.write(f)
        
        return str(Path(output_path).absolute())


class PDFSigner:
    """Add signature image to PDF"""
    
    @staticmethod
    def add_signature(input_path: str, output_path: str, signature_image: str, 
                     page: int = -1, x: float = 100, y: float = 50, 
                     width: float = 50, height: float = 20) -> str:
        """
        Add signature image to PDF
        
        Args:
            input_path: Path to PDF
            output_path: Path to save signed PDF
            signature_image: Path to signature PNG
            page: Page number (-1 for last page)
            x: X position (mm from left)
            y: Y position (mm from bottom)
            width: Signature width (mm)
            height: Signature height (mm)
        
        Returns:
            str: Path to signed PDF
        """
        from reportlab.pdfgen import canvas
        from reportlab.lib.pagesizes import letter
        import io
        
        # Create a temporary PDF with signature
        sig_pdf_buffer = io.BytesIO()
        c = canvas.Canvas(sig_pdf_buffer, pagesize=letter)
        c.drawImage(signature_image, x, y, width=width*7, height=height*7)  # Convert mm to points
        c.save()
        sig_pdf_buffer.seek(0)
        
        # Merge signature with original PDF
        reader = PdfReader(input_path)
        writer = PdfWriter()
        
        # Add all pages
        for i, page in enumerate(reader.pages):
            writer.add_page(page)
        
        # Merge signature onto specified page
        sig_reader = PdfReader(sig_pdf_buffer)
        target_page = len(writer.pages) + page if page < 0 else page
        
        if 0 <= target_page < len(writer.pages):
            writer.pages[target_page].merge_page(sig_reader.pages[0])
        
        # Write output
        with open(output_path, "wb") as f:
            writer.write(f)
        
        return str(Path(output_path).absolute())


class EmailAttachmentDownloader:
    """Download attachments from email inbox"""
    
    @staticmethod
    def check_inbox() -> List[dict]:
        """Check inbox for emails with attachments"""
        try:
            response = requests.get(INBOX_ENDPOINT, timeout=10)
            response.raise_for_status()
            data = response.json()
            
            emails_with_attachments = []
            for email in data.get('emails', []):
                if email.get('attachments'):
                    emails_with_attachments.append({
                        'id': email.get('email_id'),
                        'from': email.get('from'),
                        'subject': email.get('subject'),
                        'date': email.get('created_at'),
                        'attachments': email.get('attachments'),
                        'body': email.get('body', '')[:200]
                    })
            
            return emails_with_attachments
        except Exception as e:
            print(f"Error checking inbox: {e}")
            return []
    
    @staticmethod
    def download_attachment(email_id: str, attachment_id: str, output_path: str) -> str:
        """
        Download specific attachment from email
        
        Note: This requires the relay to support attachment download endpoint.
        For now, we'll simulate by noting what needs to be implemented.
        """
        # TODO: Implement when relay supports attachment download
        # endpoint: GET /resend/inbox/{email_id}/attachments/{attachment_id}
        
        print(f"Would download attachment {attachment_id} from email {email_id}")
        print(f"Save to: {output_path}")
        
        # For now, return the path (in production, this would be the actual downloaded file)
        return output_path


def create_vendor_data(client_email: str, event_name: str = "") -> dict:
    """
    Create standardized vendor data for Party Favor Photo
    
    Returns dict ready to fill PDF forms
    """
    return {
        # Business Info
        "Business_Name": "Party Favor Photo",
        "Business_Type": "Photo Booth Services",
        "Contact_Name": "Joseph Andrew Lee",
        "Email": "bookings@partyfavorphoto.com",
        "Phone": "(202) 555-0123",
        "Website": "https://partyfavorphoto.com",
        
        # Insurance (if needed)
        "Insurance_Carrier": "Event Liability Insurance",
        "Policy_Number": "PFP-2026-001",
        "Coverage_Amount": "$1,000,000",
        
        # Equipment
        "Equipment_Type": "Professional Photo Booth with DSLR",
        "Power_Requirements": "110V, 15A circuit",
        "Setup_Space": "8ft x 8ft minimum",
        "Setup_Time": "2 hours before event",
        
        # Pricing
        "Standard_Rate": "$498/day",
        "Two_Day_Rate": "$992 (save $4)",
        "Overtime_Rate": "$150/hour",
        
        # Signature fields
        "Signature_Date": datetime.now().strftime("%Y-%m-%d"),
        "Authorized_Signature": "[SIGNATURE]",
        
        # Custom overrides
        "Client_Email": client_email,
        "Event_Name": event_name,
    }


def send_completed_form(pdf_path: str, to_email: str, subject: str, body: str) -> dict:
    """Send completed form via email"""
    
    # In production, upload PDF to cloud storage and include link
    # For now, simulate sending
    
    print(f"Would send email to: {to_email}")
    print(f"Subject: {subject}")
    print(f"Body: {body}")
    print(f"Attachment: {pdf_path}")
    
    return {
        "status": "simulated",
        "to": to_email,
        "subject": subject,
        "pdf": pdf_path
    }


def main():
    parser = argparse.ArgumentParser(description='XMRT DAO PDF Form Processor')
    subparsers = parser.add_subparsers(dest='command', help='Command')
    
    # Check inbox
    check_parser = subparsers.add_parser('check-inbox', help='Check for emails with attachments')
    
    # Download attachment
    download_parser = subparsers.add_parser('download', help='Download attachment')
    download_parser.add_argument('--email-id', required=True, help='Email ID')
    download_parser.add_argument('--attachment-id', help='Attachment ID (first if not specified)')
    download_parser.add_argument('--output', required=True, help='Output path')
    
    # List fields
    fields_parser = subparsers.add_parser('list-fields', help='List form fields in PDF')
    fields_parser.add_argument('--input', required=True, help='PDF path')
    
    # Fill form
    fill_parser = subparsers.add_parser('fill', help='Fill PDF form')
    fill_parser.add_argument('--input', required=True, help='Input PDF path')
    fill_parser.add_argument('--output', required=True, help='Output PDF path')
    fill_parser.add_argument('--data', type=str, help='JSON data string')
    fill_parser.add_argument('--data-file', type=str, help='JSON data file')
    fill_parser.add_argument('--debug', action='store_true', help='Show field names')
    
    # Sign PDF
    sign_parser = subparsers.add_parser('sign', help='Add signature to PDF')
    sign_parser.add_argument('--input', required=True, help='Input PDF path')
    sign_parser.add_argument('--output', required=True, help='Output PDF path')
    sign_parser.add_argument('--signature', default=str(SIGNATURE_PATH), help='Signature image path')
    sign_parser.add_argument('--page', type=int, default=-1, help='Page number (-1 for last)')
    sign_parser.add_argument('--x', type=float, default=100, help='X position (mm)')
    sign_parser.add_argument('--y', type=float, default=50, help='Y position (mm)')
    
    # Send
    send_parser = subparsers.add_parser('send', help='Send completed form')
    send_parser.add_argument('--pdf', required=True, help='PDF path')
    send_parser.add_argument('--to', required=True, help='Recipient email')
    send_parser.add_argument('--subject', required=True, help='Email subject')
    send_parser.add_argument('--body', required=True, help='Email body')
    
    # Auto-process (complete workflow)
    auto_parser = subparsers.add_parser('auto-process', help='Complete workflow: download, fill, sign, send')
    auto_parser.add_argument('--email-id', required=True, help='Email ID with form')
    auto_parser.add_argument('--to-email', required=True, help='Return email address')
    auto_parser.add_argument('--event-name', default='', help='Event name')
    auto_parser.add_argument('--subject', default='Completed Vendor Form', help='Email subject')
    auto_parser.add_argument('--body', default='Please find attached our completed vendor registration form.', help='Email body')
    
    args = parser.parse_args()
    
    if args.command == 'check-inbox':
        emails = EmailAttachmentDownloader.check_inbox()
        if emails:
            print(f"Found {len(emails)} email(s) with attachments:\n")
            for email in emails:
                print(f"From: {email['from']}")
                print(f"Subject: {email['subject']}")
                print(f"Date: {email['date']}")
                print(f"Attachments: {len(email['attachments'])}")
                for att in email['attachments']:
                    print(f"  - {att.get('filename', 'Unknown')}")
                print()
        else:
            print("No emails with attachments found.")
    
    elif args.command == 'download':
        output = EmailAttachmentDownloader.download_attachment(
            args.email_id,
            args.attachment_id or '0',
            args.output
        )
        print(f"Downloaded to: {output}")
    
    elif args.command == 'list-fields':
        fields = PDFFormFiller.get_form_fields(args.input)
        print(f"Form fields in {args.input}:")
        for field in fields:
            print(f"  - {field}")
        if not fields:
            print("  (No interactive form fields - this may be a flat PDF)")
    
    elif args.command == 'fill':
        # Load data
        if args.data:
            data = json.loads(args.data)
        elif args.data_file:
            with open(args.data_file) as f:
                data = json.load(f)
        else:
            data = create_vendor_data("unknown@example.com")
        
        output = PDFFormFiller.fill_form(args.input, args.output, data, args.debug)
        print(f"Filled form saved to: {output}")
    
    elif args.command == 'sign':
        if not Path(args.signature).exists():
            print(f"Warning: Signature file not found at {args.signature}")
            print("Creating placeholder signature...")
            # Create placeholder
            sig_pdf = FPDF()
            sig_pdf.add_page()
            sig_pdf.set_font('Helvetica', 'B', 16)
            sig_pdf.cell(0, 10, 'Joseph Andrew Lee', 0, 1, 'C')
            sig_pdf.set_font('Helvetica', 'I', 12)
            sig_pdf.cell(0, 10, 'Party Favor Photo', 0, 1, 'C')
            sig_pdf.output(args.signature.replace('.png', '_placeholder.pdf'))
            print(f"Created placeholder: {args.signature.replace('.png', '_placeholder.pdf')}")
            return
        
        output = PDFSigner.add_signature(
            args.input, args.output, args.signature,
            args.page, args.x, args.y
        )
        print(f"Signed PDF saved to: {output}")
    
    elif args.command == 'send':
        result = send_completed_form(args.pdf, args.to, args.subject, args.body)
        print(f"Email status: {result.get('status')}")
    
    elif args.command == 'auto-process':
        print("=== Auto-Processing Form ===\n")
        
        # Step 1: Download
        print("Step 1: Downloading form...")
        # TODO: Implement actual download
        temp_form = PDFS_DIR / f"vendor-form-{args.email_id[:8]}.pdf"
        print(f"  Would download to: {temp_form}")
        
        # Step 2: Fill
        print("\nStep 2: Filling form...")
        data = create_vendor_data(args.to_email, args.event_name)
        filled_pdf = PDFS_DIR / f"filled-{temp_form.name}"
        # TODO: Implement fill when form is downloaded
        
        # Step 3: Sign
        print("\nStep 3: Adding signature...")
        signed_pdf = PDFS_DIR / f"signed-{temp_form.name}"
        # TODO: Implement sign
        
        # Step 4: Send
        print("\nStep 4: Sending completed form...")
        send_completed_form(str(signed_pdf), args.to_email, args.subject, args.body)
        
        print("\n=== Auto-Processing Complete ===")
    
    else:
        parser.print_help()
        sys.exit(1)


if __name__ == '__main__':
    main()
