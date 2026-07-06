"use strict";

/* ---------- settings view: QQ paths, keys, LLM config ---------- */

const settingsState = { status: null, models: [], schedule: null, llmDraft: null, llmNotice: null, qqCandidates: [], pathNotice: null };
// One-click NTQQ key recovery lives across re-renders (renderSettingsView rebuilds
// the whole view), so its busy flag and last notice are kept module-level.
const autoKeyState = { busy: false, notice: null };

const openSettingsView = async () => {
  showView("settings");
  settingsState.llmDraft = null;
  settingsState.llmNotice = null;
  settingsState.qqCandidates = [];
  settingsState.pathNotice = null;
  renderSettingsView();
  try {
    settingsState.status = await api("/api/settings");
  } catch (error) {
    setChildren($("#view-settings"),
      el("div", { class: "card" }, el("div", { class: "notice risk" }, `读取设置失败: ${error.message}`)));
    return;
  }
  renderSettingsView();
  try {
    settingsState.schedule = await api("/api/schedule");
  } catch {
    settingsState.schedule = { enabled: false };
  }
  renderSettingsView();
};

const savedTag = (isSaved) =>
  el("span", { class: `tag ${isSaved ? "" : "plain"}` }, isSaved ? "✓ 已保存" : "未保存");

const settingsFeedback = (element, text, isError) => {
  element.textContent = text;
  element.style.color = isError ? "var(--risk)" : "var(--ok)";
};

// Persist the detected/typed QQ path immediately so the key auto-detect (which
// reads the SAVED server-side config) works without a separate save click.
const saveDetectedQqPath = async (candidate) => {
  const result = await api("/api/settings/qq-paths", {
    method: "POST",
    body: JSON.stringify({ ntDbDir: candidate.ntDbDir, ntDataDir: candidate.ntDataDir }),
  });
  settingsState.status = await api("/api/settings");
  return { ntDbDirExists: result.ntDbDirExists };
};

