// Runs before first paint so a saved light theme never flashes dark.
(function () {
  try {
    var theme = localStorage.getItem('stc-theme');
    if (theme !== 'light' && theme !== 'dark') return;
    document.documentElement.setAttribute('data-theme', theme);
    if (theme === 'light') document.getElementById('theme-color-meta').setAttribute('content', '#F2F2F7');
  } catch (e) {}
}());
