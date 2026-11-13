param(
    [int]$Port = 8080
)

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
Add-Type -AssemblyName System.Web

$RootDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$PublicDir = Join-Path $RootDir "public"
$SamplesDir = Join-Path $RootDir "samples"

function Get-MimeType([string]$Path) {
    $ext = [System.IO.Path]::GetExtension($Path).ToLowerInvariant()
    switch ($ext) {
        ".html" { return "text/html; charset=utf-8" }
        ".css"  { return "text/css; charset=utf-8" }
        ".js"   { return "application/javascript; charset=utf-8" }
        ".json" { return "application/json; charset=utf-8" }
        ".csv"  { return "text/csv; charset=utf-8" }
        ".xlsx" { return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }
        ".docx" { return "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }
        ".png"  { return "image/png" }
        ".svg"  { return "image/svg+xml" }
        default { return "application/octet-stream" }
    }
}

function Convert-ColRefToIndex([string]$CellRef) {
    $letters = ($CellRef -replace '[^A-Za-z]', '').ToUpperInvariant()
    $index = 0
    for ($i = 0; $i -lt $letters.Length; $i++) {
        $index = $index * 26 + ([int][char]$letters[$i] - [int][char]'A' + 1)
    }
    return $index - 1
}

function Read-ZipEntryText([System.IO.Compression.ZipArchive]$Zip, [string]$EntryPath) {
    $norm = $EntryPath.TrimStart('/') -replace '\\', '/'
    $entry = $Zip.Entries | Where-Object { ($_.FullName -replace '\\', '/') -ieq $norm } | Select-Object -First 1
    if ($null -eq $entry) { return $null }
    $stream = $entry.Open()
    $reader = New-Object System.IO.StreamReader($stream, [System.Text.Encoding]::UTF8)
    try {
        return $reader.ReadToEnd()
    } finally {
        $reader.Dispose()
        $stream.Dispose()
    }
}

function Parse-XlsxBytes([byte[]]$Bytes) {
    $ms = New-Object System.IO.MemoryStream(, $Bytes)
    $zip = New-Object System.IO.Compression.ZipArchive($ms, [System.IO.Compression.ZipArchiveMode]::Read)
    try {
        # 1. Shared strings
        $sharedStrings = New-Object System.Collections.Generic.List[string]
        $sstText = Read-ZipEntryText $zip "xl/sharedStrings.xml"
        if ($sstText) {
            [xml]$sstXml = $sstText
            $nsMgr = New-Object System.Xml.XmlNamespaceManager($sstXml.NameTable)
            $nsMgr.AddNamespace("x", "http://schemas.openxmlformats.org/spreadsheetml/2006/main")
            $siNodes = $sstXml.SelectNodes("//x:si", $nsMgr)
            foreach ($si in $siNodes) {
                $tNodes = $si.SelectNodes(".//x:t", $nsMgr)
                $sb = New-Object System.Text.StringBuilder
                foreach ($t in $tNodes) {
                    [void]$sb.Append($t.InnerText)
                }
                $sharedStrings.Add($sb.ToString())
            }
        }

        # 2. Workbook sheets + rels
        $wbText = Read-ZipEntryText $zip "xl/workbook.xml"
        if (-not $wbText) { throw "Invalid XLSX: missing xl/workbook.xml" }
        [xml]$wbXml = $wbText
        $wbNs = New-Object System.Xml.XmlNamespaceManager($wbXml.NameTable)
        $wbNs.AddNamespace("x", "http://schemas.openxmlformats.org/spreadsheetml/2006/main")
        $wbNs.AddNamespace("r", "http://schemas.openxmlformats.org/officeDocument/2006/relationships")

        $relsMap = @{}
        $relsText = Read-ZipEntryText $zip "xl/_rels/workbook.xml.rels"
        if ($relsText) {
            [xml]$relsXml = $relsText
            foreach ($rel in $relsXml.Relationships.Relationship) {
                $relsMap[$rel.Id] = $rel.Target
            }
        }

        $sheetsResult = @()
        $sheetNodes = $wbXml.SelectNodes("//x:sheets/x:sheet", $wbNs)
        foreach ($sNode in $sheetNodes) {
            $sheetName = $sNode.GetAttribute("name")
            $rId = $sNode.GetAttribute("id", "http://schemas.openxmlformats.org/officeDocument/2006/relationships")
            $target = $relsMap[$rId]
            if (-not $target) { continue }
            $sheetPath = if ($target.StartsWith("/")) { $target.TrimStart("/") } elseif ($target.StartsWith("xl/")) { $target } else { "xl/$target" }

            $sheetText = Read-ZipEntryText $zip $sheetPath
            if (-not $sheetText) { continue }

            [xml]$sheetXml = $sheetText
            $sNs = New-Object System.Xml.XmlNamespaceManager($sheetXml.NameTable)
            $sNs.AddNamespace("x", "http://schemas.openxmlformats.org/spreadsheetml/2006/main")

            $rowsList = New-Object System.Collections.Generic.List[object]
            $rowNodes = $sheetXml.SelectNodes("//x:sheetData/x:row", $sNs)
            foreach ($rNode in $rowNodes) {
                $rowMap = @{}
                $maxCol = -1
                $cellNodes = $rNode.SelectNodes("./x:c", $sNs)
                foreach ($cNode in $cellNodes) {
                    $ref = $cNode.GetAttribute("r")
                    $colIdx = if ($ref) { Convert-ColRefToIndex $ref } else { $maxCol + 1 }
                    if ($colIdx -gt $maxCol) { $maxCol = $colIdx }

                    $cellType = $cNode.GetAttribute("t")
                    $val = ""
                    if ($cellType -eq "s") {
                        $vNode = $cNode.SelectSingleNode("./x:v", $sNs)
                        if ($vNode -and $vNode.InnerText -ne "") {
                            $idx = [int]$vNode.InnerText
                            if ($idx -ge 0 -and $idx -lt $sharedStrings.Count) {
                                $val = $sharedStrings[$idx]
                            }
                        }
                    } elseif ($cellType -eq "inlineStr") {
                        $tNodes = $cNode.SelectNodes("./x:is//x:t", $sNs)
                        $sb = New-Object System.Text.StringBuilder
                        foreach ($t in $tNodes) { [void]$sb.Append($t.InnerText) }
                        $val = $sb.ToString()
                    } elseif ($cellType -eq "b") {
                        $vNode = $cNode.SelectSingleNode("./x:v", $sNs)
                        $val = if ($vNode -and $vNode.InnerText -eq "1") { "TRUE" } else { "FALSE" }
                    } else {
                        $vNode = $cNode.SelectSingleNode("./x:v", $sNs)
                        if ($vNode) { $val = $vNode.InnerText }
                    }
                    $rowMap[$colIdx] = $val
                }
                if ($maxCol -ge 0) {
                    $arr = New-Object string[] ($maxCol + 1)
                    for ($c = 0; $c -le $maxCol; $c++) {
                        $arr[$c] = if ($rowMap.ContainsKey($c)) { $rowMap[$c] } else { "" }
                    }
                    $rowsList.Add($arr)
                }
            }

            $sheetsResult += @{
                name = $sheetName
                rows = $rowsList.ToArray()
            }
        }
        return $sheetsResult
    } finally {
        $zip.Dispose()
        $ms.Dispose()
    }
}

function Escape-Xml([string]$Text) {
    if ($null -eq $Text) { return "" }
    return [System.Security.SecurityElement]::Escape($Text)
}

function New-DocxParagraph([string]$Text, [bool]$Bold = $false, [int]$FontSizeHalfPts = 22, [string]$ColorHex = "1E293B", [string]$Style = "") {
    $escaped = Escape-Xml $Text
    $pPr = if ($Style) { "<w:pPr><w:pStyle w:val=`"$Style`"/><w:spacing w:after=`"120`"/></w:pPr>" } else { "<w:pPr><w:spacing w:after=`"100`"/></w:pPr>" }
    $boldTag = if ($Bold) { "<w:b/>" } else { "" }
    $rPr = "<w:rPr>$boldTag<w:color w:val=`"$ColorHex`"/><w:sz w:val=`"$FontSizeHalfPts`"/><w:szCs w:val=`"$FontSizeHalfPts`"/></w:rPr>"
    return "<w:p>$pPr<w:r>$rPr<w:t xml:space=`"preserve`">$escaped</w:t></w:r></w:p>"
}

function New-DocxTable([string[]]$Headers, [object[]]$Rows) {
    $sb = New-Object System.Text.StringBuilder
    [void]$sb.Append('<w:tbl><w:tblPr><w:tblW w:w="9500" w:type="dxa"/><w:tblBorders><w:top w:val="single" w:sz="4" w:space="0" w:color="CBD5E1"/><w:bottom w:val="single" w:sz="4" w:space="0" w:color="CBD5E1"/><w:left w:val="single" w:sz="4" w:space="0" w:color="CBD5E1"/><w:right w:val="single" w:sz="4" w:space="0" w:color="CBD5E1"/><w:insideH w:val="single" w:sz="4" w:space="0" w:color="E2E8F0"/><w:insideV w:val="single" w:sz="4" w:space="0" w:color="E2E8F0"/></w:tblBorders></w:tblPr>')
    # Header row
    [void]$sb.Append('<w:tr>')
    foreach ($h in $Headers) {
        $esc = Escape-Xml ([string]$h)
        [void]$sb.Append("<w:tc><w:tcPr><w:shd w:val=`"clear`" w:color=`"auto`" w:fill=`"0F2238`"/></w:tcPr><w:p><w:pPr><w:spacing w:before=`"60`" w:after=`"60`"/></w:pPr><w:r><w:rPr><w:b/><w:color w:val=`"FFFFFF`"/><w:sz w:val=`"18`"/></w:rPr><w:t xml:space=`"preserve`">$esc</w:t></w:r></w:p></w:tc>")
    }
    [void]$sb.Append('</w:tr>')

    foreach ($row in $Rows) {
        [void]$sb.Append('<w:tr>')
        foreach ($cell in $row) {
            $esc = Escape-Xml ([string]$cell)
            [void]$sb.Append("<w:tc><w:p><w:pPr><w:spacing w:before=`"50`" w:after=`"50`"/></w:pPr><w:r><w:rPr><w:color w:val=`"1E293B`"/><w:sz w:val=`"18`"/></w:rPr><w:t xml:space=`"preserve`">$esc</w:t></w:r></w:p></w:tc>")
        }
        [void]$sb.Append('</w:tr>')
    }
    [void]$sb.Append('</w:tbl>')
    return $sb.ToString()
}