const renderSettingsView = () => {
  const status = settingsState.status;
  if (status === null) {
    setChildren($("#view-settings"), el("div", { class: "card" }, el("div", { class: "empty" }, "正在读取设置…")));
    return;
  }

  /* --- QQ database paths --- */
  const dbInput = el("input", { type: "text", value: status.ntDbDir, placeholder: "例如 C:\\Users\\你\\Documents\\Tencent Files\\你的QQ号\\nt_qq\\nt_db", style: "width:100%" });
  const dataInput = el("input", { type: "text", value: status.ntDataDir, placeholder: "nt_data 目录（媒体导出用，可留空）", style: "width:100%" });
  const pathMsg = el("span", { style: "font-size:13px" });
  if (settingsState.pathNotice !== null) {
    settingsFeedback(pathMsg, settingsState.pathNotice.text, settingsState.pathNotice.isError);
  }
  // Multiple QQ accounts on this machine → one-click switch chips, each saving
  // on click so there is never a separate "save" step.
  const accountRow = settingsState.qqCandidates.length > 1
    ? el("div", { class: "row", style: "margin-bottom:10px;flex-wrap:wrap" },
        el("span", { class: "card-sub", style: "margin:0" }, "选择账号："),
        settingsState.qqCandidates.map((candidate) =>
          el("button", {
            class: `chip ${status.ntDbDir === candidate.ntDbDir ? "on" : ""}`,
            onclick: async () => {
              try {
                const saved = await saveDetectedQqPath(candidate);
                settingsState.pathNotice = {
                  text: saved.ntDbDirExists ? `已切换并保存 QQ ${candidate.qq}。` : `已保存 QQ ${candidate.qq}，但该目录当前不存在。`,
                  isError: !saved.ntDbDirExists,
                };
              } catch (error) {
                settingsState.pathNotice = { text: error.message, isError: true };
              }
              renderSettingsView();
            },
          }, `QQ ${candidate.qq}`)))
    : null;
  const pathsCard = el("div", { class: "card" },
    el("h2", {}, "QQ 数据库路径"),
    el("p", { class: "card-sub" }, "QQNT 的本地数据库目录。工具只会复制这里的文件做只读分析，绝不修改原文件。"),
    el("div", { style: "display:grid;gap:8px;margin-bottom:10px" }, dbInput, dataInput),
    accountRow,
    el("div", { class: "row" },
      el("button", {
        class: "btn small",
        onclick: async (event) => {
          event.target.disabled = true;
          settingsFeedback(pathMsg, "正在探测…", false);
          try {
            const result = await api("/api/settings/detect-qq", { method: "POST" });
            if (result.candidates.length === 0) {
              settingsState.qqCandidates = [];
              settingsState.pathNotice = { text: "没有在默认位置找到，请手动填写路径后点「保存路径」（QQ 设置里可查看文件保存位置）。", isError: true };
            } else {
              settingsState.qqCandidates = result.candidates;
              // Auto-save the first hit so a single-account user is fully one-click.
              const saved = await saveDetectedQqPath(result.candidates[0]);
              settingsState.pathNotice = result.candidates.length > 1
                ? { text: `找到 ${result.candidates.length} 个账号，已默认保存 QQ ${result.candidates[0].qq}；要用其它账号点上面切换即可。`, isError: false }
                : {
                    text: saved.ntDbDirExists
                      ? `已找到并保存 QQ ${result.candidates[0].qq} 的数据库路径，可直接到下面获取密钥。`
                      : `已保存 QQ ${result.candidates[0].qq}，但该 nt_db 目录当前不存在，请检查。`,
                    isError: !saved.ntDbDirExists,
                  };
            }
          } catch (error) {
            settingsState.pathNotice = { text: error.message, isError: true };
          }
          renderSettingsView();
        },
      }, "🔍 自动探测并保存"),
      el("button", {
        class: "btn small primary",
        onclick: async () => {
          try {
            const result = await api("/api/settings/qq-paths", {
              method: "POST",
              body: JSON.stringify({ ntDbDir: dbInput.value, ntDataDir: dataInput.value }),
            });
            settingsState.status = await api("/api/settings");
            settingsState.pathNotice = { text: result.ntDbDirExists ? "已保存。" : "已保存，但该 nt_db 目录当前不存在，请检查。", isError: !result.ntDbDirExists };
          } catch (error) {
            settingsState.pathNotice = { text: error.message, isError: true };
          }
          renderSettingsView();
        },
      }, "保存路径"),
      pathMsg));

  /* --- keys --- */
  const keyRow = (label, which, isSaved, hint) => {
    const input = el("input", { type: "password", placeholder: isSaved ? "已保存 — 粘贴新值可覆盖" : "粘贴后点保存", style: "flex:1;min-width:220px" });
    const msg = el("span", { style: "font-size:13px" });
    const tag = savedTag(isSaved);
    return el("div", { style: "margin-bottom:14px" },
      el("div", { class: "row", style: "margin-bottom:6px" },
        el("strong", {}, label), tag),
      hint,
      el("div", { class: "row" },
        input,
        el("button", {
          class: "btn small primary",
          onclick: async (event) => {
            const button = event.target;
            if (input.value.trim().length === 0) {
              settingsFeedback(msg, "先粘贴密钥。", true);
              return;
            }
            button.disabled = true;
            try {
              await api("/api/settings/keys", { method: "POST", body: JSON.stringify({ [which]: input.value }) });
              input.value = "";
              settingsFeedback(msg, "已加密保存（DPAPI，只有当前 Windows 用户能解密）。", false);
              settingsState.status = await api("/api/settings");
              // Update the tag in place — a full re-render would wipe this feedback line.
              tag.textContent = "✓ 已保存";
              tag.className = "tag";
            } catch (error) {
              settingsFeedback(msg, error.message, true);
            }
            button.disabled = false;
          },
        }, "保存"),
        msg));
  };

  const autoKeyMsg = el("span", { style: "font-size:13px" });
  if (autoKeyState.notice !== null) {
    settingsFeedback(autoKeyMsg, autoKeyState.notice.text, autoKeyState.notice.isError);
  }
  const ntqqKeyHint = el("div", { style: "margin:0 0 8px" },
    el("p", { class: "card-sub", style: "margin:0 0 8px" },
      "推荐「自动获取」：打开并登录 QQ 后点下面的按钮，工具会从本机 QQ 进程内存里读出数据库密钥、验证并保存，全程在本机完成，不联网、不改动 QQ 的任何文件。"),
    el("div", { class: "row" },
      el("button", {
        class: "btn small primary",
        disabled: autoKeyState.busy,
        onclick: async () => {
          if (autoKeyState.busy) {
            return;
          }
          autoKeyState.busy = true;
          autoKeyState.notice = { text: "正在扫描 QQ 内存并验证密钥…（需 QQ 已打开并登录，可能要几分钟，请勿关闭页面）", isError: false };
          renderSettingsView();
          try {
            const result = await api("/api/settings/keys/auto-detect", { method: "POST", body: "{}" });
            autoKeyState.notice = { text: `✓ 已自动获取并保存密钥（从 ${result.candidateCount} 个候选中命中）。`, isError: false };
            settingsState.status = await api("/api/settings");
          } catch (error) {
            autoKeyState.notice = { text: `自动获取失败：${error.message}`, isError: true };
          }
          autoKeyState.busy = false;
          renderSettingsView();
        },
      }, autoKeyState.busy ? "扫描中…" : "🔑 自动获取密钥"),
      autoKeyMsg),
    el("p", { class: "card-sub", style: "margin:8px 0 0" },
      "手动方式（自动获取失败时）：参考开源教程 ",
      el("a", { href: "https://github.com/QQBackup/qq-win-db-key", target: "_blank", rel: "noopener" }, "QQBackup/qq-win-db-key"),
      " 拿到 16 位 key 后，粘贴到下面并保存。"));

  const keysCard = el("div", { class: "card" },
    el("h2", {}, "密钥"),
    el("p", { class: "card-sub" }, "两把密钥都用 Windows DPAPI 加密存在本机 %APPDATA%\\QQSummaryTools\\，不进项目目录，不进 Git。"),
    keyRow("NTQQ_DB_KEY（QQ 数据库解密密钥）", "ntqqKey", status.ntqqKeySaved, ntqqKeyHint),
    keyRow("LLM API Key（AI 总结用，可选）", "llmKey", status.llmKeySaved,
      el("p", { class: "card-sub", style: "margin:0 0 8px" },
        "任何 OpenAI 兼容服务的 key 都行（DeepSeek / OpenAI / 本地 Ollama 等）。不保存则只用本地统计，不做 AI 总结。")));

  /* --- LLM config --- */
  // Inputs read from a draft so re-renders (model chips, schedule refresh)
  // never clobber values the user is still typing.
  const draft = settingsState.llmDraft ?? {};
  const draftPatch = (patch) => {
    settingsState.llmDraft = { ...(settingsState.llmDraft ?? {}), ...patch };
  };
  const urlInput = el("input", {
    type: "text",
    value: draft.baseUrl ?? status.llm.baseUrl,
    placeholder: "https://api.deepseek.com",
    style: "width:280px",
    oninput: (event) => draftPatch({ baseUrl: event.target.value }),
  });
  const modelInput = el("input", {
    type: "text",
    value: draft.model ?? status.llm.model,
    placeholder: "模型名，例如 deepseek-v4-flash",
    style: "width:240px",
    oninput: (event) => draftPatch({ model: event.target.value }),
  });
  const llmMsg = el("span", { style: "font-size:13px" });
  if (settingsState.llmNotice !== null) {
    settingsFeedback(llmMsg, settingsState.llmNotice.text, settingsState.llmNotice.isError);
  }
  const modelChips = el("div", { class: "chips", style: "margin-top:10px" },
    settingsState.models.map((model) =>
      el("button", {
        class: `chip ${modelInput.value === model ? "on" : ""}`,
        onclick: () => {
          draftPatch({ model });
          renderSettingsView();
        },
      }, model)));

  const llmCard = el("div", { class: "card" },
    el("h2", {}, "AI 总结（LLM）"),
    el("div", { class: "row" },
      urlInput,
      modelInput,
      el("button", {
        class: "btn small",
        onclick: async (event) => {
          const button = event.target;
          button.disabled = true;
          settingsFeedback(llmMsg, "正在获取模型列表…", false);
          try {
            // Save the base URL first: the server only sends the stored API key
            // to the saved provider, never to a caller-supplied URL.
            await api("/api/settings/llm", {
              method: "POST",
              body: JSON.stringify({ baseUrl: urlInput.value, model: modelInput.value }),
            });
            settingsState.status = await api("/api/settings");
            const result = await api("/api/llm/models", { method: "POST" });
            settingsState.models = result.models;
            settingsState.llmNotice = { text: `取到 ${result.models.length} 个模型，点选即可填入。`, isError: false };
            renderSettingsView();
            return;
          } catch (error) {
            settingsFeedback(llmMsg, error.message, true);
          }
          button.disabled = false;
        },
      }, "获取模型列表"),
      el("button", {
        class: "btn small primary",
        onclick: async () => {
          try {
            const result = await api("/api/settings/llm", {
              method: "POST",
              body: JSON.stringify({ baseUrl: urlInput.value, model: modelInput.value }),
            });
            settingsState.llmDraft = null;
            settingsState.llmNotice = null;
            settingsFeedback(llmMsg, `已保存：${result.model.length > 0 ? result.model : "（未选模型）"}`, false);
            settingsState.status = await api("/api/settings");
          } catch (error) {
            settingsFeedback(llmMsg, error.message, true);
          }
        },
      }, "保存 LLM 配置"),
      llmMsg),
    settingsState.models.length > 0 ? modelChips : null);

  /* --- scheduled digest --- */
  const scheduleCard = renderScheduleCard();

  /* --- disk cleanup --- */
  const cleanupCard = renderCleanupCard();

  /* --- check & update --- */
  const updateCard = renderUpdateCard();

  const aboutCard = el("div", { class: "card" },
    el("h2", {}, "安全说明"),
    el("ul", { style: "margin:0;padding-left:18px;font-size:13px;color:var(--muted);line-height:1.9" },
      el("li", {}, "只读：工具复制数据库文件后离线解析，从不写 QQ 的任何文件，也不使用 QQ 登录协议。"),
      el("li", {}, "本地：控制台只监听 127.0.0.1，带每次启动随机生成的访问令牌。"),
      el("li", {}, "外部流量仅两处：头像走 QQ 公开 CDN；开启 AI 总结时消息文本会发送到你配置的 LLM 服务。")));

  setChildren($("#view-settings"), pathsCard, keysCard, llmCard, scheduleCard, cleanupCard, updateCard, aboutCard);
};

