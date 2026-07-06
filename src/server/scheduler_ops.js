const path = require("node:path");
const { spawn } = require("node:child_process");
const state = require("./toolkit_state");
const { quotePs } = require("./run_jobs");

const TASK_NAME = "QQSummaryToolkit-Digest";
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/u;

const runPowershell = (commandText) =>
  new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-EncodedCommand",
      Buffer.from(commandText, "utf16le").toString("base64"),
    ], { windowsHide: true });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        const lastLine = stderr.trim().split(/\r?\n/u).filter((line) => line.trim().length > 0).at(-1) ?? "";
        reject(new Error(lastLine.slice(0, 300) || `PowerShell 退出码 ${code}`));
      }
    });
    child.stdin.end();
  });

const getScheduleStatus = async () => {
  const command = [
    "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
    "$ErrorActionPreference = 'Stop'",
    `$task = Get-ScheduledTask -TaskName '${TASK_NAME}' -ErrorAction SilentlyContinue`,
    "if ($null -eq $task) { Write-Output '{\"enabled\":false}'; exit 0 }",
    "$trigger = $task.Triggers | Select-Object -First 1",
    "$at = ''",
    "if ($null -ne $trigger -and $null -ne $trigger.StartBoundary) { $at = ([datetime]$trigger.StartBoundary).ToString('HH:mm') }",
    "$info = Get-ScheduledTaskInfo -TaskName '" + TASK_NAME + "' -ErrorAction SilentlyContinue",
    "$last = if ($null -ne $info -and $info.LastRunTime -gt [datetime]'2000-01-01') { $info.LastRunTime.ToString('yyyy-MM-dd HH:mm') } else { '' }",
    "$state = [string]$task.State",
    "$obj = [pscustomobject]@{ enabled = $true; time = $at; lastRun = $last; state = $state }",
    "$obj | ConvertTo-Json -Compress | Write-Output",
    "exit 0",
  ].join("\n");

  const output = await runPowershell(command);
  try {
    return JSON.parse(output.split(/\r?\n/u).filter((line) => line.trim().startsWith("{")).at(-1) ?? "{}");
  } catch {
    return { enabled: false };
  }
};

// Registers a per-user daily task that runs the standalone summary script directly —
// it does NOT need the control center to be open. StartWhenAvailable makes Task
// Scheduler run a missed occurrence as soon as the machine is back on (catch-up),
// so a shutdown at the scheduled time is not silently skipped.
const enableSchedule = async ({ time, sinceHours }) => {
  const at = String(time ?? "").trim();
  if (!TIME_PATTERN.test(at)) {
    throw new Error("时间格式应为 HH:MM，例如 09:00");
  }
  const hours = Number.parseInt(sinceHours, 10);
  const windowHours = Number.isInteger(hours) && hours >= 1 && hours <= 168 ? hours : 26;

  const script = path.join(state.toolRoot, "scripts", "run_one_click_summary.ps1");
  // -SinceLastRecord continues from the store's coverage instead of a fixed
  // window, so a machine that was off for days doesn't leave a gap; with no
  // store record yet the script itself falls back to the last 26 hours.
  const psArgument = [
    "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File \"\"" + script + "\"\"",
    "-UseWatchlist",
    "-SinceLastRecord",
    "-NoOpenReport",
  ].join(" ");

  const command = [
    "$ErrorActionPreference = 'Stop'",
    `$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ${quotePs(psArgument)} -WorkingDirectory ${quotePs(state.toolRoot)}`,
    `$trigger = New-ScheduledTaskTrigger -Daily -At '${at}'`,
    "$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -DontStopOnIdleEnd -ExecutionTimeLimit (New-TimeSpan -Hours 2) -MultipleInstances IgnoreNew",
    "$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited",
    `Register-ScheduledTask -TaskName '${TASK_NAME}' -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description 'QQ 群消息定时总结（本地只读）' -Force | Out-Null`,
    "Write-Output 'ok'",
    "exit 0",
  ].join("\n");

  await runPowershell(command);
  return { enabled: true, time: at, sinceHours: windowHours };
};

const disableSchedule = async () => {
  const command = [
    "$ErrorActionPreference = 'Stop'",
    `if (Get-ScheduledTask -TaskName '${TASK_NAME}' -ErrorAction SilentlyContinue) { Unregister-ScheduledTask -TaskName '${TASK_NAME}' -Confirm:$false }`,
    "Write-Output 'ok'",
    "exit 0",
  ].join("\n");
  await runPowershell(command);
  return { enabled: false };
};

const runScheduleNow = async () => {
  const command = [
    "$ErrorActionPreference = 'Stop'",
    `if (-not (Get-ScheduledTask -TaskName '${TASK_NAME}' -ErrorAction SilentlyContinue)) { throw '还没有设置定时任务。' }`,
    `Start-ScheduledTask -TaskName '${TASK_NAME}'`,
    "Write-Output 'ok'",
    "exit 0",
  ].join("\n");
  await runPowershell(command);
  return { started: true };
};

module.exports = { getScheduleStatus, enableSchedule, disableSchedule, runScheduleNow };
