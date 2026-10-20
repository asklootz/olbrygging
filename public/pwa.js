const connectionStatus = document.querySelector('#connection-status');
const updateConnectionStatus = () => {
  connectionStatus.hidden = navigator.onLine !== false;
};
updateConnectionStatus();
window.addEventListener('online', updateConnectionStatus);
window.addEventListener('offline', updateConnectionStatus);

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch((error) => {
    console.warn('Kunne ikke aktivere frakoblet appskall.', error);
  });
}
