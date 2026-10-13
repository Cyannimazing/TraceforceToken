$ErrorActionPreference = 'Stop'
$workspaceRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$runtimePath = Join-Path $workspaceRoot '.artifacts\ollama-runtime\ollama.exe'
if (-not (Test-Path -LiteralPath $runtimePath)) {
  $installedRuntime = Get-Command ollama -ErrorAction SilentlyContinue
  if ($installedRuntime) { $runtimePath = $installedRuntime.Source }
  else { throw 'Install Ollama before starting the required local investigator.' }
}
$existingListener = Get-NetTCPConnection -LocalPort 11434 -State Listen -ErrorAction SilentlyContinue
if ($existingListener) {
  Write-Output 'Ollama port is already in use. Keep the existing service or stop it deliberately before changing runtime settings.'
  exit 0
}
$artifactPath = Join-Path $workspaceRoot '.artifacts'
$modelPath = Join-Path $artifactPath 'ollama-models'
New-Item -ItemType Directory -Path $modelPath -Force | Out-Null
$env:OLLAMA_HOST = '127.0.0.1:11434'
$env:OLLAMA_MODELS = $modelPath
$env:OLLAMA_NO_CLOUD = '1'
$env:OLLAMA_NUM_PARALLEL = '1'
$env:OLLAMA_MAX_LOADED_MODELS = '1'
$env:OLLAMA_CONTEXT_LENGTH = '4096'
$runtimeProcess = Start-Process -FilePath $runtimePath -ArgumentList @('serve') -WorkingDirectory $workspaceRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $artifactPath 'ollama-stdout.log') -RedirectStandardError (Join-Path $artifactPath 'ollama-stderr.log') -PassThru
Set-Content -LiteralPath (Join-Path $artifactPath 'ollama-service.pid') -Value $runtimeProcess.Id
Write-Output 'Ollama started on loopback with cloud inference disabled and one inference slot.'
