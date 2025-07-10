// Cordova app for viewing /webhook/logs
// Replace this URL with your server's address
const SERVER_URL = 'http://localhost:3000';

function initSSE() {
  const evtSource = new EventSource(SERVER_URL + '/webhook/logs/stream');
  const logBody = document.getElementById('log-body');

  evtSource.onmessage = function(event) {
    const data = JSON.parse(event.data);
    if (data.logs) {
      data.logs.slice().reverse().forEach(addRow);
    } else if (data.log) {
      addRow(data.log);
    } else if (data.alert) {
      notify(data.alert.message);
    }
  };
}

function addRow(log) {
  const row = document.createElement('tr');
  row.innerHTML = `
    <td>${log.time}</td>
    <td>${log.accessToken || ''}</td>
    <td><pre class="mb-0">${log.raw}</pre></td>
    <td><pre class="mb-0">${JSON.stringify(log.data, null, 2)}</pre></td>`;
  logBody.prepend(row);
  if (logBody.rows.length > 50) {
    logBody.deleteRow(-1);
  }
}

function notify(message) {
  if (cordova && cordova.plugins && cordova.plugins.notification) {
    cordova.plugins.notification.local.schedule({
      title: 'Inventory Alert',
      text: message,
      foreground: true
    });
  }
}

document.addEventListener('deviceready', initSSE, false);