function Add-ZipTextEntry([System.IO.Compression.ZipArchive]$Zip, [string]$EntryName, [string]$Content) {
    $entry = $Zip.CreateEntry($EntryName)
    $stream = $entry.Open()
    $writer = New-Object System.IO.StreamWriter($stream, [System.Text.Encoding]::UTF8)
    try {
        $writer.Write($Content)
    } finally {
        $writer.Dispose()
        $stream.Dispose()
    }
}

function Build-DocxBytes($ReportData) {
    $body = New-Object System.Text.StringBuilder

    [void]$body.Append((New-DocxParagraph "BÁO CÁO PHÂN TÍCH HỒ SƠ CHÀO GIÁ & ĐỀ XUẤT KINH DOANH" $true 32 "0F2238"))
    [void]$body.Append((New-DocxParagraph "Đơn vị: Công ty Giải pháp Mạng & Triển khai Thiên Minh" $false 22 "475569"))
    [void]$body.Append((New-DocxParagraph ("Ngày xuất báo cáo: " + (Get-Date -Format "dd/MM/yyyy HH:mm")) $false 20 "64748B"))

    # Summary KPIs
    $summary = $ReportData.summary
    [void]$body.Append((New-DocxParagraph "1. TỔNG QUAN DANH MỤC HỒ SƠ" $true 26 "0369A1"))
    $summaryRows = @(
        @("Tổng số hồ sơ phân tích", [string]$summary.totalProjects),
        @("Đủ điều kiện chào giá (Ready to Quote)", [string]$summary.readyCount),
        @("Cần xác minh trước (Needs Verification)", [string]$summary.verifyCount),
        @("Cần chuyển duyệt (Needs Approval)", [string]$summary.approvalCount),
        @("Tổng giá trị dự kiến (VND)", [string]$summary.totalEstimatedValueFormatted)
    )
    [void]$body.Append((New-DocxTable @("Chỉ số", "Giá trị") $summaryRows))

    # Summary Table of Projects
    [void]$body.Append((New-DocxParagraph "2. BẢNG PHÂN LOẠI HỒ SƠ THEO QUY TRÌNH" $true 26 "0369A1"))
    $projHeaders = @("Mã HS", "Khách hàng", "Trạng thái", "Ngân sách", "Giá đề xuất", "Lý do / Hành động chính")
    $projRows = @()
    foreach ($p in $ReportData.projects) {
        $projRows += ,@([string]$p.id, [string]$p.customer, [string]$p.statusLabel, [string]$p.budgetFormatted, [string]$p.quoteFormatted, [string]$p.primaryAction)
    }
    [void]$body.Append((New-DocxTable $projHeaders $projRows))

    # Detailed per-project breakdown
    [void]$body.Append((New-DocxParagraph "3. CHI TIẾT PHÂN TÍCH & ĐỀ XUẤT TỪNG HỒ SƠ" $true 26 "0369A1"))
    foreach ($p in $ReportData.projects) {
        [void]$body.Append((New-DocxParagraph ("Hồ sơ: " + $p.id + " - " + $p.customer + " [" + $p.statusLabel + "]") $true 24 "0F172A"))
        [void]$body.Append((New-DocxParagraph ("Hạn triển khai yêu cầu: " + $p.deadline + " | Chiết khấu yêu cầu: " + $p.requestedDiscount + "% | Bảo trì/SLA: " + $p.slaRequirement) $false 20 "334155"))
        [void]$body.Append((New-DocxParagraph ("Đề xuất kinh doanh: " + $p.recommendation) $false 20 "0F2238"))

        if ($p.matchedItems -and $p.matchedItems.Count -gt 0) {
            $itemRows = @()
            foreach ($it in $p.matchedItems) {
                $itemRows += ,@([string]$it.solutionId, [string]$it.name, [string]$it.qty, [string]$it.lineTotalFormatted, [string]$it.fitNote)
            }
            [void]$body.Append((New-DocxTable @("Mã GP", "Giải pháp", "SL", "Thành tiền", "Đánh giá kỹ thuật") $itemRows))
        }

        if ($p.flags -and $p.flags.Count -gt 0) {
            foreach ($fl in $p.flags) {
                [void]$body.Append((New-DocxParagraph ("  • [" + $fl.severity + "] " + $fl.title + ": " + $fl.detail) $false 19 "B91C1C"))
            }
        }
    }

    $contentTypes = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'
    $rels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'
    $docXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' + $body.ToString() + '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1080" w:right="1080" w:bottom="1080" w:left="1080"/></w:sectPr></w:body></w:document>'

    $ms = New-Object System.IO.MemoryStream
    $zip = New-Object System.IO.Compression.ZipArchive($ms, [System.IO.Compression.ZipArchiveMode]::Create, $true)
    try {
        Add-ZipTextEntry $zip "[Content_Types].xml" $contentTypes
        Add-ZipTextEntry $zip "_rels/.rels" $rels
        Add-ZipTextEntry $zip "word/document.xml" $docXml
    } finally {
        $zip.Dispose()
    }
    return $ms.ToArray()
}

