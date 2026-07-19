const statusEl = document.getElementById('status');

window.splashApi.onStatus((message) => {
  statusEl.textContent = message;
});
