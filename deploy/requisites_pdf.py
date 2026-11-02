#!/usr/bin/env python3
# Генерация PDF с реквизитами. Вызывается сервером: читает JSON из stdin, пишет PDF в stdout.
import sys, json
from fpdf import FPDF

FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'
BOLD = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'

data = json.load(sys.stdin)
pdf = FPDF(format='A4')
pdf.set_auto_page_break(auto=True, margin=18)
pdf.add_page()
pdf.add_font('DV', '', FONT)
pdf.add_font('DV', 'B', BOLD)

pdf.set_font('DV', 'B', 15)
pdf.multi_cell(0, 8, data.get('title', 'Реквизиты'))
pdf.ln(2)
pdf.set_font('DV', '', 10)
pdf.set_text_color(90, 100, 115)
pdf.multi_cell(0, 5, 'Реквизиты для оплаты, договоров и актов')
pdf.set_text_color(20, 30, 45)
pdf.ln(4)

pdf.set_draw_color(220, 225, 232)
for label, value in data.get('rows', []):
    y = pdf.get_y()
    pdf.set_font('DV', '', 9)
    pdf.set_text_color(100, 110, 125)
    pdf.set_xy(12, y)
    pdf.multi_cell(62, 5.5, label)
    yl = pdf.get_y()
    pdf.set_font('DV', '', 10.5)
    pdf.set_text_color(20, 30, 45)
    pdf.set_xy(78, y)
    pdf.multi_cell(0, 5.5, value)
    y2 = max(yl, pdf.get_y()) + 2
    pdf.line(12, y2, 198, y2)
    pdf.set_y(y2 + 2)

pdf.ln(6)
pdf.set_font('DV', '', 8)
pdf.set_text_color(120, 130, 145)
pdf.multi_cell(0, 4.5, data.get('footer', ''))

sys.stdout.buffer.write(pdf.output())
