# تحديث تلقائي للكود ورفعه على GitHub
param (
    [string]$commitMessage = "تحديث تلقائي"
)

# التأكد أنك في مجلد Git صحيح
if (-not (Test-Path ".git")) {
    Write-Error "❌ هذا المجلد ليس مستودع Git"
    exit
}

# إضافة جميع التعديلات
git add .

# عمل commit بالتاريخ والوقت
$timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
git commit -m "$commitMessage - $timestamp"

# رفع التعديلات إلى GitHub
git push origin main

Write-Host "✅ تم رفع التحديث إلى GitHub. Railway سيقوم بالنشر التلقائي الآن."
