# setup.ps1 - Windows セットアップスクリプト
# 実行方法: PowerShell で右クリック → "PowerShellで実行"
# または: Set-ExecutionPolicy -Scope CurrentUser RemoteSigned してから .\setup.ps1

$ErrorActionPreference = "Stop"

Write-Host "=== toshin-correction 専用ブラウザ セットアップ ===" -ForegroundColor Cyan

# --- Python 確認 ---
$python = $null
foreach ($cmd in @("python", "python3", "py")) {
    try {
        $ver = & $cmd --version 2>&1
        if ($ver -match "Python 3") {
            $python = $cmd
            Write-Host "[OK] Python 発見: $ver ($cmd)" -ForegroundColor Green
            break
        }
    } catch {}
}

if (-not $python) {
    Write-Host "[エラー] Python 3 が見つかりません。" -ForegroundColor Red
    Write-Host "  https://www.python.org/downloads/ からインストールしてください。"
    Write-Host "  インストール時に 'Add Python to PATH' にチェックを入れてください。"
    Read-Host "Enterで終了"
    exit 1
}

# --- pip / venv ---
Write-Host "`n[1/4] 仮想環境を作成中..." -ForegroundColor Yellow
if (-not (Test-Path ".venv")) {
    & $python -m venv .venv
}

$pip = ".\.venv\Scripts\pip.exe"
$pythonVenv = ".\.venv\Scripts\python.exe"

Write-Host "[2/4] 依存パッケージをインストール中..." -ForegroundColor Yellow
& $pip install -r requirements.txt

Write-Host "[3/4] Chromium をインストール中..." -ForegroundColor Yellow
& ".\.venv\Scripts\playwright.exe" install chromium

# --- .env 作成 ---
Write-Host "[4/4] .env ファイルを確認中..." -ForegroundColor Yellow
if (-not (Test-Path ".env")) {
    Copy-Item ".env.example" ".env"
    Write-Host "[!] .env を作成しました。パスワードを入力してください:" -ForegroundColor Yellow
    $pass = Read-Host "  TOSHIN_PASSWORD"
    (Get-Content ".env") -replace "your_password_here", $pass | Set-Content ".env"
    Write-Host "[OK] .env を保存しました。" -ForegroundColor Green
} else {
    Write-Host "[OK] .env は既に存在します。" -ForegroundColor Green
}

Write-Host "`n=== セットアップ完了 ===" -ForegroundColor Cyan
Write-Host "以下のコマンドでブラウザを起動できます:" -ForegroundColor White
Write-Host "  .\.venv\Scripts\python.exe browser.py" -ForegroundColor Yellow
Write-Host ""
$run = Read-Host "今すぐ起動しますか？ (y/N)"
if ($run -eq "y" -or $run -eq "Y") {
    & $pythonVenv browser.py
}
