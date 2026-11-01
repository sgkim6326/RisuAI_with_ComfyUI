param(
    [string]$CandidateDirectory,
    [switch]$ForceDeploy
)

$ErrorActionPreference = 'Stop'
$domain = 'bclab-local-ai.wind-saury.ts.net'
$minimumRemaining = New-TimeSpan -Days 30
$newCertificateMinimum = New-TimeSpan -Days 60
$repositoryRoot = Split-Path -Parent $PSScriptRoot
$certificateDirectory = Join-Path $repositoryRoot 'certs'
$activeCertificate = Join-Path $certificateDirectory 'server.crt'
$activeKey = Join-Path $certificateDirectory 'server.key'
$pendingDirectory = Join-Path $certificateDirectory '.pending-renewal'
$pendingCertificate = Join-Path $pendingDirectory 'server.crt'
$pendingKey = Join-Path $pendingDirectory 'server.key'
$nginxConfig = Join-Path $PSScriptRoot 'nginx.conf'
$healthUrl = "https://${domain}:29999/sw.js"
$workingDirectory = Join-Path $certificateDirectory ('.renew-' + [guid]::NewGuid().ToString('N'))
$deploymentStarted = $false
$usingPendingCertificate = $false
$originalCertificateExists = Test-Path -LiteralPath $activeCertificate
$originalKeyExists = Test-Path -LiteralPath $activeKey

function Get-CertificateStatus {
    param(
        [string]$Path,
        [TimeSpan]$RequiredRemaining
    )

    $certificate = $null
    $chain = $null
    try {
        if (-not (Test-Path -LiteralPath $Path)) {
            return [pscustomobject]@{ Valid = $false; Reason = 'Certificate file is missing.' }
        }

        $certificate = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new($Path)
        $certificateDomain = $certificate.GetNameInfo(
            [System.Security.Cryptography.X509Certificates.X509NameType]::DnsName,
            $false
        )
        $chain = [System.Security.Cryptography.X509Certificates.X509Chain]::new()
        $chain.ChainPolicy.RevocationMode = [System.Security.Cryptography.X509Certificates.X509RevocationMode]::NoCheck
        $trusted = $chain.Build($certificate)
        $remaining = $certificate.NotAfter - (Get-Date)

        if ($certificateDomain -ne $domain) {
            return [pscustomobject]@{ Valid = $false; Reason = "Certificate name mismatch: $certificateDomain" }
        }
        if ($certificate.NotBefore -gt (Get-Date).AddMinutes(5)) {
            return [pscustomobject]@{ Valid = $false; Reason = 'Certificate is not yet valid.' }
        }
        if (-not $trusted) {
            $status = ($chain.ChainStatus | ForEach-Object { $_.Status.ToString() }) -join ', '
            return [pscustomobject]@{ Valid = $false; Reason = "Certificate chain is not trusted: $status" }
        }
        if ($remaining -le $RequiredRemaining) {
            return [pscustomobject]@{ Valid = $false; Reason = "Certificate expires within $RequiredRemaining." }
        }

        return [pscustomobject]@{
            Valid = $true
            Reason = ''
            NotAfter = $certificate.NotAfter
        }
    } catch {
        return [pscustomobject]@{ Valid = $false; Reason = $_.Exception.Message }
    } finally {
        if ($null -ne $chain) {
            $chain.Dispose()
        }
        if ($null -ne $certificate) {
            $certificate.Dispose()
        }
    }
}

function Invoke-Compose {
    param([string[]]$Arguments)

    & docker compose @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "docker compose $($Arguments -join ' ') failed with exit code $LASTEXITCODE."
    }
}

