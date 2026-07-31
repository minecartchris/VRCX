using System;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using Newtonsoft.Json;

namespace VRCX
{
    /// <summary>
    /// Lightweight machine metrics for the plugin system (chatbox stats
    /// readouts, overlays). Deliberately dependency free and cross platform so
    /// it behaves the same on the CEF and Electron builds.
    /// </summary>
    public partial class AppApi
    {
        private static readonly object _systemStatsLock = new object();
        private static TimeSpan _lastTotalProcessorTime = TimeSpan.Zero;
        private static DateTime _lastProcessorSampleAt = DateTime.MinValue;
        private static double _lastCpuPercent;

        /// <summary>
        /// Returns a JSON object with CPU, memory and uptime information:
        /// <c>{ cpuPercent, memoryUsedBytes, memoryTotalBytes, memoryPercent, uptimeSeconds, processorCount }</c>.
        /// Values that cannot be determined on the current platform are 0.
        /// </summary>
        public string GetSystemStats()
        {
            var memoryTotal = 0L;
            var memoryAvailable = 0L;
            try
            {
                ReadMemoryInfo(out memoryTotal, out memoryAvailable);
            }
            catch (Exception ex)
            {
                logger.Debug(ex, "Failed to read memory info");
            }

            var memoryUsed = memoryTotal > 0 ? memoryTotal - memoryAvailable : 0L;
            var memoryPercent = memoryTotal > 0 ? Math.Round(memoryUsed * 100d / memoryTotal, 1) : 0d;

            return JsonConvert.SerializeObject(new
            {
                cpuPercent = Math.Round(SampleCpuPercent(), 1),
                memoryUsedBytes = memoryUsed,
                memoryTotalBytes = memoryTotal,
                memoryPercent,
                uptimeSeconds = Environment.TickCount64 / 1000,
                processorCount = Environment.ProcessorCount
            });
        }

        /// <summary>
        /// Machine-wide CPU load, sampled as the delta of every process's
        /// consumed processor time between calls. The first call has no
        /// previous sample to compare against and returns 0.
        /// </summary>
        private static double SampleCpuPercent()
        {
            lock (_systemStatsLock)
            {
                var now = DateTime.UtcNow;
                var total = TimeSpan.Zero;
                try
                {
                    foreach (var process in Process.GetProcesses())
                    {
                        try
                        {
                            total += process.TotalProcessorTime;
                        }
                        catch
                        {
                            // Access denied or the process exited mid-enumeration.
                        }
                        finally
                        {
                            process.Dispose();
                        }
                    }
                }
                catch (Exception ex)
                {
                    logger.Debug(ex, "Failed to enumerate processes for CPU sampling");
                    return _lastCpuPercent;
                }

                if (_lastProcessorSampleAt == DateTime.MinValue)
                {
                    _lastProcessorSampleAt = now;
                    _lastTotalProcessorTime = total;
                    return 0d;
                }

                var elapsed = (now - _lastProcessorSampleAt).TotalMilliseconds;
                var consumed = (total - _lastTotalProcessorTime).TotalMilliseconds;
                _lastProcessorSampleAt = now;
                _lastTotalProcessorTime = total;

                if (elapsed <= 0 || consumed < 0)
                    return _lastCpuPercent;

                var percent = consumed / (elapsed * Environment.ProcessorCount) * 100d;
                _lastCpuPercent = Math.Clamp(percent, 0d, 100d);
                return _lastCpuPercent;
            }
        }

        private static void ReadMemoryInfo(out long totalBytes, out long availableBytes)
        {
            totalBytes = 0;
            availableBytes = 0;

            if (RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
            {
                var status = new MEMORYSTATUSEX
                {
                    dwLength = (uint)Marshal.SizeOf<MEMORYSTATUSEX>()
                };
                if (GlobalMemoryStatusEx(ref status))
                {
                    totalBytes = (long)status.ullTotalPhys;
                    availableBytes = (long)status.ullAvailPhys;
                    return;
                }
            }
            else if (File.Exists("/proc/meminfo"))
            {
                foreach (var line in File.ReadLines("/proc/meminfo"))
                {
                    if (line.StartsWith("MemTotal:", StringComparison.Ordinal))
                        totalBytes = ParseMemInfoLine(line);
                    else if (line.StartsWith("MemAvailable:", StringComparison.Ordinal))
                        availableBytes = ParseMemInfoLine(line);
                    if (totalBytes > 0 && availableBytes > 0)
                        return;
                }
                if (totalBytes > 0)
                    return;
            }

            // Fallback: the runtime knows how much memory it is allowed to use.
            var info = GC.GetGCMemoryInfo();
            totalBytes = info.TotalAvailableMemoryBytes;
            availableBytes = Math.Max(0, totalBytes - GC.GetTotalMemory(false));
        }

        /// <summary>
        /// Parses a "/proc/meminfo" line such as "MemTotal:  16316412 kB".
        /// </summary>
        private static long ParseMemInfoLine(string line)
        {
            var parts = line.Split(new[] { ' ', '\t' }, StringSplitOptions.RemoveEmptyEntries);
            if (parts.Length < 2)
                return 0;
            return long.TryParse(parts[1], NumberStyles.Integer, CultureInfo.InvariantCulture, out var kilobytes)
                ? kilobytes * 1024
                : 0;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct MEMORYSTATUSEX
        {
            public uint dwLength;
            public uint dwMemoryLoad;
            public ulong ullTotalPhys;
            public ulong ullAvailPhys;
            public ulong ullTotalPageFile;
            public ulong ullAvailPageFile;
            public ulong ullTotalVirtual;
            public ulong ullAvailVirtual;
            public ulong ullAvailExtendedVirtual;
        }

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool GlobalMemoryStatusEx(ref MEMORYSTATUSEX lpBuffer);
    }
}
