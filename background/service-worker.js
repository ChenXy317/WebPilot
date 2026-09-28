/**
 * 后台服务工作线程
 * 负责扩展的生命周期管理、侧边栏唤起以及跨模块事件协调
 */

// 配置点击图标自动打开侧边栏
function initSidePanelBehavior() {
  if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch((error) => {
      console.error('配置侧边栏行为异常:', error);
    });
  }
}

chrome.runtime.onInstalled.addListener(initSidePanelBehavior);
chrome.runtime.onStartup.addListener(initSidePanelBehavior);

// 扩展图标激活后备处理
chrome.action.onClicked.addListener(async (tab) => {
  if (tab.id && chrome.sidePanel && chrome.sidePanel.open) {
    try {
      await chrome.sidePanel.open({ tabId: tab.id });
    } catch (_) {}
  }
});
