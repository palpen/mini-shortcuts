const dialog = document.querySelector('#remove-dialog');
const checkbox = document.querySelector('#shutdown-checkbox');
const confirm = document.querySelector('#confirm-remove');
const cancel = document.querySelector('#cancel-remove');
const notice = document.querySelector('#notice');
let selection;
let saving = false;

try {
  notice.textContent = sessionStorage.getItem('mini-notice') || '';
  sessionStorage.removeItem('mini-notice');
  for (const id of JSON.parse(sessionStorage.getItem('mini-open') || '[]')) {
    if (['minimized', 'removed'].includes(id)) document.getElementById(id)?.setAttribute('open', '');
  }
} catch { /* The controls also work with browser storage disabled. */ }

async function change(slug, action) {
  if (saving) return;
  saving = true;
  for (const button of document.querySelectorAll('button')) button.disabled = true;
  checkbox.disabled = true;
  notice.textContent = action === 'shutdown' ? 'Removing and shutting down…' : 'Saving…';
  confirm.textContent = action === 'shutdown' ? 'Shutting down…' : 'Saving…';
  let message;
  try {
    const response = await fetch(`/api/apps/${encodeURIComponent(slug)}/${action}`, {
      method: 'POST', headers: { 'X-Mini-Request': '1' }, credentials: 'same-origin',
    });
    message = response.ok ? {
      minimize: 'App minimized. It is still available at its usual address.',
      restore: 'App restored to the top of your directory.',
      remove: 'App removed from the directory. Its server was left running.',
      shutdown: 'App removed and shut down. Its files have been kept.',
    }[action] : await response.text();
  } catch {
    message = 'The connection was interrupted. Check the directory before retrying.';
  }
  try {
    sessionStorage.setItem('mini-notice', message);
    const open = [...document.querySelectorAll('details[open]')].map(element => element.id);
    if (action === 'shutdown' || action === 'remove') open.push('removed');
    sessionStorage.setItem('mini-open', JSON.stringify(open));
  } catch {
    dialog.close();
    notice.textContent = message;
    const reload = document.createElement('a');
    reload.href = '/';
    reload.textContent = ' Refresh directory';
    notice.append(reload);
    return;
  }
  window.location.reload();
}

document.addEventListener('click', event => {
  const button = event.target.closest('button[data-action]');
  if (!button || saving) return;
  const { slug, action, name, shutdown } = button.dataset;
  if (action === 'minimize' || action === 'restore') {
    void change(slug, action);
    return;
  }
  selection = { slug, stopOnly: action === 'confirm-stop' };
  document.querySelector('#dialog-title').textContent = `${selection.stopOnly ? 'Shut down' : 'Remove'} ${name}?`;
  document.querySelector('#dialog-description').textContent = selection.stopOnly
    ? 'This app is already removed from your directory. Shut it down on the server too?'
    : 'This removes the shortcut from your directory on all devices. You can also shut down the app below.';
  document.querySelector('#shutdown-option').hidden = !shutdown || selection.stopOnly;
  checkbox.checked = selection.stopOnly;
  checkbox.disabled = !shutdown;
  document.querySelector('#shutdown-help').textContent = shutdown === 'tailnow'
    ? 'Shutting down unpublishes this site and archives its files. Other Tailnow sites keep running.'
    : shutdown === 'launchAgent'
      ? 'Shutting down stops this service and disables automatic restarts. Its files are kept. Starting it again requires access to the server.'
      : 'Shutdown is not configured for this app. Removing its shortcut leaves the app running.';
  confirm.textContent = selection.stopOnly ? 'Shut down' : 'Remove';
  dialog.showModal();
  cancel.focus();
});

checkbox.addEventListener('change', () => {
  confirm.textContent = checkbox.checked ? 'Remove & shut down' : 'Remove';
});
cancel.addEventListener('click', () => dialog.close());
dialog.addEventListener('cancel', event => { if (saving) event.preventDefault(); });
dialog.querySelector('form').addEventListener('submit', event => {
  event.preventDefault();
  if (selection) void change(selection.slug, selection.stopOnly || checkbox.checked ? 'shutdown' : 'remove');
});
