export const setupScript = String.raw`
'use strict';
(() => {
  const $ = id => document.getElementById(id);
  let step = 0, token = '', template, savedSettings, blocked = false;
  $('server-address').textContent = location.origin;
  const labels = ['Connect to server', 'Continue', 'Review configuration', 'Save configuration'];
  function show(next) {
    step = next;
    document.querySelectorAll('[data-panel]').forEach(panel => panel.hidden = Number(panel.dataset.panel) !== step);
    document.querySelectorAll('[data-step]').forEach(item => {
      item.removeAttribute('aria-current');
      if (Number(item.dataset.step) === step) item.setAttribute('aria-current', 'step');
      item.classList.toggle('complete', Number(item.dataset.step) < step);
    });
    $('step-label').textContent = step < 4 ? 'STEP 0' + (step + 1) + ' / 04' : 'CONNECTED TO YOUR WORKFLOW';
    $('actions').hidden = step === 4;
    $('back').hidden = step === 0;
    $('next').replaceChildren(document.createTextNode(labels[step] || ''), Object.assign(document.createElement('span'), {textContent: '↗'}));
    $('message').hidden = true;
    const heading = document.querySelector('[data-panel="' + step + '"] h2');
    heading.tabIndex = -1; heading.focus({preventScroll: true});
  }
  function error(message) { $('message').textContent = message; $('message').hidden = false; }
  async function request(path, method = 'GET', body) {
    const response = await fetch(path, {method, cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(15000),
      headers: {Authorization: 'Bearer ' + token, 'Content-Type': 'application/json'},
      ...(body === undefined ? {} : {body: JSON.stringify(body)})});
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 401) throw new Error('The admin token was rejected. Go back to Connect and sign in again.');
      if (response.status === 409) {
        blocked = true;
        throw new Error('Another session configured this server. Reload to view the saved configuration. Your draft has not been saved.');
      }
      if (response.status === 422) throw new Error('Settings were rejected. Check the URL, models, credential references, and any edited JSON. Nothing was saved.');
      if (response.status === 413) throw new Error('Settings are too large. Reduce the JSON size and try again.');
      throw new Error('Server request failed (HTTP ' + response.status + '). Try again.');
    }
    return response.json();
  }
  const formatDescriptions = {
    json: 'Sends the note ID, title, and transcript as JSON.',
    text: 'Sends the transcript as a plain text body.',
    form: 'Sends the note ID, title, and transcript as URL-encoded fields.',
    multipart: 'Sends the note ID, transcript, and the original audio file as multipart fields.',
    audio: 'Sends the original recording as a raw audio body.',
  };
  function formatHelp() {
    const get = $('method').value === 'GET'; $('format').disabled = get;
    $('format-help').textContent = get ? 'GET sends a fixed trigger with no body.' : formatDescriptions[$('format').value];
  }
  $('method').addEventListener('change', formatHelp); $('format').addEventListener('change', formatHelp);
  function draft() {
    const settings = structuredClone(template.settings), pipe = settings.pipes.inbox;
    pipe.url = $('destination-url').value.trim(); pipe.method = $('method').value;
    pipe.authHeaders = $('credential').value.trim() ? {Authorization: $('credential').value.trim()} : {};
    pipe.body = pipe.method === 'GET' ? {format: 'json', mapping: {}} : {format: $('format').value, mapping: structuredClone(template.bodyFormats[$('format').value])};
    settings.transcriptionModel = $('transcription-model').value.trim(); settings.responsesModel = $('responses-model').value.trim();
    settings.instructions = $('instructions').value;
    return settings;
  }
  function summary(settings) {
    const pipe = settings.pipes?.[settings.defaultPipeId];
    $('review-url').textContent = pipe?.url || 'Check settings JSON';
    $('review-request').textContent = pipe ? pipe.method + ' · ' + (pipe.method === 'GET' ? 'No body' : pipe.body?.format) : 'Check settings JSON';
    $('review-models').textContent = [settings.transcriptionModel, settings.responsesModel].join(' / ');
  }
  $('settings-json').addEventListener('input', () => { try { summary(JSON.parse($('settings-json').value)); } catch { /* Keep the last valid summary while typing. */ } });
  function complete(revision, existing = false) {
    savedSettings = revision.settings;
    $('done-title').textContent = existing ? 'Your server is already configured.' : 'Your workflow is ready.';
    $('done-description').textContent = (existing ? 'Initial setup is complete.' : 'Your first configuration has been saved.') + ' Active revision: ' + revision.id + '.';
    $('receive-url').value = location.origin + '/receive';
    token = ''; $('admin-token').value = ''; show(4);
  }
  $('back').addEventListener('click', () => show(step - 1));
  $('download').addEventListener('click', () => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(savedSettings, null, 2) + '\n'], {type: 'application/json'}));
    const link = document.createElement('a'); link.href = url; link.download = 'whim-config.json'; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  $('wizard').addEventListener('submit', async event => {
    event.preventDefault(); if (blocked) return;
    $('message').hidden = true;
    const required = [['admin-token'], ['destination-url'], ['transcription-model', 'responses-model'], []][step];
    if (!required || required.some(id => !$(id).reportValidity())) return;
    if (step === 1) {
      const destination = new URL($('destination-url').value);
      if (!['http:', 'https:'].includes(destination.protocol) || destination.username || destination.password) {
        error('Use an HTTP or HTTPS destination without embedded credentials.'); return;
      }
    }
    $('next').disabled = true; $('back').disabled = true;
    try {
      if (step === 0) {
        token = $('admin-token').value.trim();
        const current = await request('/admin/config');
        if (current.id !== 0) { complete(current, true); return; }
        template = await request('/admin/config/template');
        $('admin-token').value = '';
        if (!$('transcription-model').value) $('transcription-model').value = template.settings.transcriptionModel;
        if (!$('responses-model').value) $('responses-model').value = template.settings.responsesModel;
        if (!$('instructions').value) $('instructions').value = template.settings.instructions;
        show(1);
      } else if (step === 1) show(2);
      else if (step === 2) { const settings = draft(); summary(settings); $('settings-json').value = JSON.stringify(settings, null, 2); show(3); }
      else if (step === 3) {
        let settings;
        try { settings = JSON.parse($('settings-json').value); } catch { throw new Error('Settings JSON is invalid. Open the JSON editor and check its syntax.'); }
        complete(await request('/admin/config', 'PUT', {settings, expectedRevisionId: 0}));
      }
    } catch (e) {
      error(e instanceof TypeError || e.name === 'TimeoutError' ? 'Could not reach the server. Check your connection and try again.' : e.message);
    } finally { $('next').disabled = blocked; $('back').disabled = false; }
  });
})();
`;
