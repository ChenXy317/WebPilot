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

// 侧边栏端口长连接监听
chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'webauto-sidepanel') {
    connectedPorts.add(port);

    // 握手时同步当前运行状态与历史流
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

            if (activeRunner) {
              await activeRunner.stop();
            }

            activeRunner = new AgentRunner({
              apiConfig: msg.config.apiConfig,
              maxSteps: msg.config.maxSteps,
              enableVision: msg.config.enableVision,
              enableCdp: msg.config.enableCdp,
              onEvent: (ev) => broadcast(ev)
            });

            // 异步启动，脱离侧边栏生命周期常驻运行
            activeRunner.start(msg.goal).catch((e) => {
              broadcast({ type: 'error', message: e.message });
            });
            break;

          case 'PAUSE_TASK':
            if (activeRunner) activeRunner.pause();
            break;

          case 'RESUME_TASK':
            if (activeRunner) activeRunner.resume();
            break;

          case 'STOP_TASK':
            if (activeRunner) await activeRunner.stop();
            break;

          case 'CLEAR_HISTORY':
            eventLogHistory.length = 0;
            broadcast({ type: 'HISTORY_CLEARED' });
            break;
        }
      } catch (err) {
        broadcast({ type: 'error', message: err.message });
      }
    });
  }
});