/* --- check & update card --- */

const updateState = { info: null, busy: false, notice: null };

const renderUpdateCard = () => {
  const msg = el("span", { style: "font-size:13px" });
  if (updateState.notice !== null) {
    settingsFeedback(msg, updateState.notice.text, updateState.notice.isError);
  }
  const info = updateState.info;
  const currentVersion = settingsState.status?.version ?? "?";

  const checkButton = el("button", {
    class: "btn small",
    disabled: updateState.busy,
    onclick: async () => {
      updateState.busy = true;
      updateState.notice = { text: "正在检查更新…", isError: false };
      renderSettingsView();
      try {
        updateState.info = await api("/api/update/check");
        updateState.notice = updateState.info.hasUpdate
          ? { text: `发现新版本 v${updateState.info.latestVersion}（当前 v${updateState.info.currentVersion}）。`, isError: false }
          : { text: `已是最新版本（v${updateState.info.currentVersion}）。`, isError: false };
      } catch (error) {
        updateState.notice = { text: `检查失败：${error.message}`, isError: true };
      }
      updateState.busy = false;
      renderSettingsView();
    },
  }, "🔎 检查更新");

  const applyButton = info?.hasUpdate === true
    ? el("button", {
        class: "btn small primary",
        disabled: updateState.busy,
        onclick: async () => {
          if (!window.confirm(`更新到 v${info.latestVersion}？\n控制台会自动退出并重启（约 10-30 秒）。配置、密钥和已生成的数据都会保留。`)) {
            return;
          }
          updateState.busy = true;
          updateState.notice = { text: "正在下载并安装更新…", isError: false };
          renderSettingsView();
          try {
            await api("/api/update/apply", { method: "POST", body: "{}" });
            setChildren($("#view-settings"),
              el("div", { class: "card" },
                el("h2", {}, "正在更新"),
                el("p", { class: "card-sub" },
                  "控制台正在退出并替换程序文件，完成后会自动重新启动并打开新页面。",
                  el("br"),
                  "如果 30 秒后没有自动打开，请手动双击 Start-QQ-Console.cmd。")));
            return;
          } catch (error) {
            updateState.notice = { text: `更新失败：${error.message}`, isError: true };
          }
          updateState.busy = false;
          renderSettingsView();
        },
      }, `⬆️ 一键更新到 v${info.latestVersion}`)
    : null;

  const notesBlock = info?.hasUpdate === true && info.notes
    ? el("pre", { style: "margin:10px 0 0;padding:10px;border:1px solid var(--line);border-radius:8px;font-size:12px;white-space:pre-wrap;max-height:180px;overflow:auto;color:var(--muted)" }, info.notes)
    : null;

  return el("div", { class: "card" },
    el("h2", {}, "关于与更新"),
    el("p", { class: "card-sub" },
      `当前版本 v${currentVersion} · 项目主页 `,
      el("a", { href: "https://github.com/peter119lee/chatlens", target: "_blank", rel: "noopener" }, "GitHub"),
      "。检查更新会访问 GitHub 获取最新发布版本；一键更新会下载对应安装包并自动重启控制台，你的配置、密钥和数据不受影响。"),
    el("div", { class: "row" }, checkButton, applyButton, msg),
    notesBlock);
};

