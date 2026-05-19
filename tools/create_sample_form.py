#!/usr/bin/env python3
"""Create a sample vendor registration form for testing"""
from reportlab.lib.pagesizes import letter
from reportlab.lib import colors
from reportlab.platypus import SimpleDocTemplate, Table, TableStyle, Paragraph, Spacer, PageTemplate, Frame
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import inch
from reportlab.pdfgen import canvas

def create_vendor_form(output_path):
    """Create a sample festival vendor registration form"""
    
    # Create PDF with form fields
    c = canvas.Canvas(output_path, pagesize=letter)
    width, height = letter
    
    # Header
    c.setFont("Helvetica-Bold", 20)
    c.drawCentredString(width/2, height - 50, "FESTIVAL VENDOR REGISTRATION FORM")
    
    c.setFont("Helvetica", 12)
    c.drawString(50, height - 80, "Please complete all fields and return with payment.")
    
    # Section 1: Business Information
    c.setFont("Helvetica-Bold", 14)
    c.drawString(50, height - 120, "SECTION 1: BUSINESS INFORMATION")
    
    c.setLineWidth(2)
    c.line(50, height - 125, width - 50, height - 125)
    
    c.setFont("Helvetica", 11)
    y = height - 150
    
    # Business Name field
    c.drawString(50, y, "Business Name:")
    c.rect(150, y - 5, 400, 20, stroke=1, fill=0)
    y -= 35
    
    # Business Type
    c.drawString(50, y, "Business Type:")
    c.rect(150, y - 5, 400, 20, stroke=1, fill=0)
    y -= 35
    
    # Contact Name
    c.drawString(50, y, "Contact Name:")
    c.rect(150, y - 5, 400, 20, stroke=1, fill=0)
    y -= 35
    
    # Email
    c.drawString(50, y, "Email:")
    c.rect(150, y - 5, 400, 20, stroke=1, fill=0)
    y -= 35
    
    # Phone
    c.drawString(50, y, "Phone:")
    c.rect(150, y - 5, 400, 20, stroke=1, fill=0)
    y -= 35
    
    # Website
    c.drawString(50, y, "Website:")
    c.rect(150, y - 5, 400, 20, stroke=1, fill=0)
    y -= 50
    
    # Section 2: Insurance Information
    c.setFont("Helvetica-Bold", 14)
    c.drawString(50, y, "SECTION 2: INSURANCE INFORMATION")
    
    c.setLineWidth(2)
    c.line(50, y - 5, width - 50, y - 5)
    
    y -= 30
    c.setFont("Helvetica", 11)
    
    # Insurance Carrier
    c.drawString(50, y, "Insurance Carrier:")
    c.rect(150, y - 5, 400, 20, stroke=1, fill=0)
    y -= 35
    
    # Policy Number
    c.drawString(50, y, "Policy Number:")
    c.rect(150, y - 5, 400, 20, stroke=1, fill=0)
    y -= 35
    
    # Coverage Amount
    c.drawString(50, y, "Coverage Amount:")
    c.rect(150, y - 5, 400, 20, stroke=1, fill=0)
    y -= 50
    
    # Section 3: Equipment & Requirements
    c.setFont("Helvetica-Bold", 14)
    c.drawString(50, y, "SECTION 3: EQUIPMENT & REQUIREMENTS")
    
    c.setLineWidth(2)
    c.line(50, y - 5, width - 50, y - 5)
    
    y -= 30
    c.setFont("Helvetica", 11)
    
    # Equipment Type
    c.drawString(50, y, "Equipment Type:")
    c.rect(150, y - 5, 400, 20, stroke=1, fill=0)
    y -= 35
    
    # Power Requirements
    c.drawString(50, y, "Power Requirements:")
    c.rect(150, y - 5, 400, 20, stroke=1, fill=0)
    y -= 35
    
    # Setup Space
    c.drawString(50, y, "Setup Space Needed:")
    c.rect(150, y - 5, 400, 20, stroke=1, fill=0)
    y -= 35
    
    # Setup Time
    c.drawString(50, y, "Setup Time Required:")
    c.rect(150, y - 5, 400, 20, stroke=1, fill=0)
    y -= 50
    
    # Section 4: Pricing
    c.setFont("Helvetica-Bold", 14)
    c.drawString(50, y, "SECTION 4: PRICING")
    
    c.setLineWidth(2)
    c.line(50, y - 5, width - 50, y - 5)
    
    y -= 30
    c.setFont("Helvetica", 11)
    
    # Standard Rate
    c.drawString(50, y, "Standard Rate:")
    c.rect(150, y - 5, 200, 20, stroke=1, fill=0)
    y -= 35
    
    # Two-Day Rate
    c.drawString(50, y, "Two-Day Rate:")
    c.rect(150, y - 5, 200, 20, stroke=1, fill=0)
    y -= 35
    
    # Overtime Rate
    c.drawString(50, y, "Overtime Rate:")
    c.rect(150, y - 5, 200, 20, stroke=1, fill=0)
    y -= 50
    
    # Section 5: Signatures
    c.setFont("Helvetica-Bold", 14)
    c.drawString(50, y, "SECTION 5: SIGNATURES")
    
    c.setLineWidth(2)
    c.line(50, y - 5, width - 50, y - 5)
    
    y -= 40
    c.setFont("Helvetica", 11)
    
    # Signature line
    c.drawString(50, y, "Authorized Signature:")
    c.line(200, y - 5, 500, y - 5)
    y -= 30
    
    # Date
    c.drawString(50, y, "Date:")
    c.line(100, y - 5, 300, y - 5)
    y -= 40
    
    # Footer
    c.setFont("Helvetica-Oblique", 9)
    c.drawCentredString(width/2, 50, "Thank you for your vendor application! We will review and respond within 5 business days.")
    
    c.save()
    print(f"Created vendor form: {output_path}")

if __name__ == '__main__':
    create_vendor_form('/data/data/com.termux/files/home/mobilemonero/pdfs/sample-vendor-form.pdf')