function Restore-PreviousCertificate {
    if ($originalCertificateExists) {
        Copy-Item -LiteralPath (Join-Path $workingDirectory 'previous.crt') -Destination $activeCertificate -Force
    } elseif (Test-Path -LiteralPath $activeCertificate) {
        Remove-Item -LiteralPath $activeCertificate -Force
    }

    if ($originalKeyExists) {
        Copy-Item -LiteralPath (Join-Path $workingDirectory 'previous.key') -Destination $activeKey -Force
    } elseif (Test-Path -LiteralPath $activeKey) {
        Remove-Item -LiteralPath $activeKey -Force
    }

    Invoke-Compose -Arguments @('exec', '-T', 'https-proxy', 'nginx', '-t')
    Invoke-Compose -Arguments @('exec', '-T', 'https-proxy', 'nginx', '-s', 'reload')
}

try {
    Set-Location $repositoryRoot
    New-Item -ItemType Directory -Force -Path $workingDirectory | Out-Null

    $candidateCertificate = Join-Path $workingDirectory 'server.crt'
    $candidateKey = Join-Path $workingDirectory 'server.key'

    if ($CandidateDirectory) {
        $candidateRoot = (Resolve-Path -LiteralPath $CandidateDirectory).Path
        Copy-Item -LiteralPath (Join-Path $candidateRoot 'server.crt') -Destination $candidateCertificate
        Copy-Item -LiteralPath (Join-Path $candidateRoot 'server.key') -Destination $candidateKey
    } elseif ($ForceDeploy) {
        if (-not ($originalCertificateExists -and $originalKeyExists)) {
            throw 'Cannot force deployment because the active certificate or key is missing.'
        }
        Copy-Item -LiteralPath $activeCertificate -Destination $candidateCertificate
        Copy-Item -LiteralPath $activeKey -Destination $candidateKey
    } else {
        $currentStatus = Get-CertificateStatus -Path $activeCertificate -RequiredRemaining $minimumRemaining
        if ($currentStatus.Valid) {
            Write-Output "Certificate is trusted for $domain until $($currentStatus.NotAfter); renewal is not due."
            return
        }

        if ((Test-Path -LiteralPath $pendingCertificate) -or (Test-Path -LiteralPath $pendingKey)) {
            if (-not ((Test-Path -LiteralPath $pendingCertificate) -and (Test-Path -LiteralPath $pendingKey))) {
                throw 'An incomplete pending certificate exists; refusing to request another certificate.'
            }

            $pendingStatus = Get-CertificateStatus -Path $pendingCertificate -RequiredRemaining $newCertificateMinimum
            if (-not $pendingStatus.Valid) {
                throw "Pending certificate validation failed; refusing to request another: $($pendingStatus.Reason)"
            }

            Write-Output 'Reusing a previously issued pending certificate; no new CA request will be made.'
            Copy-Item -LiteralPath $pendingCertificate -Destination $candidateCertificate
            Copy-Item -LiteralPath $pendingKey -Destination $candidateKey
            $usingPendingCertificate = $true
        } else {
            $tailscale = Join-Path $env:ProgramFiles 'Tailscale\tailscale.exe'
            if (-not (Test-Path -LiteralPath $tailscale)) {
                throw "Tailscale CLI was not found at $tailscale."
            }

            New-Item -ItemType Directory -Force -Path $pendingDirectory | Out-Null
            Write-Output "Requesting a replacement certificate: $($currentStatus.Reason)"
            & $tailscale cert --min-validity 30d --cert-file $pendingCertificate --key-file $pendingKey $domain
            if ($LASTEXITCODE -ne 0) {
                throw "tailscale cert failed with exit code $LASTEXITCODE."
            }

            Copy-Item -LiteralPath $pendingCertificate -Destination $candidateCertificate
            Copy-Item -LiteralPath $pendingKey -Destination $candidateKey
            $usingPendingCertificate = $true
        }
    }

    if (-not (Test-Path -LiteralPath $candidateCertificate) -or -not (Test-Path -LiteralPath $candidateKey)) {
        throw 'The candidate certificate or key was not created.'
    }

    $candidateStatus = Get-CertificateStatus -Path $candidateCertificate -RequiredRemaining $newCertificateMinimum
    if (-not $candidateStatus.Valid) {
        throw "Candidate certificate validation failed: $($candidateStatus.Reason)"
    }

    $candidateLeaf = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new($candidateCertificate)
    $candidateChain = [System.Security.Cryptography.X509Certificates.X509Chain]::new()
    try {
        $candidateChain.ChainPolicy.RevocationMode = [System.Security.Cryptography.X509Certificates.X509RevocationMode]::NoCheck
        if (-not $candidateChain.Build($candidateLeaf)) {
            throw 'Candidate certificate chain validation failed.'
        }
    } finally {
        $candidateChain.Dispose()
        $candidateLeaf.Dispose()
    }

    $proxyIds = & docker compose ps -q https-proxy
    if ($LASTEXITCODE -ne 0 -or -not $proxyIds) {
        throw 'The https-proxy Compose service is not running.'
    }
    $proxyInfoText = & docker inspect $proxyIds[0]
    if ($LASTEXITCODE -ne 0) {
        throw 'Could not inspect the running Nginx container.'
    }
    $proxyInfo = ($proxyInfoText -join "`n") | ConvertFrom-Json
    $networkName = $proxyInfo[0].NetworkSettings.Networks.PSObject.Properties.Name | Select-Object -First 1
    if (-not $networkName) {
        throw 'Could not determine the Nginx Compose network.'
    }

    $configMount = "type=bind,source=$nginxConfig,target=/etc/nginx/conf.d/default.conf,readonly"
    $certificateMount = "type=bind,source=$workingDirectory,target=/etc/nginx/certs,readonly"
    & docker run --rm --network $networkName --mount $configMount --mount $certificateMount --entrypoint nginx $proxyInfo[0].Config.Image -t
    if ($LASTEXITCODE -ne 0) {
        throw 'Nginx rejected the candidate certificate or configuration.'
    }

    if ($originalCertificateExists -and $originalKeyExists) {
        Copy-Item -LiteralPath $activeCertificate -Destination (Join-Path $workingDirectory 'previous.crt')
        Copy-Item -LiteralPath $activeKey -Destination (Join-Path $workingDirectory 'previous.key')
    }

    $deploymentStarted = $true
    Copy-Item -LiteralPath $candidateCertificate -Destination $activeCertificate -Force
    Copy-Item -LiteralPath $candidateKey -Destination $activeKey -Force

    Invoke-Compose -Arguments @('exec', '-T', 'https-proxy', 'nginx', '-t')
    Invoke-Compose -Arguments @('exec', '-T', 'https-proxy', 'nginx', '-s', 'reload')
    Start-Sleep -Seconds 2

    $httpStatus = & curl.exe --fail --silent --show-error --output NUL --write-out '%{http_code}|%{content_type}' $healthUrl
    if ($LASTEXITCODE -ne 0 -or $httpStatus -notmatch '^200\|application/javascript') {
        throw "HTTPS health check failed for /sw.js: $httpStatus"
    }

    if ($usingPendingCertificate -and (Test-Path -LiteralPath $pendingDirectory)) {
        Remove-Item -LiteralPath $pendingDirectory -Recurse -Force
    }

    Write-Output "Certificate deployed and trusted HTTPS /sw.js check passed (HTTP $($httpStatus.Split('|')[0])). Expires $($candidateStatus.NotAfter)."
} catch {
    if ($deploymentStarted) {
        try {
            Restore-PreviousCertificate
            Write-Warning 'The previous certificate was restored and Nginx reloaded.'
        } catch {
            Write-Error "Certificate rollback failed: $($_.Exception.Message)"
        }
    }
    throw
} finally {
    if (Test-Path -LiteralPath $workingDirectory) {
        Remove-Item -LiteralPath $workingDirectory -Recurse -Force
    }
}