// Move the old 清理生成数据.cmd here so freeing disk space stays a one-click
// action inside the console instead of a separate launcher.
const renderCleanupCard = () => {
  const msg = el("span", { style: "font-size:13px" });
  const daysInput = el("input", { type: "number", value: "7", min: "1", max: "365", style: "width:70px" });
  const retentionMsg = el("span", { style: "font-size:13px" });
  const retentionInput = el("input", {
    type: "number",
    value: String(settingsState.status?.store?.retentionDays ?? 30),
    min: "1",
    max: "365",
    style: "width:70px",
  });

  const runCleanup = async (button, payload, describe) => {
    button.disabled = true;
    settingsFeedback(msg, "正在清理…", false);
    try {
      const result = await api("/api/cleanup", { method: "POST", body: JSON.stringify(payload) });
      settingsFeedback(msg, `${describe}：释放 ${formatBytes(result.freedBytes)}（临时库 ${result.removedCleanDbCount} 个，删除运行 ${result.removedRunCount} 个）。`, false);
    } catch (error) {
      settingsFeedback(msg, error.message, true);
    }
    button.disabled = false;
  };

  return el("div", { class: "card" },
    el("h2", {}, "磁盘清理与消息保留"),
    el("p", { class: "card-sub" },
      "生成的扫描数据都在本机 runs\\ 目录。「临时数据库副本」是每次扫描解密出的 clean-db，删掉不影响报告；" +
      "「旧运行」会连同该次的媒体副本一起删除 —— 历史报告的图片预览、聊天里的内嵌图片和媒体页都将无法再显示这些文件。"),
    el("div", { class: "row" },
      el("button", {
        class: "btn small primary",
        onclick: (event) => runCleanup(event.target, {}, "已清理临时数据库副本"),
      }, "清理临时数据库副本"),
      el("span", { style: "width:16px" }),
      el("span", { style: "font-size:13px" }, "删除"),
      daysInput,
      el("span", { style: "font-size:13px" }, "天前的旧运行"),
      el("button", {
        class: "btn small",
        onclick: (event) => {
          const days = Number.parseInt(daysInput.value, 10);
          if (!Number.isInteger(days) || days < 1) {
            settingsFeedback(msg, "请输入有效的天数。", true);
            return;
          }
          if (!window.confirm(`确定删除 ${days} 天前的旧运行？\n历史报告预览、聊天内嵌图片和媒体页将无法再显示这些文件。`)) {
            return;
          }
          runCleanup(event.target, { olderThanDays: days }, `已删除 ${days} 天前的旧运行`);
        },
      }, "执行"),
      msg),
    el("div", { class: "row", style: "margin-top:10px" },
      el("span", { style: "font-size:13px" }, "「消息」页保留最近"),
      retentionInput,
      el("span", { style: "font-size:13px" }, "天的本地消息"),
      el("button", {
        class: "btn small",
        onclick: async (event) => {
          const button = event.target;
          button.disabled = true;
          try {
            const result = await api("/api/settings/store", {
              method: "POST",
              body: JSON.stringify({ retentionDays: retentionInput.value }),
            });
            settingsFeedback(retentionMsg, `已保存：保留 ${result.retentionDays} 天（下次扫描后生效）。`, false);
            settingsState.status = await api("/api/settings");
          } catch (error) {
            settingsFeedback(retentionMsg, error.message, true);
          }
          button.disabled = false;
        },
      }, "保存"),
      retentionMsg));
};

