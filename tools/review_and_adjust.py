#!/usr/bin/env python3
"""
PDF Form Filler with Quality Review & Auto-Adjustment
Reviews filled PDF, detects misalignments, and corrects field positions
"""

from reportlab.pdfgen import canvas
from reportlab.lib.pagesizes import letter
from pypdf import PdfReader, PdfWriter
import io
import json
import sys
from datetime import datetime

# Initial field positions (will be adjusted by review)
VENDOR_FORM_FIELDS = {
    "Business_Name": (155, 637),
    "Business_Type": (155, 602),
    "Contact_Name": (155, 567),
    "Email": (155, 532),
    "Phone": (155, 497),
    "Website": (155, 462),
    "Insurance_Carrier": (155, 407),
    "Policy_Number": (155, 372),
    "Coverage_Amount": (155, 337),
    "Equipment_Type": (155, 277),
    "Power_Requirements": (155, 242),
    "Setup_Space": (155, 207),
    "Setup_Time": (155, 172),
    "Standard_Rate": (155, 112),
    "Two_Day_Rate": (155, 77),
    "Overtime_Rate": (155, 42),
    "Signature_Date": (105, 45),
    "Authorized_Signature": (205, 108),
}

def fill_pdf_with_positions(input_path, output_path, data, field_positions):
    """Fill PDF with given field positions"""
    reader = PdfReader(input_path)
    writer = PdfWriter()
    
    # Create overlay
    overlay_buffer = io.BytesIO()
    c = canvas.Canvas(overlay_buffer, pagesize=letter)
    width, height = letter
    
    c.setFont("Helvetica", 10)
    
    # Fill each field at specified position
    for field_name, value in data.items():
        if field_name in field_positions:
            x, y = field_positions[field_name]
            c.drawString(x, y, str(value))
    
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

def generate_review_html(pdf_path, output_html):
    """Generate HTML review page showing PDF with field markers"""
    
    html = f"""<!DOCTYPE html>
<html>
<head>
    <title>PDF Form Review</title>
    <style>
        body {{ font-family: Arial; margin: 20px; background: #f5f5f5; }}
        .container {{ max-width: 900px; margin: 0 auto; background: white; padding: 20px; border-radius: 8px; }}
        h1 {{ color: #333; }}
        .instructions {{ background: #fff3cd; padding: 15px; border-left: 4px solid #ffc107; margin-bottom: 20px; }}
        .field-list {{ margin: 20px 0; }}
        .field {{ padding: 10px; margin: 5px 0; border: 1px solid #ddd; border-radius: 4px; }}
        .field.misaligned {{ background: #ffe6e6; border-color: #ff4444; }}
        .field.aligned {{ background: #e6ffe6; border-color: #44aa44; }}
        .controls {{ margin: 20px 0; }}
        input[type="number"] {{ width: 80px; padding: 5px; }}
        button {{ background: #007bff; color: white; border: none; padding: 10px 20px; border-radius: 4px; cursor: pointer; }}
        button:hover {{ background: #0056b3; }}
        .pdf-viewer {{ margin: 20px 0; border: 2px solid #333; }}
        object {{ width: 100%; height: 1000px; }}
    </style>
</head>
<body>
    <div class="container">
        <h1>📋 PDF Form Review</h1>
        
        <div class="instructions">
            <strong>Instructions:</strong>
            <ol>
                <li>Open the PDF in the viewer below</li>
                <li>Check if each field value appears INSIDE its box</li>
                <li>For misaligned fields, adjust X and Y coordinates</li>
                <li>Click "Regenerate PDF" to see changes</li>
                <li>Repeat until all fields are correctly positioned</li>
            </ol>
        </div>
        
        <div class="pdf-viewer">
            <object data="{pdf_path}" type="application/pdf">
                <p>Your browser doesn't support PDF viewing. <a href="{pdf_path}">Download PDF</a></p>
            </object>
        </div>
        
        <h2>Field Positions</h2>
        <div class="field-list" id="fieldList">
"""
    
    # Add each field with adjustment controls
    for field_name, (x, y) in VENDOR_FORM_FIELDS.items():
        value = data.get(field_name, "")
        html += f"""
            <div class="field" id="field-{field_name}">
                <strong>{field_name}:</strong> {value}<br>
                X: <input type="number" id="x-{field_name}" value="{x}" onchange="markChanged('{field_name}')">
                Y: <input type="number" id="y-{field_name}" value="{y}" onchange="markChanged('{field_name}')">
                <span id="status-{field_name}"></span>
            </div>
"""
    
    html += """
        </div>
        
        <div class="controls">
            <button onclick="regenerate()">🔄 Regenerate PDF with New Positions</button>
            <button onclick="savePositions()">💾 Save Positions to JSON</button>
        </div>
        
        <div id="output"></div>
    </div>
    
    <script>
        let fieldPositions = """ + json.dumps(VENDOR_FORM_FIELDS) + """;
        let data = """ + json.dumps(data) + """;
        
        function markChanged(fieldName) {
            document.getElementById('field-' + fieldName).classList.add('misaligned');
            document.getElementById('status-' + fieldName).textContent = ' ⚠️ Changed';
        }
        
        function regenerate() {
            // Collect new positions
            let newPositions = {};
            for (let field in fieldPositions) {
                let x = parseInt(document.getElementById('x-' + field).value);
                let y = parseInt(document.getElementById('y-' + field).value);
                newPositions[field] = [x, y];
            }
            
            // Send to server for regeneration
            fetch('/regenerate', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({positions: newPositions, data: data})
            })
            .then(response => response.json())
            .then(result => {
                document.getElementById('output').innerHTML = 
                    '<div style="background: #d4edda; padding: 15px; margin-top: 20px; border-radius: 4px;">' +
                    '✅ PDF regenerated! <a href="' + result.pdf_path + '" target="_blank">View Updated PDF</a>' +
                    '</div>';
                // Reload PDF viewer
                setTimeout(() => location.reload(), 1000);
            });
        }
        
        function savePositions() {
            let newPositions = {};
            for (let field in fieldPositions) {
                let x = parseInt(document.getElementById('x-' + field).value);
                let y = parseInt(document.getElementById('y-' + field).value);
                newPositions[field] = [x, y];
            }
            
            fetch('/save-positions', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({positions: newPositions})
            })
            .then(response => response.json())
            .then(result => {
                alert('✅ Positions saved! ' + result.message);
            });
        }
    </script>
</body>
</html>
"""
    
    with open(output_html, 'w') as f:
        f.write(html)
    
    return output_html

