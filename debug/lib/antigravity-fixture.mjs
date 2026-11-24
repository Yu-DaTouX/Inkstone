import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

export function installAntigravityFixture(box) {
  const dir = join(box.home, 'AppData', 'Local', 'agy', 'bin')
  mkdirSync(dir, { recursive: true })
  const fixture = join(dir, 'fixture.cs')
  const executable = join(dir, 'agy.exe')
  const quotaState = join(dir, 'quota-state.txt')
  const effortFailure = join(dir, 'effort-failure.txt')
  const literal = (value) => `@"${value.replaceAll('"', '""')}"`
  const quota = { status: 'SUCCESS', num_turns: 0, conversation_id: '', command: { name: 'usage', data: { groups: [
    { name: 'Gemini Models', description: 'Models within this group: Gemini Pro · Fixture, Gemini Flash · Fixture', buckets: [
      { id: 'gemini-5h', name: 'Five Hour Limit Remaining', window: '5h', remaining_fraction: 0.925, reset_time: new Date(Date.now() + 3_600_000).toISOString() },
      { id: 'gemini-weekly', name: 'Weekly Limit Remaining', window: 'weekly', remaining_fraction: 0.78, reset_time: new Date(Date.now() + 7 * 86_400_000).toISOString() }
    ] },
    { name: 'Claude and GPT models', description: 'Models within this group: Claude Sonnet · Fixture', buckets: [
      { id: '3p-5h', name: 'Five Hour Limit Remaining', window: '5h', remaining_fraction: 1, reset_time: '1970-01-01T00:00:00Z' },
      { id: '3p-weekly', name: 'Weekly Limit Remaining', window: 'weekly', remaining_fraction: 1, reset_time: '0001-01-01T00:00:00Z' }
    ] },
    { name: 'Gemini 4 Argon', description: 'For paid Pro plans, Argon quota is separate.', buckets: [
      { id: 'gemini-argon-wtu-weekly', name: 'Gemini 4 Argon Weekly Limit', window: 'weekly', remaining_fraction: 1, reset_time: new Date(Date.now() + 7 * 86_400_000).toISOString() }
    ] }
  ] } } }
  writeFileSync(fixture, `using System;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Threading.Tasks;
class Fixture {
  static int Main(string[] args) {
    if (args.Length == 1 && args[0] == "--version") { Console.WriteLine("1.5.13"); return 0; }
    if (args.Length == 10 && args[0] == "--sandbox" && args[3] == "--disable-slash-commands=false" && args[4] == "--print" && args[5] == "/usage" && args[6] == "--output-format" && args[7] == "json") {
      Console.OutputEncoding = new UTF8Encoding(false);
      var quotaState = ${literal(quotaState)};
      if (File.Exists(quotaState)) {
        var state = File.ReadAllText(quotaState);
        if (state == "offline") { Console.Error.WriteLine("fixture network unavailable"); return 1; }
        if (state == "signed-out") { Console.Error.WriteLine("Authentication required"); return 2; }
      }
      Console.WriteLine(${literal(JSON.stringify(quota))}); return 0;
    }
    if (args.Length != 2 || args[0] != "acp" || args[1] != "--sandbox") return 2;
    var settings = new ProcessStartInfo(${literal(process.execPath)}, ${literal(`"${resolve('debug/lib/fake-antigravity.mjs')}" "--effort-failure=${effortFailure}"`)}) {
      UseShellExecute = false, RedirectStandardInput = true, RedirectStandardOutput = true, CreateNoWindow = true
    };
    using (var child = Process.Start(settings)) {
      Task.Factory.StartNew(() => {
        try {
          using (var source = new StreamReader(Console.OpenStandardInput(), Encoding.UTF8))
          using (var sink = new StreamWriter(child.StandardInput.BaseStream, new UTF8Encoding(false)) { AutoFlush = true }) {
            string line;
            while ((line = source.ReadLine()) != null) sink.WriteLine(line);
          }
        } catch (IOException) {}
      });
      using (var source = new StreamReader(child.StandardOutput.BaseStream, Encoding.UTF8))
      using (var sink = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false)) { AutoFlush = true }) {
        string line;
        while ((line = source.ReadLine()) != null) sink.WriteLine(line);
      }
      child.WaitForExit();
      return child.ExitCode;
    }
  }
}`)
  const csc = join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe')
  const compile = spawnSync(csc, ['/nologo', '/target:exe', `/out:${executable}`, fixture], { encoding: 'utf8', windowsHide: true })
  assert.equal(compile.status, 0, String(compile.error ?? compile.stdout ?? compile.stderr))
  return { quotaState, effortFailure }
}
