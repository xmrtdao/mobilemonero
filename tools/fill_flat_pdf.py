#!/usr/bin/env python3
"""
Fill flat PDF forms by overlaying text at specific positions
Works with forms that don't have interactive fields
"""

from reportlab.pdfgen import canvas
from reportlab.lib.pagesizes import letter
from pypdf import PdfReader, PdfWriter
import io
import json

# Field positions for vendor form (x, y in points from bottom-left)
# Calculated from create_sample_form.py - these match the rect() positions
VENDOR_FORM_FIELDS = {
    "Business_Name": (155, 637),      # y=642-5
    "Business_Type": (155, 602),      # y=607-5
    "Contact_Name": (155, 567),       # y=572-5
    "Email": (155, 532),              # y=537-5
    "Phone": (155, 497),              # y=502-5
    "Website": (155, 462),            # y=467-5
    "Insurance_Carrier": (155, 407),  # y=412-5
    "Policy_Number": (155, 372),      # y=377-5
    "Coverage_Amount": (155, 337),    # y=342-5
    "Equipment_Type": (155, 277),     # y=282-5
    "Power_Requirements": (155, 242), # y=247-5
    "Setup_Space": (155, 207),        # y=212-5
    "Setup_Time": (155, 172),         # y=177-5
    "Standard_Rate": (155, 112),      # y=117-5
    "Two_Day_Rate": (155, 77),        # y=82-5
    "Overtime_Rate": (155, 42),       # y=47-5
    "Signature_Date": (105, 45),      # Signature line date
    "Authorized_Signature": (205, 108), # Signature line
}

def fill_flat_pdf(input_path: str, output_path: str, data: dict, signature_path: str = None) -> str:
    """
    Fill a flat PDF form by overlaying text
    
    Args:
        input_path: Path to blank PDF form
        output_path: Path to save filled PDF
        data: Dict of field values
        signature_path: Optional path to signature image
    
    Returns:
        str: Path to filled PDF
    """
    # Read original PDF
    reader = PdfReader(input_path)
    writer = PdfWriter()
    
    # Create overlay with filled data
    overlay_buffer = io.BytesIO()
    c = canvas.Canvas(overlay_buffer, pagesize=letter)
    width, height = letter
    
    c.setFont("Helvetica", 10)
    
    # Fill each field
    for field_name, value in data.items():
        if field_name in VENDOR_FORM_FIELDS:
            x, y = VENDOR_FORM_FIELDS[field_name]
            # Convert from top-left to bottom-left coordinate system
            y_from_bottom = y
            c.drawString(x, y_from_bottom, str(value))
            print(f"✓ Filled: {field_name} = {value}")
    
    # Add signature if provided or use text
    if signature_path and "Signature_Date" in data:
        # Draw signature text
        c.setFont("Helvetica-Bold", 12)
        c.drawString(205, 108, "Joseph Andrew Lee")
        c.setFont("Helvetica-Oblique", 9)
        c.drawString(205, 98, "Party Favor Photo")
        print(f"✓ Added signature: Joseph Andrew Lee")
    
    # Add date
    if "Signature_Date" in data:
        c.setFont("Helvetica", 10)
        c.drawString(105, 45, data["Signature_Date"])
        print(f"✓ Added date: {data['Signature_Date']}")
    else:
        from datetime import datetime
        today = datetime.now().strftime("%Y-%m-%d")
        c.setFont("Helvetica", 10)
        c.drawString(105, 45, today)
        print(f"✓ Added date: {today}")
    
    c.save()
    overlay_buffer.seek(0)
    
    # Merge overlay with original
    overlay_reader = PdfReader(overlay_buffer)
    
    for i, page in enumerate(reader.pages):
        if i < len(overlay_reader.pages):
            page.merge_page(overlay_reader.pages[i])
        writer.add_page(page)
    
    # Write output
    with open(output_path, "wb") as f:
        writer.write(f)
    
    return output_path

if __name__ == '__main__':
    import sys
    
    if len(sys.argv) < 4:
        print("Usage: fill_flat_pdf.py <input.pdf> <output.pdf> <data.json> [signature.pdf]")
        sys.exit(1)
    
    input_pdf = sys.argv[1]
    output_pdf = sys.argv[2]
    data_file = sys.argv[3]
    signature = sys.argv[4] if len(sys.argv) > 4 else None
    
    with open(data_file) as f:
        data = json.load(f)
    
    fill_flat_pdf(input_pdf, output_pdf, data, signature)
    print(f"\n✓ Completed: {output_pdf}")
