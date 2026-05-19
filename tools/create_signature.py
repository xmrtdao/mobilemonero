#!/usr/bin/env python3
"""Create signature image for Joe Lee"""
from fpdf import FPDF

# Create signature
pdf = FPDF()
pdf.add_page()
pdf.set_font('Helvetica', 'B', 24)
pdf.cell(0, 20, 'Joseph Andrew Lee', 0, 1, 'C')
pdf.set_font('Helvetica', 'I', 14)
pdf.cell(0, 15, 'Party Favor Photo', 0, 1, 'C')
pdf.output('/data/data/com.termux/files/home/mobilemonero/signature.pdf')

print("Created: ~/mobilemonero/signature.pdf")
