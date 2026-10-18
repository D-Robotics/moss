// O158 probe: a fake executable. Writes MARK-<name>.txt next to itself with
// its command line, prints "7" (looks like pwsh 7 to a version probe), exits 0.
using System;
using System.IO;
class P {
  static int Main(string[] a) {
    string self = System.Diagnostics.Process.GetCurrentProcess().MainModule.FileName;
    string dir = Path.GetDirectoryName(self);
    string name = Path.GetFileNameWithoutExtension(self);
    File.AppendAllText(Path.Combine(dir, "MARK-" + name + ".txt"), Environment.CommandLine + "\r\n");
    Console.WriteLine("7");
    return 0;
  }
}
