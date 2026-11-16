import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const SOURCE = `using System;
using System.IO;
using System.Threading;

class FakeAdb {
  static int Main(string[] args) {
    string dir = AppDomain.CurrentDomain.BaseDirectory;
    string joined = string.Join(" ", args);
    if (joined.StartsWith("devices")) {
      Console.Out.Write("List of devices attached\\r\\n");
      string list = Path.Combine(dir, "devices.txt");
      if (File.Exists(list)) Console.Out.Write(File.ReadAllText(list));
      Console.Out.Write("\\r\\n");
      return 0;
    }
    if (joined.Contains("wm size")) {
      Console.Out.Write("Physical size: 1080x2400\\r\\n");
      return 0;
    }
    if (joined.Contains("screenrecord")) {
      string screen = Path.Combine(dir, "screen.h264");
      DateTime end = DateTime.Now.AddSeconds(120);
      bool sent = false;
      while (DateTime.Now < end) {
        if (!sent && File.Exists(screen)) {
          byte[] bytes = File.ReadAllBytes(screen);
          Stream output = Console.OpenStandardOutput();
          output.Write(bytes, 0, bytes.Length);
          output.Flush();
          sent = true;
        }
        Thread.Sleep(200);
      }
      return 0;
    }
    if (args.Length > 0 && args[args.Length - 1] == "shell") {
      string line;
      while ((line = Console.In.ReadLine()) != null) {
        int at = line.LastIndexOf("echo ");
        if (at >= 0) {
          Console.Out.Write(line.Substring(at + 5).Trim() + "\\n");
          Console.Out.Flush();
        }
      }
      return 0;
    }
    return 0;
  }
}
`

function findFfmpeg() {
  const found = spawnSync('where', ['ffmpeg'], { encoding: 'utf8', windowsHide: true })
  return found.status === 0 ? found.stdout.split(/\r?\n/).find(Boolean) ?? null : null
}

export function buildFakeAdb(dir) {
  mkdirSync(dir, { recursive: true })
  const csc = join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe')
  const ffmpeg = findFfmpeg()
  const out = { adb: join(dir, 'adb.exe'), screen: join(dir, 'screen.h264'), csc: existsSync(csc), ffmpeg: !!ffmpeg }
  if (out.csc) {
    writeFileSync(join(dir, 'FakeAdb.cs'), SOURCE)
    const res = spawnSync(csc, ['/nologo', '/target:exe', `/out:${out.adb}`, join(dir, 'FakeAdb.cs')], { encoding: 'utf8', windowsHide: true })
    out.cscStatus = res.status
  }
  if (ffmpeg) {
    const boxes = [
      'drawbox=x=0:y=0:w=540:h=44:color=0x0b1a2b:t=fill',
      'drawbox=x=40:y=140:w=460:h=160:color=0x2a4d73:t=fill',
      ...[0, 1, 2, 3].map((i) => `drawbox=x=${48 + i * 116}:y=880:w=96:h=96:color=0x${['4f8cff', '3fbf7f', 'f2a33a', 'e5566b'][i]}:t=fill`),
      ...[0, 1, 2, 3].map((i) => `drawbox=x=${48 + i * 116}:y=1040:w=96:h=96:color=0x${['8e6cf0', '36b5c9', 'c9c9c9', '6a8a3a'][i]}:t=fill`)
    ].join(',')
    const res = spawnSync(ffmpeg, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', `color=c=0x16324f:s=540x1200:r=10:d=1,${boxes}`, '-c:v', 'libx264', '-profile:v', 'baseline', '-pix_fmt', 'yuv420p', '-g', '10', '-f', 'h264', join(dir, 'screen-src.h264')], { encoding: 'utf8', windowsHide: true })
    out.ffmpegStatus = res.status
  }
  out.ok = existsSync(out.adb) && existsSync(join(dir, 'screen-src.h264'))
  out.screenSource = join(dir, 'screen-src.h264')
  return out
}
