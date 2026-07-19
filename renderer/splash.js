const statusEl = document.getElementById('status');
const downloadBtn = document.getElementById('download-btn');

window.splashApi.onStatus(({ message, showDownloadLink }) => {
  statusEl.textContent = message;
  downloadBtn.classList.toggle('hidden', !showDownloadLink);
});

downloadBtn.addEventListener('click', () => {
  window.splashApi.openDockerDownload();
});
