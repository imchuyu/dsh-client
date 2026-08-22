// error-render.js — wired by error.html <script>. Renders the failure reason
// and stderr tail that the main process pushed over the preload bridge.
(function () {
  const reasonEl = document.getElementById('reason');
  const stderrEl = document.getElementById('stderr');
  const retryBtn = document.getElementById('retry');
  const quitBtn = document.getElementById('quit');

  window.dshClient.onErrorInfo((data) => {
    reasonEl.textContent = data && data.reason
      ? data.reason
      : '未知错误（未收到失败原因）';
    if (data && data.stderr && String(data.stderr).trim()) {
      stderrEl.classList.remove('empty');
      stderrEl.textContent = data.stderr;
    } else {
      stderrEl.classList.add('empty');
    }
  });

  retryBtn.addEventListener('click', () => window.dshClient.retry());
  quitBtn.addEventListener('click', () => window.dshClient.quit());
})();
