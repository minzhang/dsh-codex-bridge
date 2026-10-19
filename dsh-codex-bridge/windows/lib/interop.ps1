#Requires -Version 7.0
# Small native-interop helper for Windows security descriptors, integrity labels,
# temporary WRITE_OWNER provisioning, canonical paths, and hard-link counts.
# The DSH capability grant itself is applied by the installed backend through
# dsh-acl.mjs; this file never invents a sandbox rule.

if (-not ('DshPortableAcl' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;

public static class DshPortableAcl
{
    private const uint SE_FILE_OBJECT = 1;
    private const uint OWNER_SECURITY_INFORMATION = 0x00000001;
    private const uint GROUP_SECURITY_INFORMATION = 0x00000002;
    private const uint DACL_SECURITY_INFORMATION = 0x00000004;
    private const uint LABEL_SECURITY_INFORMATION = 0x00000010;
    private const uint SNAPSHOT_INFORMATION =
        OWNER_SECURITY_INFORMATION | GROUP_SECURITY_INFORMATION |
        DACL_SECURITY_INFORMATION | LABEL_SECURITY_INFORMATION;
    private const uint RESTORE_INFORMATION = DACL_SECURITY_INFORMATION | LABEL_SECURITY_INFORMATION;
    private const uint WRITE_OWNER = 0x00080000;
    private const uint FILE_FLAG_BACKUP_SEMANTICS = 0x02000000;
    private const uint FILE_SHARE_ALL = 0x00000007;
    private const uint OPEN_EXISTING = 3;
    private static readonly IntPtr INVALID_HANDLE_VALUE = new IntPtr(-1);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern uint GetNamedSecurityInfo(
        string objectName, uint objectType, uint securityInfo,
        out IntPtr owner, out IntPtr group, out IntPtr dacl, out IntPtr sacl, out IntPtr descriptor);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool ConvertSecurityDescriptorToStringSecurityDescriptor(
        IntPtr descriptor, uint revision, uint securityInfo,
        out IntPtr text, out uint textLength);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool ConvertStringSecurityDescriptorToSecurityDescriptor(
        string text, uint revision, out IntPtr descriptor, out uint descriptorLength);

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool GetSecurityDescriptorDacl(
        IntPtr descriptor, out bool present, out IntPtr dacl, out bool defaultValue);

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool GetSecurityDescriptorSacl(
        IntPtr descriptor, out bool present, out IntPtr sacl, out bool defaultValue);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern uint SetNamedSecurityInfo(
        string objectName, uint objectType, uint securityInfo,
        IntPtr owner, IntPtr group, IntPtr dacl, IntPtr sacl);

    [DllImport("kernel32.dll")]
    private static extern IntPtr LocalFree(IntPtr memory);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateFileW(
        string fileName, uint desiredAccess, uint shareMode, IntPtr securityAttributes,
        uint creationDisposition, uint flagsAndAttributes, IntPtr templateFile);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetFileInformationByHandle(
        IntPtr handle, out BY_HANDLE_FILE_INFORMATION information);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern uint GetFinalPathNameByHandleW(
        IntPtr handle, StringBuilder path, uint pathLength, uint flags);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    [StructLayout(LayoutKind.Sequential)]
    private struct FILETIME_VALUE
    {
        public uint Low;
        public uint High;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct BY_HANDLE_FILE_INFORMATION
    {
        public uint FileAttributes;
        public FILETIME_VALUE CreationTime;
        public FILETIME_VALUE LastAccessTime;
        public FILETIME_VALUE LastWriteTime;
        public uint VolumeSerialNumber;
        public uint FileSizeHigh;
        public uint FileSizeLow;
        public uint NumberOfLinks;
        public uint FileIndexHigh;
        public uint FileIndexLow;
    }

    private static Win32Exception Win32Error(string operation, string path)
    {
        int code = Marshal.GetLastWin32Error();
        return new Win32Exception(code, operation + " failed for " + path + " (Win32 " + code + ": " + new Win32Exception(code).Message + ")");
    }

    /// <summary>Read owner, group, DACL, and mandatory label only, never the audit SACL.</summary>
    public static string Read(string path)
    {
        IntPtr owner, group, dacl, sacl, descriptor;
        uint result = GetNamedSecurityInfo(
            path, SE_FILE_OBJECT, SNAPSHOT_INFORMATION,
            out owner, out group, out dacl, out sacl, out descriptor);
        if (result != 0)
        {
            throw new Win32Exception((int)result, "GetNamedSecurityInfo failed for " + path + " (Win32 " + result + ": " + new Win32Exception((int)result).Message + ")");
        }
        try
        {
            IntPtr text;
            uint textLength;
            if (!ConvertSecurityDescriptorToStringSecurityDescriptor(
                    descriptor, 1, SNAPSHOT_INFORMATION, out text, out textLength))
            {
                throw Win32Error("ConvertSecurityDescriptorToStringSecurityDescriptor", path);
            }
            try
            {
                return Marshal.PtrToStringUni(text);
            }
            finally
            {
                if (text != IntPtr.Zero) LocalFree(text);
            }
        }
        finally
        {
            if (descriptor != IntPtr.Zero) LocalFree(descriptor);
        }
    }

    /// <summary>Restore the DACL and mandatory label from a snapshot. Owner is never written.</summary>
    public static void WriteDaclAndLabel(string path, string sddl)
    {
        IntPtr descriptor;
        uint descriptorLength;
        if (!ConvertStringSecurityDescriptorToSecurityDescriptor(sddl, 1, out descriptor, out descriptorLength))
        {
            throw Win32Error("ConvertStringSecurityDescriptorToSecurityDescriptor", path);
        }
        try
        {
            IntPtr dacl, sacl;
            bool present, defaultValue;
            if (!GetSecurityDescriptorDacl(descriptor, out present, out dacl, out defaultValue))
            {
                throw Win32Error("GetSecurityDescriptorDacl", path);
            }
            if (!present)
            {
                throw new InvalidOperationException("Refusing to restore a null/absent DACL for " + path);
            }
            if (!GetSecurityDescriptorSacl(descriptor, out present, out sacl, out defaultValue))
            {
                throw Win32Error("GetSecurityDescriptorSacl", path);
            }
            IntPtr labelPointer = present ? sacl : IntPtr.Zero;
            uint result = SetNamedSecurityInfo(
                path, SE_FILE_OBJECT, RESTORE_INFORMATION,
                IntPtr.Zero, IntPtr.Zero, dacl, labelPointer);
            if (result != 0)
            {
                throw new Win32Exception((int)result, "SetNamedSecurityInfo (DACL+label) failed for " + path + " (Win32 " + result + ": " + new Win32Exception((int)result).Message + ")");
            }
        }
        finally
        {
            LocalFree(descriptor);
        }
    }

    /// <summary>Set only the mandatory label; any non-label SACL entries are left untouched.</summary>
    public static void WriteLabel(string path, bool directory)
    {
        string sddl = directory ? "S:(ML;OICI;NW;;;LW)" : "S:(ML;;NW;;;LW)";
        IntPtr descriptor;
        uint descriptorLength;
        if (!ConvertStringSecurityDescriptorToSecurityDescriptor(sddl, 1, out descriptor, out descriptorLength))
        {
            throw Win32Error("ConvertStringSecurityDescriptorToSecurityDescriptor (label)", path);
        }
        try
        {
            IntPtr sacl;
            bool present, defaultValue;
            if (!GetSecurityDescriptorSacl(descriptor, out present, out sacl, out defaultValue))
            {
                throw Win32Error("GetSecurityDescriptorSacl (label)", path);
            }
            uint result = SetNamedSecurityInfo(
                path, SE_FILE_OBJECT, LABEL_SECURITY_INFORMATION,
                IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, sacl);
            if (result != 0)
            {
                throw new Win32Exception((int)result, "SetNamedSecurityInfo (label) failed for " + path + " (Win32 " + result + ": " + new Win32Exception((int)result).Message + ")");
            }
        }
        finally
        {
            LocalFree(descriptor);
        }
    }

    /// <summary>
    /// Insert one explicit current-user WRITE_OWNER ACE without merging it into an
    /// existing FullControl/Modify ACE. Returns false when an identical explicit ACE
    /// already exists (so the caller must not remove a pre-existing rule).
    /// </summary>
    public static bool AddWriteOwnerAce(string path, string sidText)
    {
        SecurityIdentifier sid = new SecurityIdentifier(sidText);
        RawSecurityDescriptor descriptor = new RawSecurityDescriptor(Read(path));
        if (descriptor.DiscretionaryAcl == null)
        {
            throw new InvalidOperationException("Refusing to provision a temporary WRITE_OWNER ACE on a null DACL: " + path);
        }
        AceFlags flags = AceFlags.ContainerInherit | AceFlags.ObjectInherit;
        if (HasExplicitWriteOwnerAce(descriptor.DiscretionaryAcl, sid, flags))
        {
            return false;
        }
        CommonAce ace = new CommonAce(flags, AceQualifier.AccessAllowed, (int)WRITE_OWNER, sid, false, null);
        descriptor.DiscretionaryAcl.InsertAce(FindWriteOwnerInsertIndex(descriptor.DiscretionaryAcl), ace);
        string sddl = descriptor.GetSddlForm(AccessControlSections.Access);
        ApplyDacl(path, sddl);
        return true;
    }

    /// <summary>
    /// Test seam: apply the same canonical insertion to an SDDL string without
    /// touching a filesystem object. Returns the DACL-only SDDL.
    /// </summary>
    public static string InsertWriteOwnerAceInMemory(string sddl, string sidText)
    {
        SecurityIdentifier sid = new SecurityIdentifier(sidText);
        RawSecurityDescriptor descriptor = new RawSecurityDescriptor(sddl);
        if (descriptor.DiscretionaryAcl == null)
        {
            throw new InvalidOperationException("Cannot insert a WRITE_OWNER ACE into a null DACL.");
        }
        AceFlags flags = AceFlags.ContainerInherit | AceFlags.ObjectInherit;
        if (!HasExplicitWriteOwnerAce(descriptor.DiscretionaryAcl, sid, flags))
        {
            CommonAce ace = new CommonAce(flags, AceQualifier.AccessAllowed, (int)WRITE_OWNER, sid, false, null);
            descriptor.DiscretionaryAcl.InsertAce(FindWriteOwnerInsertIndex(descriptor.DiscretionaryAcl), ace);
        }
        return descriptor.GetSddlForm(AccessControlSections.Access);
    }

    /// <summary>Test seam: remove only the exact explicit WRITE_OWNER ACE from SDDL.</summary>
    public static string RemoveWriteOwnerAceInMemory(string sddl, string sidText)
    {
        SecurityIdentifier sid = new SecurityIdentifier(sidText);
        RawSecurityDescriptor descriptor = new RawSecurityDescriptor(sddl);
        AceFlags flags = AceFlags.ContainerInherit | AceFlags.ObjectInherit;
        if (descriptor.DiscretionaryAcl != null)
        {
            for (int index = 0; index < descriptor.DiscretionaryAcl.Count; index++)
            {
                QualifiedAce ace = descriptor.DiscretionaryAcl[index] as QualifiedAce;
                if (ace != null &&
                    ace.AceType == AceType.AccessAllowed &&
                    !ace.AceFlags.HasFlag(AceFlags.Inherited) &&
                    ace.AceFlags == flags &&
                    ace.AccessMask == WRITE_OWNER &&
                    ace.SecurityIdentifier.Equals(sid))
                {
                    descriptor.DiscretionaryAcl.RemoveAce(index);
                    break;
                }
            }
        }
        return descriptor.GetSddlForm(AccessControlSections.Access);
    }

    /// <summary>Remove only the exact explicit WRITE_OWNER ACE this helper would add.</summary>
    public static bool RemoveWriteOwnerAce(string path, string sidText)
    {
        SecurityIdentifier sid = new SecurityIdentifier(sidText);
        RawSecurityDescriptor descriptor = new RawSecurityDescriptor(Read(path));
        if (descriptor.DiscretionaryAcl == null) return false;
        AceFlags flags = AceFlags.ContainerInherit | AceFlags.ObjectInherit;
        for (int index = 0; index < descriptor.DiscretionaryAcl.Count; index++)
        {
            QualifiedAce ace = descriptor.DiscretionaryAcl[index] as QualifiedAce;
            if (ace == null) continue;
            if (ace.AceType == AceType.AccessAllowed &&
                !ace.AceFlags.HasFlag(AceFlags.Inherited) &&
                ace.AceFlags == flags &&
                ace.AccessMask == WRITE_OWNER &&
                ace.SecurityIdentifier.Equals(sid))
            {
                descriptor.DiscretionaryAcl.RemoveAce(index);
                string sddl = descriptor.GetSddlForm(AccessControlSections.Access);
                ApplyDacl(path, sddl);
                return true;
            }
        }
        return false;
    }

    /// <summary>
    /// Canonical insertion point for the temporary Allow: after every explicit
    /// Deny, and before the inherited tail when the DACL is canonical. If an
    /// unusual DACL places inherited entries before an explicit Deny, deny safety
    /// wins: insert after the last explicit Deny.
    /// </summary>
    private static int FindWriteOwnerInsertIndex(RawAcl acl)
    {
        int firstInherited = -1;
        int lastExplicitDeny = -1;
        for (int index = 0; index < acl.Count; index++)
        {
            QualifiedAce ace = acl[index] as QualifiedAce;
            if (ace == null) continue;
            if (ace.AceFlags.HasFlag(AceFlags.Inherited))
            {
                if (firstInherited < 0) firstInherited = index;
            }
            else if (ace.AceType == AceType.AccessDenied)
            {
                lastExplicitDeny = index;
            }
        }
        int insertAt = firstInherited >= 0 ? firstInherited : acl.Count;
        if (lastExplicitDeny >= 0 && insertAt <= lastExplicitDeny)
        {
            insertAt = lastExplicitDeny + 1;
        }
        return insertAt;
    }

    private static bool HasExplicitWriteOwnerAce(RawAcl acl, SecurityIdentifier sid, AceFlags flags)
    {
        foreach (GenericAce entry in acl)
        {
            QualifiedAce ace = entry as QualifiedAce;
            if (ace == null) continue;
            if (ace.AceType == AceType.AccessAllowed &&
                !ace.AceFlags.HasFlag(AceFlags.Inherited) &&
                ace.AceFlags == flags &&
                ace.AccessMask == WRITE_OWNER &&
                ace.SecurityIdentifier.Equals(sid))
            {
                return true;
            }
        }
        return false;
    }

    private static void ApplyDacl(string path, string sddl)
    {
        IntPtr descriptor;
        uint descriptorLength;
        if (!ConvertStringSecurityDescriptorToSecurityDescriptor(sddl, 1, out descriptor, out descriptorLength))
        {
            throw Win32Error("ConvertStringSecurityDescriptorToSecurityDescriptor (DACL)", path);
        }
        try
        {
            IntPtr dacl;
            bool present, defaultValue;
            if (!GetSecurityDescriptorDacl(descriptor, out present, out dacl, out defaultValue))
            {
                throw Win32Error("GetSecurityDescriptorDacl (DACL)", path);
            }
            if (!present)
            {
                throw new InvalidOperationException("Refusing to write an absent DACL for " + path);
            }
            uint result = SetNamedSecurityInfo(
                path, SE_FILE_OBJECT, DACL_SECURITY_INFORMATION,
                IntPtr.Zero, IntPtr.Zero, dacl, IntPtr.Zero);
            if (result != 0)
            {
                throw new Win32Exception((int)result, "SetNamedSecurityInfo (DACL) failed for " + path + " (Win32 " + result + ": " + new Win32Exception((int)result).Message + ")");
            }
        }
        finally
        {
            LocalFree(descriptor);
        }
    }

    /// <summary>Number of hard links for a file (a directory reports its own link count).</summary>
    public static uint LinkCount(string path)
    {
        IntPtr handle = CreateFileW(
            path, 0, FILE_SHARE_ALL, IntPtr.Zero, OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS, IntPtr.Zero);
        if (handle == INVALID_HANDLE_VALUE)
        {
            throw Win32Error("CreateFileW", path);
        }
        try
        {
            BY_HANDLE_FILE_INFORMATION information;
            if (!GetFileInformationByHandle(handle, out information))
            {
                throw Win32Error("GetFileInformationByHandle", path);
            }
            return information.NumberOfLinks;
        }
        finally
        {
            CloseHandle(handle);
        }
    }

    /// <summary>Canonical final path (resolves 8.3 aliases and drive-relative spellings).</summary>
    public static string FinalPath(string path)
    {
        IntPtr handle = CreateFileW(
            path, 0, FILE_SHARE_ALL, IntPtr.Zero, OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS, IntPtr.Zero);
        if (handle == INVALID_HANDLE_VALUE)
        {
            throw Win32Error("CreateFileW", path);
        }
        try
        {
            int capacity = 1024;
            while (capacity <= 32768)
            {
                StringBuilder buffer = new StringBuilder(capacity);
                uint length = GetFinalPathNameByHandleW(handle, buffer, (uint)buffer.Capacity, 0);
                if (length == 0)
                {
                    throw Win32Error("GetFinalPathNameByHandleW", path);
                }
                if (length < buffer.Capacity)
                {
                    string result = buffer.ToString(0, (int)length);
                    if (result.StartsWith(@"\\?\UNC\", StringComparison.OrdinalIgnoreCase))
                    {
                        return @"\\" + result.Substring(8);
                    }
                    if (result.StartsWith(@"\\?\", StringComparison.OrdinalIgnoreCase))
                    {
                        return result.Substring(4);
                    }
                    return result;
                }
                capacity = (int)length + 1;
            }
            throw new InvalidOperationException("Final path is too long for " + path);
        }
        finally
        {
            CloseHandle(handle);
        }
    }
}
'@
}

function Read-SecurityDescriptor {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string]$Path)
    return [DshPortableAcl]::Read($Path)
}

function Write-SecurityDescriptorDaclAndLabel {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Sddl
    )
    [DshPortableAcl]::WriteDaclAndLabel($Path, $Sddl)
}

function Write-IntegrityLabel {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][bool]$IsDirectory
    )
    [DshPortableAcl]::WriteLabel($Path, $IsDirectory)
}

function Add-TemporaryWriteOwnerAce {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Sid
    )
    return [DshPortableAcl]::AddWriteOwnerAce($Path, $Sid)
}

