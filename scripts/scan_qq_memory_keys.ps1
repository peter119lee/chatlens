[CmdletBinding()]
param(
    # 留空则自动查找正在运行的 QQ 进程。密钥只存在于运行中的 QQ 内存里，
    # 所以取密钥时必须先打开并登录 QQ。
    [Parameter(Mandatory = $false)]
    [int[]]$ProcessIds = @(),

    [Parameter(Mandatory = $true)]
    [string]$OutputPath
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

if ($null -eq $ProcessIds -or @($ProcessIds).Count -eq 0) {
    $ProcessIds = @(Get-Process -Name 'QQ' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id)
}

if (@($ProcessIds).Count -eq 0) {
    throw '没有找到正在运行的 QQ 进程。请先打开并登录 QQ，再重试自动获取密钥。'
}

$scannerCode = @'
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

public static class MemoryKeyScanner
{
    private const uint PROCESS_QUERY_INFORMATION = 0x0400;
    private const uint PROCESS_VM_READ = 0x0010;
    private const uint MEM_COMMIT = 0x1000;
    private const uint PAGE_NOACCESS = 0x01;
    private const uint PAGE_GUARD = 0x100;

    [StructLayout(LayoutKind.Sequential)]
    private struct MEMORY_BASIC_INFORMATION64
    {
        public ulong BaseAddress;
        public ulong AllocationBase;
        public uint AllocationProtect;
        public uint __alignment1;
        public ulong RegionSize;
        public uint State;
        public uint Protect;
        public uint Type;
        public uint __alignment2;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(uint dwDesiredAccess, bool bInheritHandle, int dwProcessId);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr hObject);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern UIntPtr VirtualQueryEx(
        IntPtr hProcess,
        UIntPtr lpAddress,
        out MEMORY_BASIC_INFORMATION64 lpBuffer,
        UIntPtr dwLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool ReadProcessMemory(
        IntPtr hProcess,
        UIntPtr lpBaseAddress,
        byte[] lpBuffer,
        UIntPtr nSize,
        out UIntPtr lpNumberOfBytesRead);

    public static int Scan(int[] processIds, string outputPath)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(outputPath)));

        var candidates = new SortedSet<string>(StringComparer.Ordinal);
        foreach (int processId in processIds)
        {
            ScanProcess(processId, candidates);
        }

        File.WriteAllLines(outputPath, candidates);
        return candidates.Count;
    }

    private static void ScanProcess(int processId, ISet<string> candidates)
    {
        IntPtr processHandle = OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, false, processId);
        if (processHandle == IntPtr.Zero)
        {
            return;
        }

        try
        {
            ulong address = 0;
            ulong maxAddress = Environment.Is64BitProcess ? 0x00007FFFFFFEFFFFUL : 0x7fff0000UL;
            int infoSize = Marshal.SizeOf(typeof(MEMORY_BASIC_INFORMATION64));

            while (address < maxAddress)
            {
                MEMORY_BASIC_INFORMATION64 info;
                UIntPtr result = VirtualQueryEx(processHandle, new UIntPtr(address), out info, new UIntPtr((uint)infoSize));
                if (result == UIntPtr.Zero)
                {
                    address += 0x10000;
                    continue;
                }

                ulong nextAddress = info.BaseAddress + info.RegionSize;
                if (IsReadable(info))
                {
                    ScanRegion(processHandle, info.BaseAddress, info.RegionSize, candidates);
                }

                if (nextAddress <= address)
                {
                    break;
                }
                address = nextAddress;
            }
        }
        finally
        {
            CloseHandle(processHandle);
        }
    }

    private static bool IsReadable(MEMORY_BASIC_INFORMATION64 info)
    {
        if (info.State != MEM_COMMIT)
        {
            return false;
        }
        if ((info.Protect & PAGE_GUARD) != 0)
        {
            return false;
        }
        if ((info.Protect & PAGE_NOACCESS) != 0)
        {
            return false;
        }
        return true;
    }

    private static void ScanRegion(IntPtr processHandle, ulong baseAddress, ulong regionSize, ISet<string> candidates)
    {
        const int chunkSize = 1024 * 1024;
        const int overlapSize = 128;
        byte[] readBuffer = new byte[chunkSize + overlapSize];
        byte[] carry = Array.Empty<byte>();
        ulong offset = 0;

        while (offset < regionSize)
        {
            int bytesToRead = (int)Math.Min((ulong)chunkSize, regionSize - offset);
            byte[] chunk = new byte[bytesToRead];
            UIntPtr bytesRead;
            bool ok = ReadProcessMemory(
                processHandle,
                new UIntPtr(baseAddress + offset),
                chunk,
                new UIntPtr((uint)bytesToRead),
                out bytesRead);

            if (ok && bytesRead.ToUInt64() > 0)
            {
                int actualRead = (int)bytesRead.ToUInt64();
                int mergedLength = carry.Length + actualRead;
                if (readBuffer.Length < mergedLength)
                {
                    readBuffer = new byte[mergedLength];
                }

                Buffer.BlockCopy(carry, 0, readBuffer, 0, carry.Length);
                Buffer.BlockCopy(chunk, 0, readBuffer, carry.Length, actualRead);
                ScanAscii(readBuffer, mergedLength, candidates);
                ScanUtf16Le(readBuffer, mergedLength, candidates);

                int newCarryLength = Math.Min(overlapSize, mergedLength);
                carry = new byte[newCarryLength];
                Buffer.BlockCopy(readBuffer, mergedLength - newCarryLength, carry, 0, newCarryLength);
            }

            offset += (ulong)bytesToRead;
        }
    }

    private static void ScanAscii(byte[] buffer, int length, ISet<string> candidates)
    {
        int index = 0;
        while (index < length)
        {
            while (index < length && !IsPrintableAscii(buffer[index]))
            {
                index++;
            }

            int start = index;
            while (index < length && IsPrintableAscii(buffer[index]))
            {
                index++;
            }

            AddCandidate(buffer, start, index - start, candidates);
        }
    }

    private static void ScanUtf16Le(byte[] buffer, int length, ISet<string> candidates)
    {
        int index = 0;
        while (index + 1 < length)
        {
            while (index + 1 < length && !(IsPrintableAscii(buffer[index]) && buffer[index + 1] == 0))
            {
                index++;
            }

            int start = index;
            var bytes = new List<byte>();
            while (index + 1 < length && IsPrintableAscii(buffer[index]) && buffer[index + 1] == 0)
            {
                bytes.Add(buffer[index]);
                index += 2;
            }

            if (bytes.Count == 16 || bytes.Count == 32)
            {
                AddCandidate(bytes.ToArray(), 0, bytes.Count, candidates);
            }

            if (index == start)
            {
                index++;
            }
        }
    }

    private static void AddCandidate(byte[] buffer, int start, int candidateLength, ISet<string> candidates)
    {
        if (candidateLength != 16 && candidateLength != 32)
        {
            return;
        }

        string value = Encoding.ASCII.GetString(buffer, start, candidateLength);
        if (HasUsefulShape(value))
        {
            candidates.Add(value);
        }
    }

    private static bool HasUsefulShape(string value)
    {
        int distinct = 0;
        bool hasDigit = false;
        bool hasLetter = false;
        bool hasOther = false;
        var seen = new HashSet<char>();

        foreach (char current in value)
        {
            if (seen.Add(current))
            {
                distinct++;
            }
            if (char.IsDigit(current))
            {
                hasDigit = true;
            }
            else if ((current >= 'a' && current <= 'z') || (current >= 'A' && current <= 'Z'))
            {
                hasLetter = true;
            }
            else
            {
                hasOther = true;
            }
        }

        if (distinct < 6)
        {
            return false;
        }

        return (hasDigit && hasLetter) || hasOther;
    }

    private static bool IsPrintableAscii(byte value)
    {
        return value >= 32 && value <= 126;
    }
}
'@

if (-not ([System.Management.Automation.PSTypeName]'MemoryKeyScanner').Type) {
    Add-Type -TypeDefinition $scannerCode -Language CSharp
}

$candidateCount = [MemoryKeyScanner]::Scan($ProcessIds, $OutputPath)
Write-Output "candidates=$candidateCount pids=$(@($ProcessIds) -join ',')"