const renderScheduleCard = () => {
  const schedule = settingsState.schedule;
  const msg = el("span", { style: "font-size:13px" });
  const timeInput = el("input", { type: "time", value: schedule?.time || "09:00", style: "width:120px" });

  const refresh = async () => {
    try {
      settingsState.schedule = await api("/api/schedule");
    } catch {
      settingsState.schedule = { enabled: false };
    }
    renderSettingsView();
  };

  const statusLine = schedule === null
    ? el("span", { class: "card-sub" }, "正在读取…")
    : schedule.enabled
      ? el("span", {}, savedTag(true), el("span", { style: "margin-left:8px;font-size:13px" },
          `每天 ${schedule.time} 自动总结关注群${schedule.lastRun ? `（上次运行 ${schedule.lastRun}）` : ""}`))
      : savedTag(false);

  return el("div", { class: "card" },
    el("h2", {}, "定时总结"),
    el("p", { class: "card-sub" },
      "用 Windows 计划任务每天定点自动总结「关注群」。它独立运行，不需要控制台开着；" +
      "如果到点时电脑关机或睡眠，开机后会自动补跑这次（不会静默跳过）。" +
      "每次都从上次记录点继续扫描，停机多久都不会漏消息。"),
    el("div", { class: "row", style: "margin-bottom:10px" }, statusLine),
    el("div", { class: "row" },
      el("span", { style: "font-size:13px" }, "每天"),
      timeInput,
      el("button", {
        class: "btn small primary",
        onclick: async (event) => {
          event.target.disabled = true;
          try {
            await api("/api/schedule", { method: "POST", body: JSON.stringify({ enabled: true, time: timeInput.value, sinceHours: 26 }) });
            settingsFeedback(msg, "已设置。", false);
            await refresh();
            return;
          } catch (error) {
            settingsFeedback(msg, error.message, true);
          }
          event.target.disabled = false;
        },
      }, schedule?.enabled ? "更新时间" : "开启定时"),
      schedule?.enabled
        ? el("button", {
            class: "btn small",
            onclick: async () => {
              try {
                await api("/api/schedule/run-now", { method: "POST" });
                settingsFeedback(msg, "已触发一次运行（后台执行）。", false);
              } catch (error) {
                settingsFeedback(msg, error.message, true);
              }
            },
          }, "立即运行一次")
        : null,
      schedule?.enabled
        ? el("button", {
            class: "btn small danger",
            onclick: async () => {
              try {
                await api("/api/schedule", { method: "POST", body: JSON.stringify({ enabled: false }) });
                settingsFeedback(msg, "已关闭定时。", false);
                await refresh();
              } catch (error) {
                settingsFeedback(msg, error.message, true);
              }
            },
          }, "关闭")
        : null,
      msg));
};