function Remove-TemporaryWriteOwnerAce {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Sid
    )
    return [DshPortableAcl]::RemoveWriteOwnerAce($Path, $Sid)
}

function Insert-TemporaryWriteOwnerAceInMemory {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$Sddl,
        [Parameter(Mandatory = $true)][string]$Sid
    )
    return [DshPortableAcl]::InsertWriteOwnerAceInMemory($Sddl, $Sid)
}

function Remove-TemporaryWriteOwnerAceInMemory {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$Sddl,
        [Parameter(Mandatory = $true)][string]$Sid
    )
    return [DshPortableAcl]::RemoveWriteOwnerAceInMemory($Sddl, $Sid)
}

function Get-FileLinkCount {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string]$Path)
    return [DshPortableAcl]::LinkCount($Path)
}

function Get-PathFinalName {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string]$Path)
    return [DshPortableAcl]::FinalPath($Path)
}

function Test-ReparsePoint {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string]$Path)
    if (-not [IO.File]::Exists($Path) -and -not [IO.Directory]::Exists($Path)) {
        throw "Path not found: $Path"
    }
    return (([IO.File]::GetAttributes($Path) -band [IO.FileAttributes]::ReparsePoint) -ne 0)
}

function Assert-NoReparseAncestors {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string]$Path)

    $full = [IO.Path]::GetFullPath($Path)
    $cursor = $full.TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
    if (-not $cursor) { $cursor = [IO.Path]::GetPathRoot($full) }

    while ($true) {
        if ([IO.File]::Exists($cursor) -or [IO.Directory]::Exists($cursor)) {
            if (([IO.File]::GetAttributes($cursor) -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw "Reparse point/junction is not supported (including ancestor aliases): $cursor"
            }
        }
        $parent = [IO.Path]::GetDirectoryName($cursor)
        if ([string]::IsNullOrEmpty($parent) -or $parent -eq $cursor) { break }
        $cursor = $parent
    }
}

function Get-CanonicalPath {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string]$Path)

    $full = [IO.Path]::GetFullPath($Path)
    Assert-NoReparseAncestors -Path $full
    $final = Get-PathFinalName -Path $full
    if ($final.Length -gt 3) { return $final.TrimEnd('\') }
    return $final
}
