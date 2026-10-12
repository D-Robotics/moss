import path from 'node:path';
import { hostShellInvocation, type ResolvedHostShell } from '../utils/host-shell.js';

// The owner joins an anonymous Job before dispatching user code. The handle is
// noninheritable and stays open until owner process exit, including normal exit.
// Explicitly closing it in the owner would kill that owner and lose its exit code.
const jobSetup = String.raw`
$mossAssemblyName = New-Object Reflection.AssemblyName('MossBackgroundJob')
if ($PSVersionTable.PSEdition -eq 'Core') {
 $mossAssembly = [Reflection.Emit.AssemblyBuilder]::DefineDynamicAssembly($mossAssemblyName, [Reflection.Emit.AssemblyBuilderAccess]::Run)
} else {
 $mossAssembly = [AppDomain]::CurrentDomain.DefineDynamicAssembly($mossAssemblyName, [Reflection.Emit.AssemblyBuilderAccess]::Run)
}
$mossModule = $mossAssembly.DefineDynamicModule('Native')
$mossTypeBuilder = $mossModule.DefineType('MossBackgroundJobNative', [Reflection.TypeAttributes]'Public,Abstract,Sealed')
function Add-MossJobApi([string]$name, [type]$returnType, [type[]]$argumentTypes) {
 $method = $mossTypeBuilder.DefinePInvokeMethod($name, 'kernel32.dll', [Reflection.MethodAttributes]'Public,Static,PinvokeImpl', [Reflection.CallingConventions]::Standard, $returnType, $argumentTypes, [Runtime.InteropServices.CallingConvention]::Winapi, [Runtime.InteropServices.CharSet]::Unicode)
 $method.SetImplementationFlags($method.GetMethodImplementationFlags() -bor [Reflection.MethodImplAttributes]::PreserveSig)
}
Add-MossJobApi 'CreateJobObjectW' ([IntPtr]) @([IntPtr], [IntPtr])
Add-MossJobApi 'SetInformationJobObject' ([bool]) @([IntPtr], [int], [IntPtr], [uint32])
Add-MossJobApi 'AssignProcessToJobObject' ([bool]) @([IntPtr], [IntPtr])
Add-MossJobApi 'GetHandleInformation' ([bool]) @([IntPtr], [uint32].MakeByRefType())
Add-MossJobApi 'CloseHandle' ([bool]) @([IntPtr])
$mossNative = $mossTypeBuilder.CreateType()
$mossOwnedJob = $mossNative::CreateJobObjectW([IntPtr]::Zero, [IntPtr]::Zero)
if ($mossOwnedJob -eq [IntPtr]::Zero) { throw 'CreateJobObjectW failed' }
try {
 $mossFlags = [uint32]0
 if (-not $mossNative::GetHandleInformation($mossOwnedJob, [ref]$mossFlags)) { throw 'GetHandleInformation failed' }
 if (($mossFlags -band 1) -ne 0) { throw 'Job handle must not be inherited' }
 # Windows ABI: BasicLimitInformation 64/48 + IO_COUNTERS 48 + four SIZE_T.
 $mossInfoSize = if ([IntPtr]::Size -eq 8) { 144 } else { 112 }
 $mossInfo = [Runtime.InteropServices.Marshal]::AllocHGlobal($mossInfoSize)
 try {
  [Runtime.InteropServices.Marshal]::Copy((New-Object byte[] $mossInfoSize), 0, $mossInfo, $mossInfoSize)
  [Runtime.InteropServices.Marshal]::WriteInt32($mossInfo, 16, 0x2000)
  if (-not $mossNative::SetInformationJobObject($mossOwnedJob, 9, $mossInfo, $mossInfoSize)) { throw 'SetInformationJobObject failed' }
 } finally { [Runtime.InteropServices.Marshal]::FreeHGlobal($mossInfo) }
 $mossSelf = [Diagnostics.Process]::GetCurrentProcess()
 try {
  if (-not $mossNative::AssignProcessToJobObject($mossOwnedJob, $mossSelf.Handle)) { throw 'AssignProcessToJobObject failed' }
 } finally { $mossSelf.Dispose() }
} catch { $null = $mossNative::CloseHandle($mossOwnedJob); throw }
`;

const decoded = (value: string): string =>
  `[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(value).toString('base64')}'))`;

/** Only the background owner changes. Approval, env, cwd, deadlines and kill target stay with its caller. */
export function backgroundShellInvocation(
  command: string,
  shell: ResolvedHostShell,
  cwd?: string
): {
  executable: string;
  args: string[];
  windowsVerbatimArguments: boolean;
  windowsJobOwner: boolean;
} {
  const original = hostShellInvocation(command, shell);
  if (process.platform !== 'win32') {
    return { ...original, windowsVerbatimArguments: false, windowsJobOwner: false };
  }
  const setup = `try {\n${jobSetup}\n} catch { [Console]::Error.WriteLine($_.Exception.ToString()); exit 1 }\n`;
  if (shell.kind === 'pwsh') {
    return {
      executable: shell.executable,
      args: shell.argsFor(setup + command),
      windowsVerbatimArguments: false,
      windowsJobOwner: true,
    };
  }
  // cmd keeps its actual /d /s /c whole-command argument grammar. Built-in PS5
  // is only a Job owner and byte-preserving stdout/stderr pump; background stdin
  // is already NUL and remains inherited. No pwsh7 lookup, external compiler, or dependency.
  const launch =
    `$mossStartInfo = New-Object Diagnostics.ProcessStartInfo\n` +
    `$mossStartInfo.FileName = ${decoded(original.executable)}\n` +
    `$mossStartInfo.Arguments = ${decoded(original.args.join(' '))}\n` +
    (cwd ? `$mossStartInfo.WorkingDirectory = ${decoded(cwd)}\n` : '') +
    `$mossStartInfo.UseShellExecute = $false\n$mossStartInfo.CreateNoWindow = $true\n` +
    `$mossStartInfo.RedirectStandardOutput = $true\n$mossStartInfo.RedirectStandardError = $true\n` +
    `$mossCommand = [Diagnostics.Process]::Start($mossStartInfo)\n` +
    `$mossOutCopy = $mossCommand.StandardOutput.BaseStream.CopyToAsync([Console]::OpenStandardOutput())\n` +
    `$mossErrCopy = $mossCommand.StandardError.BaseStream.CopyToAsync([Console]::OpenStandardError())\n` +
    `$mossCommand.WaitForExit()\n$null = $mossOutCopy.GetAwaiter().GetResult()\n$null = $mossErrCopy.GetAwaiter().GetResult()\nexit $mossCommand.ExitCode`;
  return {
    executable: path.join(
      process.env.SystemRoot ?? 'C:\\Windows',
      'System32/WindowsPowerShell/v1.0/powershell.exe'
    ),
    args: [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `try {\n$ErrorActionPreference = 'Stop'\n${jobSetup}\n${launch}\n} catch { [Console]::Error.WriteLine($_.Exception.ToString()); exit 1 }`,
    ],
    windowsVerbatimArguments: false,
    windowsJobOwner: true,
  };
}
