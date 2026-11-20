// dkhelper —— 對勘的命令行輔助工具
//   dkhelper pdftext <file.pdf>                         用 PDFKit 抽取文字，頁與頁之間輸出 \f
//   dkhelper render <file.pdf> <頁碼> <out.png|-> [寬度] 把一頁渲染成 PNG（原件預覽用；- 為輸出到 stdout，不落盤）
//   dkhelper boxes <file.pdf> <頁碼>                    一頁文字層的逐字位置（JSON），供在原件上標注
import AppKit
import Foundation
import PDFKit

func fail(_ msg: String, _ code: Int32 = 1) -> Never {
    FileHandle.standardError.write((msg + "\n").data(using: .utf8)!)
    exit(code)
}

let args = CommandLine.arguments
guard args.count >= 3 else { fail("usage: dkhelper pdftext <file.pdf> | render <file.pdf> <page> <out.png> [width] | boxes <file.pdf> <page>", 2) }
let url = URL(fileURLWithPath: args[2])
guard let doc = PDFDocument(url: url) else { fail("無法打開 PDF") }
if doc.isLocked && !doc.unlock(withPassword: "") { fail("PDF 已加密") }

switch args[1] {
case "pdftext":
    let out = FileHandle.standardOutput
    for i in 0..<doc.pageCount {
        autoreleasepool {
            var s = doc.page(at: i)?.string ?? ""
            s = s.replacingOccurrences(of: "\u{0C}", with: "\n")
            if i > 0 { out.write("\u{0C}".data(using: .utf8)!) }
            out.write(s.data(using: .utf8)!)
        }
    }
case "render":
    guard args.count >= 5, let n = Int(args[3]), n >= 1, n <= doc.pageCount, let page = doc.page(at: n - 1) else {
        fail("頁碼超出範圍（共 \(doc.pageCount) 頁）")
    }
    let width = CGFloat(Double(args.count > 5 ? args[5] : "1400") ?? 1400)
    let box = page.bounds(for: .mediaBox)
    let rot = page.rotation % 180 != 0
    let w = rot ? box.height : box.width, h = rot ? box.width : box.height
    let size = NSSize(width: width, height: (width * h / max(w, 1)).rounded())
    let img = page.thumbnail(of: size, for: .mediaBox)
    guard let tiff = img.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff),
          let png = rep.representation(using: .png, properties: [:]) else { fail("渲染失敗") }
    if args[4] == "-" { FileHandle.standardOutput.write(png) }
    else { do { try png.write(to: URL(fileURLWithPath: args[4])) } catch { fail(error.localizedDescription) } }
case "boxes":
    // 輸出 {"s": 本頁文字, "b": [[x, y, w, h] 或 0, …]}：b 按 s 的 UTF-16 單位逐一對應，
    // 坐標以渲染出的頁面圖（已按頁面旋轉）左上角為原點、寬高為 10000 的整數（比小數省一半以上）。
    guard args.count >= 4, let n = Int(args[3]), n >= 1, n <= doc.pageCount, let page = doc.page(at: n - 1) else {
        fail("頁碼超出範圍（共 \(doc.pageCount) 頁）")
    }
    let box = page.bounds(for: .mediaBox)
    let rot = ((page.rotation % 360) + 360) % 360
    let s = page.string ?? ""
    let ns = s as NSString
    let count = ns.length
    let r4 = { (v: CGFloat) -> Int in Int((Double(v) * 10000).rounded()) }
    var b: [Any] = []
    b.reserveCapacity(count)
    var i = 0
    while i < count {
        // 用選區取位置：characterBounds(at:) 的下標不算 PDFKit 自行插入的換行，逐行錯位；選區與 page.string 下標一致
        let ch = ns.character(at: i)
        let len = CFStringIsSurrogateHighCharacter(ch) && i + 1 < count ? 2 : 1
        let r = ch == 10 || ch == 13 || ch == 12 ? CGRect.null
            : (page.selection(for: NSRange(location: i, length: len))?.bounds(for: page) ?? .null)
        i += len
        if r.isNull || r.isEmpty || r.width <= 0 || r.height <= 0 || box.width <= 0 || box.height <= 0 {
            b.append(0)
            if len == 2 { b.append(0) }
            continue
        }
        // 頁面坐標（左下為原點、y 向上）→ 未旋轉的圖像坐標（左上為原點）→ 按順時針旋轉
        let x0 = (r.minX - box.minX) / box.width, x1 = (r.maxX - box.minX) / box.width
        let y0 = 1 - (r.maxY - box.minY) / box.height, y1 = 1 - (r.minY - box.minY) / box.height
        var q = (x0, y0, x1, y1)
        switch rot {
        case 90: q = (1 - y1, x0, 1 - y0, x1)
        case 180: q = (1 - x1, 1 - y1, 1 - x0, 1 - y0)
        case 270: q = (y0, 1 - x1, y1, 1 - x0)
        default: break
        }
        let v = [r4(q.0), r4(q.1), r4(q.2 - q.0), r4(q.3 - q.1)]
        b.append(v)
        if len == 2 { b.append(v) }
    }
    do {
        let data = try JSONSerialization.data(withJSONObject: ["s": s, "b": b], options: [])
        FileHandle.standardOutput.write(data)
    } catch { fail(error.localizedDescription) }
default:
    fail("unknown command", 2)
}
