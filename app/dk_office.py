# -*- coding: utf-8 -*-
"""生成 Word（.docx）與 Excel（.xlsx）文件。只用標準庫（zipfile），寫最小而合規的 Office Open XML。

docx(blocks)：
  {"t": "h", "level": 1-3, "text": str}
  {"t": "p", "runs": [run, ...], "size": 點數?, "indent": 縮進字數?}
  {"t": "table", "widths": [相對寬度...], "header": [單元格...], "rows": [[單元格...]...]}
  單元格 = 字串 或 [run, ...]
  run = 字串 或 {"text": str, "hl": same|a|b|focus|lem|sup|muted|gra, "b": 粗體}
xlsx(sheets)：
  [{"name": str, "header": [str...], "widths": [字符寬...], "rows": [[str|數字...]...]}]
"""
import io
import re
import zipfile
from xml.sax.saxutils import escape

W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
_BAD = re.compile("[\x00-\x08\x0b\x0c\x0e-\x1f￾￿]")


def _x(s):
    return escape(_BAD.sub("", str(s)))


# ================================================================ Word
_HL = {
    "same": '<w:shd w:val="clear" w:color="auto" w:fill="DDEFE2"/>',
    "a": '<w:shd w:val="clear" w:color="auto" w:fill="F8E3B0"/>',
    "b": '<w:shd w:val="clear" w:color="auto" w:fill="D9E4F8"/>',
    "focus": '<w:u w:val="thick" w:color="C98A12"/>',
    "lem": '<w:u w:val="single" w:color="B5402B"/>',
    "sup": '<w:color w:val="B5402B"/><w:vertAlign w:val="superscript"/>',
    "muted": '<w:color w:val="8A8278"/>',
    "gra": '<w:u w:val="dotted" w:color="8B7BB8"/>',
}


def _runs(runs, size=None):
    out = []
    for r in runs or []:
        if isinstance(r, str):
            r = {"text": r}
        text = str(r.get("text", ""))
        if not text:
            continue
        props = []
        if r.get("b"):
            props.append("<w:b/>")
        for k in str(r.get("hl") or "").split():
            if k in _HL:
                props.append(_HL[k])
        sz = r.get("size") or size
        if sz:
            props.append('<w:sz w:val="%d"/><w:szCs w:val="%d"/>' % (sz * 2, sz * 2))
        rpr = "<w:rPr>%s</w:rPr>" % "".join(props) if props else ""
        parts = text.split("\n")
        body = '<w:br/>'.join('<w:t xml:space="preserve">%s</w:t>' % _x(p) for p in parts)
        out.append("<w:r>%s%s</w:r>" % (rpr, body))
    return "".join(out)


def _para(runs, style=None, size=None, indent=None, keep=False):
    ppr = []
    if style:
        ppr.append('<w:pStyle w:val="%s"/>' % style)
    if keep:
        ppr.append("<w:keepNext/>")
    if indent:
        ppr.append('<w:ind w:firstLineChars="%d" w:firstLine="%d"/>' % (indent * 100, indent * 240))
    p = "<w:pPr>%s</w:pPr>" % "".join(ppr) if ppr else ""
    return "<w:p>%s%s</w:p>" % (p, _runs(runs, size))


def _cell(c, width, header=False):
    runs = [c] if isinstance(c, (str, int, float)) else c
    runs = [str(r) if isinstance(r, (int, float)) else r for r in runs]
    if header:
        runs = [{"text": r, "b": True} if isinstance(r, str) else dict(r, b=True) for r in runs]
    shade = '<w:shd w:val="clear" w:color="auto" w:fill="EDEAE3"/>' if header else ""
    return '<w:tc><w:tcPr><w:tcW w:w="%d" w:type="dxa"/>%s</w:tcPr>%s</w:tc>' % (
        width, shade, _para(runs, size=10.5 if not header else 10))


def _table(b, text_width=9026):
    ws = b.get("widths") or [1] * len((b.get("rows") or [b.get("header")])[0])
    tot = float(sum(ws)) or 1
    widths = [int(text_width * w / tot) for w in ws]
    out = ['<w:tbl><w:tblPr><w:tblStyle w:val="Grid"/><w:tblW w:w="%d" w:type="dxa"/><w:tblLayout w:type="fixed"/>'
           '<w:tblCellMar><w:top w:w="40" w:type="dxa"/><w:left w:w="80" w:type="dxa"/><w:bottom w:w="40" w:type="dxa"/>'
           '<w:right w:w="80" w:type="dxa"/></w:tblCellMar></w:tblPr><w:tblGrid>%s</w:tblGrid>'
           % (sum(widths), "".join('<w:gridCol w:w="%d"/>' % w for w in widths))]
    if b.get("header"):
        out.append("<w:tr><w:trPr><w:tblHeader/></w:trPr>%s</w:tr>"
                   % "".join(_cell(c, w, True) for c, w in zip(b["header"], widths)))
    for row in b.get("rows") or []:
        out.append("<w:tr><w:trPr><w:cantSplit/></w:trPr>%s</w:tr>" % "".join(_cell(c, w) for c, w in zip(row, widths)))
    out.append("</w:tbl>")
    return "".join(out)


