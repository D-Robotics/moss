param(
  [Parameter(Mandatory = $true)][ValidateSet('inspect','render','replace-text','audit')][string]$Action,
  [Parameter(Mandatory = $true)][string]$InputPath,
  [string]$OutputPath,
  [string]$MapPath,
  [string]$RenderDir
)
$ErrorActionPreference = 'Stop'
function RequiredFile([string]$Value) { if (-not (Test-Path -LiteralPath $Value -PathType Leaf)) { throw "File not found: $Value" }; (Resolve-Path -LiteralPath $Value).Path }
function ReleaseCom($Value) { if ($null -ne $Value -and [Runtime.InteropServices.Marshal]::IsComObject($Value)) { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($Value) } }
$inputFile = RequiredFile $InputPath
$app = $null; $deck = $null
try {
  $app = New-Object -ComObject PowerPoint.Application
  $deck = $app.Presentations.Open($inputFile, $true, $false, $false)
  if ($Action -eq 'inspect') {
    $slides = foreach ($slide in $deck.Slides) {
      $shapes = foreach ($shape in $slide.Shapes) {
        $text = ''; try { if ($shape.HasTextFrame -and $shape.TextFrame.HasText) { $text = $shape.TextFrame.TextRange.Text.Trim() } } catch {}
        [ordered]@{ id=[int]$shape.Id; name=[string]$shape.Name; type=[int]$shape.Type; left=[math]::Round([double]$shape.Left,2); top=[math]::Round([double]$shape.Top,2); width=[math]::Round([double]$shape.Width,2); height=[math]::Round([double]$shape.Height,2); text=$text }
      }
      [ordered]@{ number=[int]$slide.SlideIndex; shapes=@($shapes) }
    }
    [ordered]@{ width=[math]::Round([double]$deck.PageSetup.SlideWidth,2); height=[math]::Round([double]$deck.PageSetup.SlideHeight,2); slideCount=[int]$deck.Slides.Count; slides=@($slides) } | ConvertTo-Json -Depth 8
    exit 0
  }
  if ($Action -eq 'audit') {
    $w=[double]$deck.PageSetup.SlideWidth; $h=[double]$deck.PageSetup.SlideHeight
    $ignored = @()
    $issues = foreach ($slide in $deck.Slides) { foreach ($shape in $slide.Shapes) {
      $l=[double]$shape.Left; $t=[double]$shape.Top; $r=$l+[double]$shape.Width; $b=$t+[double]$shape.Height
      if ($l -lt -0.5 -or $t -lt -0.5 -or $r -gt ($w+0.5) -or $b -gt ($h+0.5)) {
        $record=[ordered]@{ slide=[int]$slide.SlideIndex; shapeId=[int]$shape.Id; name=[string]$shape.Name; bounds=@([math]::Round($l,2),[math]::Round($t,2),[math]::Round($r,2),[math]::Round($b,2)) }
        if ([int]$shape.Type -eq 13 -and [double]$shape.Width -ge ($w*0.45) -and [double]$shape.Height -ge ($h*0.45)) { $ignored += $record } else { $record }
      }
    } }
    $result=[ordered]@{ ok=@($issues).Count -eq 0; issues=@($issues); ignoredDecorativeImages=@($ignored) }; $result | ConvertTo-Json -Depth 6
    if (-not $result.ok) { exit 2 }; exit 0
  }
  if ($Action -eq 'render') {
    if ([string]::IsNullOrWhiteSpace($RenderDir)) { throw 'RenderDir is required.' }
    $dir=[IO.Path]::GetFullPath($RenderDir); [void](New-Item -ItemType Directory -Force -Path $dir)
    foreach ($slide in $deck.Slides) { $slide.Export((Join-Path $dir ('slide-{0:D2}.png' -f [int]$slide.SlideIndex)),'PNG',1600,900) }
    [ordered]@{ slideCount=[int]$deck.Slides.Count; renderDir=$dir } | ConvertTo-Json; exit 0
  }
  if ($Action -eq 'replace-text') {
    if ([string]::IsNullOrWhiteSpace($OutputPath) -or [string]::IsNullOrWhiteSpace($MapPath)) { throw 'OutputPath and MapPath are required.' }
    $items=Get-Content -LiteralPath (RequiredFile $MapPath) -Raw -Encoding UTF8 | ConvertFrom-Json
    foreach ($item in $items) {
      $shape=$deck.Slides.Item([int]$item.slide).Shapes | Where-Object { [int]$_.Id -eq [int]$item.shapeId } | Select-Object -First 1
      if ($null -eq $shape -or -not $shape.HasTextFrame) { throw "Editable shape not found: slide $($item.slide), shape $($item.shapeId)" }
      $shape.TextFrame.TextRange.Text=[string]$item.text
    }
    $out=[IO.Path]::GetFullPath($OutputPath); [void](New-Item -ItemType Directory -Force -Path ([IO.Path]::GetDirectoryName($out)))
    $deck.SaveAs($out,24); [ordered]@{ output=$out; replacements=@($items).Count } | ConvertTo-Json; exit 0
  }
} finally {
  if ($null -ne $deck) { try { $deck.Close() } catch {} }; if ($null -ne $app) { try { $app.Quit() } catch {} }
  ReleaseCom $deck; ReleaseCom $app; [GC]::Collect(); [GC]::WaitForPendingFinalizers()
}