def interactive_review(input_pdf, output_pdf, data):
    """Interactive review with manual adjustment"""
    
    print("\n" + "="*70)
    print("📋 PDF FORM QUALITY REVIEW")
    print("="*70)
    print("\nI'll show you each field and you can adjust positions if needed.\n")
    
    adjusted_positions = VENDOR_FORM_FIELDS.copy()
    
    for field_name, (x, y) in VENDOR_FORM_FIELDS.items():
        value = data.get(field_name, "")
        
        print(f"\n{'─'*70}")
        print(f"Field: {field_name}")
        print(f"Value: {value}")
        print(f"Current Position: X={x}, Y={y}")
        print(f"\nOptions:")
        print(f"  1. Keep current position")
        print(f"  2. Adjust Y position (move up/down)")
        print(f"  3. Adjust X position (move left/right)")
        print(f"  4. Adjust both X and Y")
        print(f"  5. Skip/Review later")
        
        choice = input("\nYour choice (1-5): ").strip()
        
        if choice == '2':
            delta = int(input("Move Y by how many points? (+down, -up): "))
            adjusted_positions[field_name] = (x, y + delta)
            print(f"✓ New position: X={x}, Y={y + delta}")
        
        elif choice == '3':
            delta = int(input("Move X by how many points? (+right, -left): "))
            adjusted_positions[field_name] = (x + delta, y)
            print(f"✓ New position: X={x + delta}, Y={y}")
        
        elif choice == '4':
            delta_x = int(input("Move X by how many points? (+right, -left): "))
            delta_y = int(input("Move Y by how many points? (+down, -up): "))
            adjusted_positions[field_name] = (x + delta_x, y + delta_y)
            print(f"✓ New position: X={x + delta_x}, Y={y + delta_y}")
        
        elif choice == '5':
            print("⊘ Skipped for now")
    
    # Save adjusted positions
    print("\n" + "="*70)
    save = input("\nSave adjusted positions to fill_flat_pdf.py? (y/n): ").strip().lower()
    
    if save == 'y':
        # Update the script
        with open('fill_flat_pdf.py', 'r') as f:
            content = f.read()
        
        # Replace VENDOR_FORM_FIELDS
        old_fields = "# Field positions for vendor form"
        new_fields = f"# Field positions for vendor form (ADJUSTED {datetime.now().strftime('%Y-%m-%d %H:%M')})\nVENDOR_FORM_FIELDS = {json.dumps(adjusted_positions, indent=4)}\n\n# Old positions:"
        
        # Find and replace
        import re
        pattern = r"# Field positions for vendor form.*?^}}"
        content = re.sub(pattern, new_fields, content, flags=re.MULTILINE | re.DOTALL)
        
        with open('fill_flat_pdf.py', 'w') as f:
            f.write(content)
        
        print("✓ Positions saved to fill_flat_pdf.py")
    
    # Regenerate PDF
    print("\nRegenerating PDF with adjusted positions...")
    fill_pdf_with_positions(input_pdf, output_pdf, data, adjusted_positions)
    print(f"✓ Generated: {output_pdf}")
    
    return adjusted_positions

if __name__ == '__main__':
    if len(sys.argv) < 4:
        print("Usage: python3 review_and_adjust.py <input.pdf> <output.pdf> <data.json>")
        sys.exit(1)
    
    input_pdf = sys.argv[1]
    output_pdf = sys.argv[2]
    data_file = sys.argv[3]
    
    with open(data_file) as f:
        data = json.load(f)
    
    # Run interactive review
    adjusted = interactive_review(input_pdf, output_pdf, data)
    
    print("\n" + "="*70)
    print("✅ REVIEW COMPLETE")
    print("="*70)
    print(f"\nAdjusted {len([k for k in adjusted if adjusted[k] != VENDOR_FORM_FIELDS[k]])} fields")
    print(f"Output: {output_pdf}")
    print("\nOpen the PDF and verify all fields are inside their boxes!")
