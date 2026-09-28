/**
 * 扩展后台服务线程
 * 管理自动化引擎单例生命周期、长连接通信及状态同步
 */

import { AgentRunner } from './agent-runner.js';

let activeRunner = null;
let currentGoal = '';
let currentConfig = null;
const eventLogHistory = [];
const connectedPorts = new Set();

// 配置点击扩展图标自动唤起侧边栏
function initSidePanelBehavior() {
  if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  }
}

chrome.runtime.onInstalled.addListener(initSidePanelBehavior);
chrome.runtime.onStartup.addListener(initSidePanelBehavior);

chrome.action.onClicked.addListener(async (tab) => {
  if (tab.id && chrome.sidePanel && chrome.sidePanel.open) {
    try {
      await chrome.sidePanel.open({ tabId: tab.id });
    } catch (_) {}
  }
});

/**
 * 广播事件给所有连接的侧边栏
 */
function broadcast(event) {
  eventLogHistory.push(event);
  if (eventLogHistory.length > 500) {
    eventLogHistory.shift();
  }

  for (const port of connectedPorts) {
    try {
      port.postMessage(event);
    } catch (_) {
      connectedPorts.delete(port);
    }
  }
}

/**
 * 检查并恢复因后台挂起而中断的未完成任务
 */
async function recoverRunningTaskIfNeeded() {
  if (activeRunner && activeRunner.status === 'running') {
    return;
  }
  try {
    const { agentRunnerState, apiConfig, currentGoal: savedGoal } = await chrome.storage.local.get([
      'agentRunnerState',
      'apiConfig',
      'currentGoal'
    ]);

    if (agentRunnerState && agentRunnerState.status === 'running') {
      currentGoal = agentRunnerState.currentGoal || savedGoal || '';
      activeRunner = new AgentRunner({
        apiConfig: apiConfig || {},
        maxSteps: agentRunnerState.maxSteps,
        enableVision: agentRunnerState.enableVision,
        enableCdp: agentRunnerState.enableCdp,
        onEvent: (ev) => {
          broadcast(ev);
          if (['complete', 'error', 'statusChange'].includes(ev.type)) {
            chrome.storage.local.set({ eventLogHistory });
            if (['completed', 'stopped', 'error'].includes(ev.status)) {
              chrome.alarms.clear('webauto-keepalive');
            }
          }
        }
      });

      chrome.alarms.create('webauto-keepalive', { periodInMinutes: 0.5 });
      activeRunner.resumeExecution(agentRunnerState).catch((e) => {
        chrome.alarms.clear('webauto-keepalive');
        broadcast({ type: 'error', message: e.message });
      });
    }
  } catch (_) {}
}

// 侧边栏端口长连接监听
chrome.runtime.onConnect.addListener(async (port) => {
  if (port.name === 'webauto-sidepanel') {
    connectedPorts.add(port);

    // 握手时同步持久化历史流与状态，并尝试恢复可能中断的任务
    if (eventLogHistory.length === 0) {
      try {
        const stored = await chrome.storage.local.get(['eventLogHistory', 'currentGoal']);
        if (stored.eventLogHistory && Array.isArray(stored.eventLogHistory)) {
          eventLogHistory.push(...stored.eventLogHistory);
        }
        if (stored.currentGoal) {
          currentGoal = stored.currentGoal;
        }
      } catch (_) {}
    }

    await recoverRunningTaskIfNeeded();

    port.postMessage({
      type: 'INIT_STATE',
      status: activeRunner ? activeRunner.status : 'idle',
      goal: currentGoal,
      events: eventLogHistory
    });

    port.onDisconnect.addListener(() => {
      connectedPorts.delete(port);
    });

    port.onMessage.addListener(async (msg) => {
      try {
        switch (msg.action) {
          case 'START_TASK':
            eventLogHistory.length = 0;
            currentGoal = msg.goal;
            currentConfig = msg.config;
            await chrome.storage.local.set({ currentGoal, eventLogHistory: [] });

            if (activeRunner) {
              await activeRunner.stop();
            }

            // 注册心跳闹钟防止休眠
            chrome.alarms.create('webauto-keepalive', { periodInMinutes: 0.5 });

            activeRunner = new AgentRunner({
              apiConfig: msg.config.apiConfig,
              maxSteps: msg.config.maxSteps,
              enableVision: msg.config.enableVision,
              enableCdp: msg.config.enableCdp,
              onEvent: (ev) => {
                broadcast(ev);
                if (['complete', 'error', 'statusChange'].includes(ev.type)) {
                  chrome.storage.local.set({ eventLogHistory });
                  if (['completed', 'stopped', 'error'].includes(ev.status)) {
                    chrome.alarms.clear('webauto-keepalive');
                  }
                }
              }
            });

            // 异步启动，脱离侧边栏生命周期常驻运行
            activeRunner.start(msg.goal).catch((e) => {
              chrome.alarms.clear('webauto-keepalive');
              broadcast({ type: 'error', message: e.message });
            });
            break;

          case 'PAUSE_TASK':
            if (activeRunner) await activeRunner.pause();
            break;

          case 'RESUME_TASK':
            if (activeRunner) await activeRunner.resume();
            break;

          case 'STOP_TASK':
            chrome.alarms.clear('webauto-keepalive');
            if (activeRunner) await activeRunner.stop();
            break;

          case 'CLEAR_HISTORY':
            eventLogHistory.length = 0;
            await chrome.storage.local.remove(['eventLogHistory', 'currentGoal']);
            broadcast({ type: 'HISTORY_CLEARED' });
            break;
        }
      } catch (err) {
        chrome.alarms.clear('webauto-keepalive');
        broadcast({ type: 'error', message: err.message });
      }
    });
  }
});

// 定时心跳唤醒保活与自愈检查
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'webauto-keepalive') {
    if (activeRunner && activeRunner.status === 'running') {
      try {
        await chrome.runtime.getPlatformInfo();
      } catch (_) {}
    } else {
      await recoverRunningTaskIfNeeded();
      if (!activeRunner || activeRunner.status !== 'running') {
        chrome.alarms.clear('webauto-keepalive');
      }
    }
  }
});

// 模块初始化时尝试自愈
recoverRunningTaskIfNeeded();
