param([ValidateRange(1, 65535)][int]$Port = 11434)
$ErrorActionPreference = 'Stop'
$workspaceRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if (-not $PSBoundParameters.ContainsKey('Port')) {
  $configuredAiOrigin = $env:LOCAL_AI_BASE_URL
  if (-not $configuredAiOrigin) {
    foreach ($environmentName in @('.env.local', '.env')) {
      $environmentFile = Join-Path $workspaceRoot $environmentName
      if (-not (Test-Path -LiteralPath $environmentFile)) { continue }
      $originLine = Get-Content -LiteralPath $environmentFile | Where-Object { $_ -match '^\s*LOCAL_AI_BASE_URL\s*=' } | Select-Object -First 1
      if ($originLine) {
        $configuredAiOrigin = ($originLine -replace '^\s*LOCAL_AI_BASE_URL\s*=\s*', '').Trim().Trim('"', "'")
        if ($configuredAiOrigin) { break }
      }
    }
  }
  if ($configuredAiOrigin) {
    $runtimeOrigin = [Uri]$configuredAiOrigin
    if ($runtimeOrigin.Scheme -ne 'http' -or $runtimeOrigin.Host -notin @('127.0.0.1', 'localhost', '[::1]', '::1') -or $runtimeOrigin.UserInfo -or $runtimeOrigin.AbsolutePath -ne '/' -or $runtimeOrigin.Query -or $runtimeOrigin.Fragment) {
      throw 'The local runtime starter requires a loopback HTTP origin without a path, credentials, query, or fragment.'
    }
    $Port = $runtimeOrigin.Port
  }
}
$runtimePath = Join-Path $workspaceRoot '.artifacts\ollama-runtime\ollama.exe'
if (-not (Test-Path -LiteralPath $runtimePath)) {
  $installedRuntime = Get-Command ollama -ErrorAction SilentlyContinue
  if ($installedRuntime) { $runtimePath = $installedRuntime.Source }
  else { throw 'Install Ollama before starting the required local investigator.' }
}
$existingListener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($existingListener) {
  Write-Output 'Ollama port is already in use. Keep the existing service or stop it deliberately before changing runtime settings.'
  exit 0
}
$artifactPath = Join-Path $workspaceRoot '.artifacts'
$modelPath = Join-Path $artifactPath 'ollama-models'
New-Item -ItemType Directory -Path $modelPath -Force | Out-Null
$env:OLLAMA_HOST = "127.0.0.1:$Port"
$env:OLLAMA_MODELS = $modelPath
$env:OLLAMA_NO_CLOUD = '1'
$env:OLLAMA_NUM_PARALLEL = '1'
$env:OLLAMA_MAX_LOADED_MODELS = '1'
$env:OLLAMA_CONTEXT_LENGTH = '4096'
$runtimeProcess = Start-Process -FilePath $runtimePath -ArgumentList @('serve') -WorkingDirectory $workspaceRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $artifactPath 'ollama-stdout.log') -RedirectStandardError (Join-Path $artifactPath 'ollama-stderr.log') -PassThru
Set-Content -LiteralPath (Join-Path $artifactPath 'ollama-service.pid') -Value $runtimeProcess.Id
Write-Output 'Ollama started on loopback with cloud inference disabled and one inference slot.'
