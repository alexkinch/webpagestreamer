// Background service worker for tab capture
// Listens for requests from the content script to get a tabCapture stream ID

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.command === "get-stream-id") {
    const tabId = sender.tab.id;
    chrome.tabCapture.getMediaStreamId(
      { consumerTabId: tabId },
      (streamId) => {
        if (chrome.runtime.lastError) {
          console.error("tabCapture error:", chrome.runtime.lastError.message);
          sendResponse({ error: chrome.runtime.lastError.message });
        } else {
          console.log("Got stream ID for tab", tabId);
          sendResponse({ streamId: streamId });
        }
      }
    );
    return true; // keep message channel open for async sendResponse
  }
});