function Send-Json($Response, [int]$StatusCode, $Payload) {
    $json = $Payload | ConvertTo-Json -Depth 12 -Compress
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
    $Response.StatusCode = $StatusCode
    $Response.ContentType = "application/json; charset=utf-8"
    $Response.ContentLength64 = $bytes.Length
    $Response.OutputStream.Write($bytes, 0, $bytes.Length)
    $Response.OutputStream.Close()
}

function Read-RequestBody($Request) {
    $reader = New-Object System.IO.StreamReader($Request.InputStream, [System.Text.Encoding]::UTF8)
    try { return $reader.ReadToEnd() } finally { $reader.Dispose() }
}

$listener = New-Object System.Net.HttpListener
$prefix = "http://localhost:$Port/"
$listener.Prefixes.Add($prefix)
$listener.Start()

Write-Host "Thien Minh AI Quote Agent running at $prefix"
Write-Host "Press Ctrl+C to stop."

try {
    while ($listener.IsListening) {
        $context = $listener.GetContext()
        $req = $context.Request
        $res = $context.Response
        $path = $req.Url.AbsolutePath

        try {
            if ($req.HttpMethod -eq "POST" -and $path -eq "/api/parse-xlsx") {
                $body = Read-RequestBody $req | ConvertFrom-Json
                $bytes = [Convert]::FromBase64String($body.base64)
                $sheets = Parse-XlsxBytes $bytes
                Send-Json $res 200 @{ ok = $true; sheets = $sheets }
            }
            elseif ($req.HttpMethod -eq "POST" -and $path -eq "/api/fetch-gsheet") {
                $body = Read-RequestBody $req | ConvertFrom-Json
                $url = [string]$body.url
                if ($url -match "/spreadsheets/d/([a-zA-Z0-9-_]+)") {
                    $sheetId = $Matches[1]
                    $exportUrl = "https://docs.google.com/spreadsheets/d/$sheetId/export?format=xlsx"
                    $resp = Invoke-WebRequest -Uri $exportUrl -UseBasicParsing -TimeoutSec 20
                    $sheets = Parse-XlsxBytes $resp.Content
                    Send-Json $res 200 @{ ok = $true; source = "google_sheets"; sheetId = $sheetId; sheets = $sheets }
                } else {
                    Send-Json $res 400 @{ ok = $false; error = "Link Google Sheets không hợp lệ. Vui lòng dán link dạng https://docs.google.com/spreadsheets/d/..." }
                }
            }
            elseif ($req.HttpMethod -eq "POST" -and $path -eq "/api/export-docx") {
                $body = Read-RequestBody $req | ConvertFrom-Json
                $docxBytes = Build-DocxBytes $body
                $res.StatusCode = 200
                $res.ContentType = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                $res.AddHeader("Content-Disposition", 'attachment; filename="BaoCao_ChaoGia_ThienMinh.docx"')
                $res.ContentLength64 = $docxBytes.Length
                $res.OutputStream.Write($docxBytes, 0, $docxBytes.Length)
                $res.OutputStream.Close()
            }
            elseif ($req.HttpMethod -eq "GET" -and $path -eq "/api/health") {
                Send-Json $res 200 @{ ok = $true; service = "Thien Minh AI Agent"; port = $Port }
            }
            else {
                $relPath = if ($path -eq "/") { "index.html" } else { $path.TrimStart("/") -replace "/", "\" }
                $fullPath = Join-Path $PublicDir $relPath
                if (-not (Test-Path $fullPath -PathType Leaf)) {
                    $samplePath = Join-Path $SamplesDir $relPath
                    if (Test-Path $samplePath -PathType Leaf) { $fullPath = $samplePath }
                }

                if (Test-Path $fullPath -PathType Leaf) {
                    $bytes = [System.IO.File]::ReadAllBytes($fullPath)
                    $res.StatusCode = 200
                    $res.ContentType = Get-MimeType $fullPath
                    $res.ContentLength64 = $bytes.Length
                    $res.OutputStream.Write($bytes, 0, $bytes.Length)
                    $res.OutputStream.Close()
                } else {
                    $res.StatusCode = 404
                    $notFound = [System.Text.Encoding]::UTF8.GetBytes("404 Not Found")
                    $res.OutputStream.Write($notFound, 0, $notFound.Length)
                    $res.OutputStream.Close()
                }
            }
        } catch {
            Send-Json $res 500 @{ ok = $false; error = $_.Exception.Message }
        }
    }
} finally {
    $listener.Stop()
    $listener.Close()
}