_STYLES = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="%s">
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:eastAsia="Songti TC" w:cs="Times New Roman"/>
<w:sz w:val="24"/><w:szCs w:val="24"/><w:lang w:val="en-US" w:eastAsia="zh-TW"/></w:rPr></w:rPrDefault>
<w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="360" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="240"/></w:pPr><w:rPr><w:b/><w:sz w:val="36"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="240" w:after="120"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="30"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="200" w:after="100"/><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/><w:sz w:val="26"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="160" w:after="80"/><w:outlineLvl w:val="2"/></w:pPr><w:rPr><w:b/><w:sz w:val="24"/></w:rPr></w:style>
<w:style w:type="table" w:styleId="Grid"><w:name w:val="Table Grid"/><w:tblPr><w:tblBorders>
<w:top w:val="single" w:sz="4" w:color="BFB8AC"/><w:left w:val="single" w:sz="4" w:color="BFB8AC"/><w:bottom w:val="single" w:sz="4" w:color="BFB8AC"/>
<w:right w:val="single" w:sz="4" w:color="BFB8AC"/><w:insideH w:val="single" w:sz="4" w:color="BFB8AC"/><w:insideV w:val="single" w:sz="4" w:color="BFB8AC"/>
</w:tblBorders></w:tblPr></w:style>
</w:styles>''' % W_NS


def docx(blocks, landscape=False):
    body = []
    for b in blocks:
        t = b.get("t")
        if t == "h":
            lv = int(b.get("level") or 1)
            body.append(_para([b.get("text", "")], style="Title" if lv == 0 else "Heading%d" % min(3, lv)))
        elif t == "p":
            body.append(_para(b.get("runs"), size=b.get("size"), indent=b.get("indent"), keep=b.get("keep")))
        elif t == "table":
            body.append(_table(b, 13958 if landscape else 9026))
            body.append(_para([]))
    if landscape:
        sect = ('<w:sectPr><w:pgSz w:w="16838" w:h="11906" w:orient="landscape"/>'
                '<w:pgMar w:top="1134" w:right="1440" w:bottom="1134" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>')
    else:
        sect = ('<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>'
                '<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>')
    doc = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:document xmlns:w="%s" xmlns:r="%s"><w:body>%s%s</w:body></w:document>'
           % (W_NS, R_NS, "".join(body), sect))
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
                   '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
                   '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
                   '<Default Extension="xml" ContentType="application/xml"/>'
                   '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
                   '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>'
                   '</Types>')
        z.writestr("_rels/.rels", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
                   '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
                   '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
                   '</Relationships>')
        z.writestr("word/_rels/document.xml.rels", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
                   '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
                   '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'
                   '</Relationships>')
        z.writestr("word/styles.xml", _STYLES)
        z.writestr("word/document.xml", doc)
    return buf.getvalue()


# ================================================================ Excel
def _col(n):
    s = ""
    n += 1
    while n:
        n, r = divmod(n - 1, 26)
        s = chr(65 + r) + s
    return s


def _sheet(sh):
    rows = []
    cols = ""
    if sh.get("widths"):
        cols = "<cols>%s</cols>" % "".join('<col min="%d" max="%d" width="%s" customWidth="1"/>' % (i + 1, i + 1, w)
                                          for i, w in enumerate(sh["widths"]))
    all_rows = ([sh["header"]] if sh.get("header") else []) + list(sh.get("rows") or [])
    for ri, row in enumerate(all_rows):
        cells = []
        hdr = ri == 0 and sh.get("header")
        for ci, v in enumerate(row):
            ref = "%s%d" % (_col(ci), ri + 1)
            st = 1 if hdr else 2
            if isinstance(v, bool):
                v = "是" if v else ""
            if isinstance(v, (int, float)) and not hdr:
                cells.append('<c r="%s" s="%d"><v>%s</v></c>' % (ref, st, v))
            elif v is not None and v != "":
                cells.append('<c r="%s" s="%d" t="inlineStr"><is><t xml:space="preserve">%s</t></is></c>' % (ref, st, _x(v)))
        rows.append('<row r="%d">%s</row>' % (ri + 1, "".join(cells)))
    pane = ('<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>'
            '</sheetView></sheetViews>') if sh.get("header") else ""
    return ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
            '%s%s<sheetData>%s</sheetData></worksheet>' % (pane, cols, "".join(rows)))


_XSTYLES = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="2"><font><sz val="12"/><name val="PingFang TC"/></font><font><b/><sz val="12"/><name val="PingFang TC"/></font></fonts>
<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFEDEAE3"/><bgColor indexed="64"/></patternFill></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"><alignment vertical="center"/></xf>
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf></cellXfs>
</styleSheet>'''


def xlsx(sheets):
    names, used = [], set()
    for i, sh in enumerate(sheets):
        n = re.sub(r"[\[\]:*?/\\]", "_", str(sh.get("name") or "工作表%d" % (i + 1)))[:31] or "工作表%d" % (i + 1)
        while n in used:
            n = n[:28] + "_%d" % i
        used.add(n)
        names.append(n)
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
                   '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
                   '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
                   '<Default Extension="xml" ContentType="application/xml"/>'
                   '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
                   '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
                   + "".join('<Override PartName="/xl/worksheets/sheet%d.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' % (i + 1)
                             for i in range(len(sheets))) + '</Types>')
        z.writestr("_rels/.rels", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
                   '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
                   '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
                   '</Relationships>')
        z.writestr("xl/workbook.xml", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
                   '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="%s"><sheets>%s</sheets></workbook>'
                   % (R_NS, "".join('<sheet name="%s" sheetId="%d" r:id="rId%d"/>' % (_x(n), i + 1, i + 1) for i, n in enumerate(names))))
        z.writestr("xl/_rels/workbook.xml.rels", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
                   '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
                   + "".join('<Relationship Id="rId%d" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet%d.xml"/>' % (i + 1, i + 1)
                             for i in range(len(sheets)))
                   + '<Relationship Id="rId%d" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' % (len(sheets) + 1)
                   + '</Relationships>')
        z.writestr("xl/styles.xml", _XSTYLES)
        for i, sh in enumerate(sheets):
            z.writestr("xl/worksheets/sheet%d.xml" % (i + 1), _sheet(sh))
    return buf.getvalue()
