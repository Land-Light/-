#!/usr/bin/env pwsh
# setup.ps1 - Windows setup script for toshin-correction browser tool
$ErrorActionPreference = "Stop"

Write-Host "=== toshin-correction Setup ===" -ForegroundColor Cyan

# Check Python
$python = $null
foreach ($cmd in @("python", "python3", "py")) {
    try {
        $ver = & $cmd --version 2>&1
        if ($ver -match "Python 3") {
            $python = $cmd
            Write-Host "[OK] Found: $ver ($cmd)" -ForegroundColor Green
            break
        }
    } catch {}
}

if (-not $python) {
    Write-Host "[ERROR] Python 3 not found." -ForegroundColor Red
    Write-Host "  Install from: https://www.python.org/downloads/"
    Write-Host "  Check 'Add Python to PATH' during install."
    Read-Host "Press Enter to exit"
    exit 1
}

# Create venv
Write-Host "[1/4] Creating virtual environment..." -ForegroundColor Yellow
if (-not (Test-Path ".venv")) {
    & $python -m venv .venv
}

$pip        = ".\.venv\Scripts\pip.exe"
$pythonVenv = ".\.venv\Scripts\python.exe"

# Install packages
Write-Host "[2/4] Installing packages..." -ForegroundColor Yellow
& $pip install -r requirements.txt

# Install Chromium
Write-Host "[3/4] Installing Chromium..." -ForegroundColor Yellow
& ".\.venv\Scripts\playwright.exe" install chromium

# Create .env
Write-Host "[4/4] Checking .env..." -ForegroundColor Yellow
if (-not (Test-Path ".env")) {
    Copy-Item ".env.example" ".env"
    Write-Host "[!] Enter your password:" -ForegroundColor Yellow
    $pass = Read-Host "  TOSHIN_PASSWORD"
    (Get-Content ".env") -replace "your_password_here", $pass | Set-Content ".env"
    Write-Host "[OK] .env saved." -ForegroundColor Green
} else {
    Write-Host "[OK] .env already exists." -ForegroundColor Green
}

Write-Host ""
Write-Host "=== Setup complete! ===" -ForegroundColor Cyan
Write-Host "To launch the browser:" -ForegroundColor White
Write-Host "  .\.venv\Scripts\python.exe browser.py" -ForegroundColor Yellow
Write-Host ""
$run = Read-Host "Launch now? (y/N)"
if ($run -eq "y" -or $run -eq "Y") {
    & $pythonVenv browser.py
}
