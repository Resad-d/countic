function toast(message, kind) {
  let container = document.querySelector('.dash-toasts');
  if (!container) {
    container = document.createElement('div');
    container.className = 'dash-toasts';
    document.body.append(container);
  }
  const el = document.createElement('div');
  el.className = `toast dash-toast-${kind === 'ok' ? 'ok' : 'error'}`;
  el.setAttribute('role', 'status');
  el.setAttribute('aria-live', 'polite');
  el.setAttribute('aria-atomic', 'true');
  el.innerHTML = '<div class="d-flex"><div class="toast-body"></div>' +
    '<button type="button" class="btn-close btn-close-white me-2 m-auto" data-bs-dismiss="toast" aria-label="Close"></button></div>';
  el.querySelector('.toast-body').textContent = message;
  container.append(el);
  el.addEventListener('hidden.bs.toast', () => el.remove());
  bootstrap.Toast.getOrCreateInstance(el, { delay: 4500 }).show();
}

async function postJson(form) {
  const res = await fetch(form.getAttribute('action'), {
    method: 'POST',
    body: new URLSearchParams(new FormData(form)),
    headers: { accept: 'application/json' },
  });
  const data = await res.json().catch(() => null);
  return { ok: res.ok && data?.ok === true, data };
}

for (const el of document.querySelectorAll('.toast')) {
  bootstrap.Toast.getOrCreateInstance(el, { delay: 4500 }).show();
}

for (const input of document.querySelectorAll('input[required]')) {
  input.addEventListener('invalid', (event) => {
    event.preventDefault();
    toast('Type a channel name first.', 'error');
  });
}

// Counter saves stay on the page, the JSON reply updates the row in place.
for (const form of document.querySelectorAll('form.dash-counter')) {
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (form.dataset.busy === '1') {
      return;
    }
    form.dataset.busy = '1';
    try {
      const { ok, data } = await postJson(form);
      if (ok) {
        if (typeof data?.value === 'string') {
          form.querySelector('.dash-counter-current').textContent = data.value;
        }
        form.classList.toggle('dash-counter-off', new FormData(form).get('enabled') === 'false');
        form.classList.add('dash-counter-flash');
        setTimeout(() => form.classList.remove('dash-counter-flash'), 2000);
      }
      toast(data?.message ?? 'Something went wrong, try again.', ok ? 'ok' : 'error');
    } catch {
      toast('Something went wrong, try again.', 'error');
    } finally {
      delete form.dataset.busy;
    }
  });
}

const modal = document.getElementById('delete-counter');
if (modal) {
  const dialog = bootstrap.Modal.getOrCreateInstance(modal);
  for (const btn of document.querySelectorAll('[data-counter-delete]')) {
    btn.addEventListener('click', () => {
      document.getElementById('delete-counter-label').textContent = btn.dataset.counterLabel ?? '';
      document.getElementById('delete-counter-id').value = btn.dataset.counterId ?? '';
      dialog.show();
    });
  }

  const deleteForm = document.getElementById('delete-counter-form');
  deleteForm?.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (deleteForm.dataset.busy === '1') {
      return;
    }
    deleteForm.dataset.busy = '1';
    try {
      const { ok, data } = await postJson(deleteForm);
      dialog.hide();
      if (ok) {
        const id = deleteForm.querySelector('[name="counterId"]')?.value;
        document.getElementById(`counter-${id}`)?.remove();
      }
      toast(data?.message ?? 'Something went wrong, try again.', ok ? 'ok' : 'error');
    } catch {
      dialog.hide();
      toast('Something went wrong, try again.', 'error');
    } finally {
      delete deleteForm.dataset.busy;
    }
  });
}
