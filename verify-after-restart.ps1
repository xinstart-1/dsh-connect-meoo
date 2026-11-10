# 重启后验证脚本：在 DSH 重启完成后运行
$ErrorActionPreference = 'Continue'
$base = 'http://127.0.0.1:61487'

Write-Output '=== 1. 插件路由 ==='
foreach ($p in @('/plugins/dsh-connect-meoo/status','/plugins/dsh-connect-meoo/client.js')) {
  try {
    $r = Invoke-WebRequest -Uri "$base$p" -TimeoutSec 10 -UseBasicParsing
    Write-Output "  OK $p -> HTTP $($r.StatusCode) ($($r.RawContentLength) bytes)"
  } catch {
    Write-Output "  FAIL $p -> $($_.Exception.Message)"
  }
}

Write-Output ''
Write-Output '=== 2. 状态文档（关键字段）==='
try {
  $doc = Invoke-RestMethod -Uri "$base/plugins/dsh-connect-meoo/status" -TimeoutSec 10
  Write-Output "  version: $($doc.version)"
  Write-Output "  login.state: $($doc.login.state)"
  Write-Output "  login.source: $($doc.login.source)"
  Write-Output "  models: $($doc.models.Count)"
  Write-Output "  points.state: $($doc.points.state)"
  Write-Output "  gateway: $($doc.gateway)"
} catch {
  Write-Output "  FAIL: $($_.Exception.Message)"
}

Write-Output ''
Write-Output '=== 3. 侧栏槽位（客户端 bundle 里的注册）==='
try {
  $js = (Invoke-WebRequest -Uri "$base/plugins/dsh-connect-meoo/client.js" -TimeoutSec 10 -UseBasicParsing).Content
  Write-Output "  settings.section: $($js.Contains("name: 'settings.section'"))"
  Write-Output "  settings.section.icon: $($js.Contains("name: 'settings.section.icon'"))"
  Write-Output "  sidebar.panellist: $($js.Contains('sidebar.panellist'))"
} catch {
  Write-Output "  FAIL: $($_.Exception.Message)"
}

Write-Output ''
Write-Output '全部 OK 就去 设置 -> 左栏找「Meoo 秒悟」那一行。'
