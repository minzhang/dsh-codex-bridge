using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

namespace DshBridge {
    // The child joins the job during CreateProcess itself. No runnable (or suspended)
    // unowned child can escape if the bridge dies between creation and bookkeeping.
    public sealed class OwnedRun : IDisposable {
        [StructLayout(LayoutKind.Sequential)] struct Security {
            public int Length; public IntPtr Descriptor; public int Inherit;
        }
        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct Startup {
            public int Size; public string Reserved; public string Desktop; public string Title;
            public uint X, Y, XSize, YSize, XCount, YCount, Fill, Flags;
            public ushort Show, ReservedSize; public IntPtr ReservedBytes, Input, Output, Error;
        }
        [StructLayout(LayoutKind.Sequential)] struct StartupEx {
            public Startup Info; public IntPtr Attributes;
        }
        [StructLayout(LayoutKind.Sequential)] struct ProcessInfo {
            public IntPtr Process, Thread; public uint Pid, Tid;
        }
        [StructLayout(LayoutKind.Sequential)] struct BasicLimit {
            public long ProcessTime, JobTime; public uint Flags;
            public UIntPtr MinWorking, MaxWorking; public uint Active;
            public UIntPtr Affinity; public uint Priority, Scheduling;
        }
        [StructLayout(LayoutKind.Sequential)] struct IoCounters {
            public ulong ReadCount, WriteCount, OtherCount, ReadBytes, WriteBytes, OtherBytes;
        }
        [StructLayout(LayoutKind.Sequential)] struct ExtendedLimit {
            public BasicLimit Basic; public IoCounters Io;
            public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
        }
        [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
        static extern IntPtr CreateJobObjectW(IntPtr security, string name);
        [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
        static extern IntPtr OpenJobObjectW(uint access, bool inherit, string name);
        [DllImport("kernel32.dll", SetLastError=true)]
        static extern bool SetInformationJobObject(IntPtr job, int kind, ref ExtendedLimit data, uint size);
        [DllImport("kernel32.dll", SetLastError=true)]
        static extern bool QueryInformationJobObject(IntPtr job, int kind, IntPtr data, uint size, IntPtr returned);
        [DllImport("kernel32.dll", SetLastError=true)]
        static extern bool TerminateJobObject(IntPtr job, uint code);
        [DllImport("kernel32.dll", SetLastError=true)]
        static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
        [DllImport("kernel32.dll", SetLastError=true)]
        static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr key, IntPtr value, IntPtr size, IntPtr previous, IntPtr returned);
        [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
        [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
        static extern IntPtr CreateFileW(string name, uint access, uint share, ref Security security, uint mode, uint flags, IntPtr template);
        [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
        static extern bool CreateProcessW(string application, StringBuilder command, IntPtr processSecurity, IntPtr threadSecurity,
            bool inherit, uint flags, IntPtr environment, string directory, ref StartupEx startup, out ProcessInfo info);
        [DllImport("kernel32.dll", SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
        [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle, uint timeout);
        [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
        [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetProcessTimes(IntPtr process, out long created, out long exited, out long kernel, out long user);
        [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);

        IntPtr job, process, thread;
        public int Pid { get; private set; }
        public string CreatedUtc { get; private set; }
        static Win32Exception Error(string operation) { return new Win32Exception(Marshal.GetLastWin32Error(), operation); }
        static void Check(bool success, string operation) { if (!success) throw Error(operation); }
        static string Quote(string value) {
            // Windows CommandLineToArgvW quoting; no shell interpretation.
            var result = new StringBuilder("\""); int slashes = 0;
            foreach (char c in value) {
                if (c == '\\') { slashes++; continue; }
                if (c == '"') { result.Append('\\', slashes * 2 + 1); result.Append(c); }
                else { result.Append('\\', slashes); result.Append(c); }
                slashes = 0;
            }
            result.Append('\\', slashes * 2); return result.Append('"').ToString();
        }
        static IntPtr FileHandle(string path, bool input) {
            var security = new Security { Length = Marshal.SizeOf<Security>(), Inherit = 1 };
            var handle = CreateFileW(path, input ? 0x80000000u : 0x40000000u, 7, ref security, input ? 3u : 2u, 0x80, IntPtr.Zero);
            if (handle == new IntPtr(-1)) throw Error("open run capture file");
            return handle;
        }
        public OwnedRun(string jobName, string executable, string[] args, string cwd, string stdin, string stdout, string stderr) {
            IntPtr attributes = IntPtr.Zero, jobs = IntPtr.Zero, handles = IntPtr.Zero;
            IntPtr input = IntPtr.Zero, output = IntPtr.Zero, error = IntPtr.Zero;
            bool attributesReady = false;
            try {
                job = CreateJobObjectW(IntPtr.Zero, jobName);
                if (job == IntPtr.Zero) throw Error("create run job");
                if (Marshal.GetLastWin32Error() == 183) throw new InvalidOperationException("Run job already exists");
                var limits = new ExtendedLimit(); limits.Basic.Flags = 0x2000; // KILL_ON_JOB_CLOSE, no breakaway.
                Check(SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf<ExtendedLimit>()), "set run job containment");
                input = FileHandle(stdin, true); output = FileHandle(stdout, false); error = FileHandle(stderr, false);
                IntPtr size = IntPtr.Zero;
                InitializeProcThreadAttributeList(IntPtr.Zero, 2, 0, ref size);
                attributes = Marshal.AllocHGlobal(size);
                Check(InitializeProcThreadAttributeList(attributes, 2, 0, ref size), "initialize child attributes");
                attributesReady = true;
                jobs = Marshal.AllocHGlobal(IntPtr.Size); Marshal.WriteIntPtr(jobs, job);
                handles = Marshal.AllocHGlobal(3 * IntPtr.Size);
                Marshal.WriteIntPtr(handles, 0, input); Marshal.WriteIntPtr(handles, IntPtr.Size, output); Marshal.WriteIntPtr(handles, 2 * IntPtr.Size, error);
                Check(UpdateProcThreadAttribute(attributes, 0, new IntPtr(0x2000D), jobs, new IntPtr(IntPtr.Size), IntPtr.Zero, IntPtr.Zero), "attach run job at process creation");
                Check(UpdateProcThreadAttribute(attributes, 0, new IntPtr(0x20002), handles, new IntPtr(3 * IntPtr.Size), IntPtr.Zero, IntPtr.Zero), "restrict inherited handles");
                var startup = new StartupEx();
                startup.Info.Size = Marshal.SizeOf<StartupEx>(); startup.Info.Flags = 0x100;
                startup.Info.Input = input; startup.Info.Output = output; startup.Info.Error = error; startup.Attributes = attributes;
                var command = new StringBuilder(Quote(executable));
                foreach (var arg in args) command.Append(' ').Append(Quote(arg));
                ProcessInfo created;
                Check(CreateProcessW(executable, command, IntPtr.Zero, IntPtr.Zero, true,
                    0x80000 | 0x08000000 | 4, IntPtr.Zero, cwd, ref startup, out created), "create contained suspended child");
                process = created.Process; thread = created.Thread; Pid = (int)created.Pid;
                long creation, exit, kernel, user;
                Check(GetProcessTimes(process, out creation, out exit, out kernel, out user), "read child creation identity");
                CreatedUtc = DateTime.FromFileTimeUtc(creation).ToString("o");
            } catch { Dispose(); throw; }
            finally {
                if (attributesReady) DeleteProcThreadAttributeList(attributes);
                foreach (var pointer in new[] { attributes, jobs, handles }) if (pointer != IntPtr.Zero) Marshal.FreeHGlobal(pointer);
                foreach (var handle in new[] { input, output, error }) if (handle != IntPtr.Zero) CloseHandle(handle);
            }
        }
        public void Resume() {
            if (thread == IntPtr.Zero) throw new InvalidOperationException("Child already resumed");
            if (ResumeThread(thread) == uint.MaxValue) throw Error("resume contained child");
            CloseHandle(thread); thread = IntPtr.Zero;
        }
        public bool Exited { get {
            uint state = WaitForSingleObject(process, 0);
            if (state == uint.MaxValue) throw Error("observe contained child");
            return state == 0;
        } }
        public int ExitCode { get {
            uint code; Check(GetExitCodeProcess(process, out code), "read child exit"); return unchecked((int)code);
        } }
        static int Count(IntPtr handle) {
            const int size = 65536;
            IntPtr buffer = Marshal.AllocHGlobal(size);
            try {
                Check(QueryInformationJobObject(handle, 3, buffer, size, IntPtr.Zero), "query owned job processes");
                int assigned = Marshal.ReadInt32(buffer, 0), listed = Marshal.ReadInt32(buffer, 4);
                if (assigned != listed) throw new InvalidOperationException("Incomplete owned process inventory");
                return assigned;
            } finally { Marshal.FreeHGlobal(buffer); }
        }
        public int ActiveCount { get { return Count(job); } }
        public void Terminate() { Check(TerminateJobObject(job, 1), "terminate owned run job"); }
        public static int Inspect(string name) {
            var handle = OpenJobObjectW(4, false, name);
            if (handle == IntPtr.Zero) {
                if (Marshal.GetLastWin32Error() == 2) return 0;
                throw Error("inspect owned run job");
            }
            try { return Count(handle); } finally { CloseHandle(handle); }
        }
        public static int Stop(string name) {
            var handle = OpenJobObjectW(4 | 8, false, name);
            if (handle == IntPtr.Zero) {
                if (Marshal.GetLastWin32Error() == 2) return 0;
                throw Error("open owned run job for stop");
            }
            try {
                Check(TerminateJobObject(handle, 1), "stop owned run job");
                var timer = Stopwatch.StartNew();
                while (Count(handle) != 0 && timer.ElapsedMilliseconds < 10000) System.Threading.Thread.Sleep(50);
                return Count(handle);
            } finally { CloseHandle(handle); }
        }
        public void Dispose() {
            if (job != IntPtr.Zero) { CloseHandle(job); job = IntPtr.Zero; }
            if (thread != IntPtr.Zero) { CloseHandle(thread); thread = IntPtr.Zero; }
            if (process != IntPtr.Zero) { CloseHandle(process); process = IntPtr.Zero; }
        }
    }
}
