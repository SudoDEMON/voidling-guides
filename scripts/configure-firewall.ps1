[CmdletBinding(SupportsShouldProcess)]
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('add', 'remove', 'replace')]
  [string]$Mode,
  [Parameter(Mandatory = $true)]
  [string]$LanCidr,
  [ValidateRange(1, 65535)]
  [int]$Port = 3002,
  [Parameter(Mandatory = $true)]
  [string]$Program,
  [string]$PreviousClients = ''
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function ConvertTo-ClientCidr([string]$Client, [bool]$RequirePrefix) {
  $pattern = if ($RequirePrefix) { '^(\d{1,3}\.){3}\d{1,3}/\d{1,2}$' } else { '^(\d{1,3}\.){3}\d{1,3}(/\d{1,2})?$' }
  if ($Client -notmatch $pattern) { throw "Invalid IPv4 client or CIDR: $Client" }
  $parts = $Client.Split('/')
  $octets = @($parts[0].Split('.') | ForEach-Object { [int]$_ })
  if (@($octets | Where-Object { $_ -gt 255 }).Count) { throw "Invalid IPv4 client: $Client" }
  $prefix = if ($parts.Count -eq 2) { [int]$parts[1] } else { 32 }
  if ($prefix -gt 32) { throw "Invalid IPv4 prefix: $Client" }
  for ($i = 0; $i -lt 4; $i++) {
    $bits = [Math]::Min(8, [Math]::Max(0, $prefix - 8 * $i))
    $mask = if ($bits -eq 0) { 0 } else { (255 -shl (8 - $bits)) -band 255 }
    $octets[$i] = $octets[$i] -band $mask
  }
  return ($octets -join '.') + '/' + $prefix
}

function Get-RuleName([string]$Client) {
  return 'VoidlingGuides-TCP-' + $Port + '-' + ($Client -replace '[./]', '-')
}

# Validate every argument before changing any rules.
$cidr = ConvertTo-ClientCidr $LanCidr $true
$previous = @()
if ($PreviousClients) {
  if ($Mode -ne 'replace') { throw 'Previous clients are only valid with replace.' }
  $previous = @($PreviousClients.Split(',') | ForEach-Object { ConvertTo-ClientCidr $_ $false })
}
$programPath = [IO.Path]::GetFullPath($Program)
if (-not (Test-Path -LiteralPath $programPath -PathType Leaf)) { throw "Node executable not found: $programPath" }
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw 'Open PowerShell or Windows Terminal as administrator, then rerun npm run firewall. Windows sudo is not required.'
}

$ruleName = Get-RuleName $cidr
if ($Mode -eq 'remove') {
  $rule = Get-NetFirewallRule -PolicyStore PersistentStore -Name $ruleName -ErrorAction SilentlyContinue
  if ($rule -and $PSCmdlet.ShouldProcess($ruleName, 'Remove Voidling Guides rule')) {
    $rule | Remove-NetFirewallRule
  }
  Write-Output "Removed Voidling Guides TCP $Port rule for $cidr (if present)."
} else {
  $parameters = @{
    PolicyStore = 'PersistentStore'
    Name = $ruleName
    DisplayName = "Voidling Guides TCP $Port from $cidr"
    Description = 'Managed by voidling-guides npm run firewall.'
    Direction = 'Inbound'
    Action = 'Allow'
    Enabled = 'True'
    Profile = 'Any'
    Protocol = 'TCP'
    LocalPort = $Port
    RemoteAddress = $cidr
    Program = $programPath
    EdgeTraversalPolicy = 'Block'
  }
  if ($PSCmdlet.ShouldProcess("$cidr -> $programPath TCP $Port", 'Allow Voidling Guides LAN access')) {
    if (Get-NetFirewallRule -PolicyStore PersistentStore -Name $ruleName -ErrorAction SilentlyContinue) {
      $displayName = $parameters.DisplayName
      $parameters.Remove('DisplayName')
      Set-NetFirewallRule @parameters -NewDisplayName $displayName | Out-Null
    } else {
      New-NetFirewallRule @parameters | Out-Null
    }
  }
  if ($Mode -eq 'replace') {
    foreach ($client in $previous) {
      $oldName = Get-RuleName $client
      if ($oldName -eq $ruleName) { continue }
      $oldRule = Get-NetFirewallRule -PolicyStore PersistentStore -Name $oldName -ErrorAction SilentlyContinue
      if ($oldRule -and $PSCmdlet.ShouldProcess($oldName, 'Remove previous Voidling Guides rule')) {
        $oldRule | Remove-NetFirewallRule
      }
    }
  }
  Write-Output "Configured Voidling Guides TCP $Port from $cidr for $programPath."
}
