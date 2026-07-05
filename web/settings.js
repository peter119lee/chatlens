"use strict";

/* ---------- settings view: QQ paths, keys, LLM config ---------- */

const settingsState = { status: null, models: [], schedule: null, llmDraft: null, llmNotice: null };

const openSettingsView = async () => {
  showView("settings");
  settingsState.llmDraft = null;
  settingsState.llmNotice = null;
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
  const pathsCard = el("div", { class: "card" },
    el("h2", {}, "QQ 数据库路径"),
    el("p", { class: "card-sub" }, "QQNT 的本地数据库目录。工具只会复制这里的文件做只读分析，绝不修改原文件。"),
    el("div", { style: "display:grid;gap:8px;margin-bottom:10px" }, dbInput, dataInput),
    el("div", { class: "row" },
      el("button", {
        class: "btn small",
        onclick: async (event) => {
          const button = event.target;
          button.disabled = true;
          try {
            const result = await api("/api/settings/detect-qq", { method: "POST" });
            if (result.candidates.length === 0) {
              settingsFeedback(pathMsg, "没有在默认位置找到，请手动填写（QQ 设置里可查看文件保存路径）。", true);
            } else {
              dbInput.value = result.candidates[0].ntDbDir;
              dataInput.value = result.candidates[0].ntDataDir;
              settingsFeedback(pathMsg, `找到 QQ ${result.candidates[0].qq} 的数据目录，确认后点保存。`, false);
            }
          } catch (error) {
            settingsFeedback(pathMsg, error.message, true);
          }
          button.disabled = false;
        },
      }, "🔍 自动探测"),
      el("button", {
        class: "btn small primary",
        onclick: async () => {
          try {
            const result = await api("/api/settings/qq-paths", {
              method: "POST",
              body: JSON.stringify({ ntDbDir: dbInput.value, ntDataDir: dataInput.value }),
            });
            settingsFeedback(pathMsg, result.ntDbDirExists ? "已保存。" : "已保存，但该 nt_db 目录当前不存在，请检查。", !result.ntDbDirExists);
          } catch (error) {
            settingsFeedback(pathMsg, error.message, true);
          }
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

  const keysCard = el("div", { class: "card" },
    el("h2", {}, "密钥"),
    el("p", { class: "card-sub" }, "两把密钥都用 Windows DPAPI 加密存在本机 %APPDATA%\\QQSummaryTools\\，不进项目目录，不进 Git。"),
    keyRow("NTQQ_DB_KEY（QQ 数据库解密密钥）", "ntqqKey", status.ntqqKeySaved,
      el("p", { class: "card-sub", style: "margin:0 0 8px" },
        "获取方法：QQNT 的数据库密钥需要从本机 QQ 进程提取，参考开源教程 ",
        el("a", { href: "https://github.com/QQBackup/qq-win-db-key", target: "_blank", rel: "noopener" }, "QQBackup/qq-win-db-key"),
        "（跟随其 Wiki 步骤拿到 16 位 key 后粘贴到这里）。")),
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

  const aboutCard = el("div", { class: "card" },
    el("h2", {}, "安全说明"),
    el("ul", { style: "margin:0;padding-left:18px;font-size:13px;color:var(--muted);line-height:1.9" },
      el("li", {}, "只读：工具复制数据库文件后离线解析，从不写 QQ 的任何文件，也不使用 QQ 登录协议。"),
      el("li", {}, "本地：控制台只监听 127.0.0.1，带每次启动随机生成的访问令牌。"),
      el("li", {}, "外部流量仅两处：头像走 QQ 公开 CDN；开启 AI 总结时消息文本会发送到你配置的 LLM 服务。")));

  setChildren($("#view-settings"), pathsCard, keysCard, llmCard, scheduleCard, aboutCard);
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
      "如果到点时电脑关机或睡眠，开机后会自动补跑这次（不会静默跳过）。"),
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
