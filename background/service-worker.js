/**
 * 后台服务工作线程
 * 负责扩展的生命周期管理、侧边栏唤起以及跨模块事件协调
 */

// 点击扩展图标时直接打开侧边栏
chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch((error) => {
    console.error('配置侧边栏行为异常:', error);
  });
});

// 监听扩展激活消息
chrome.action.onClicked.addListener(async (tab) => {
  if (tab.id) {
    await chrome.sidePanel.open({ tabId: tab.id });
  }
});
