// ============================================================================
// ReviewHub front end.
//
// CONCEPT: Hoisting
// `boot()` is called on the line below, ~380 lines above where it is declared.
// That is legal because a function declaration is hoisted *with its body*: the
// binding is created and initialised when the module's scope is set up, before
// any statement runs. The `state` object above it is a `const`, which is
// hoisted too but stays in the temporal dead zone until its own line executes —
// so a `const` must appear before the code that touches it, while a function
// declaration need not. Reading this file top-down therefore gives you the
// entry point first and the details afterwards, which is the whole reason to
// rely on hoisting rather than to trip over it.
// ============================================================================
import { requestJSON, getJSON } from './lib/http.js';
import { scheduleRender, debounce, poll } from './lib/scheduler.js';

const state = {
  users: [],
  tags: [],
  titles: [],
  activity: [],
  kind: '',
  search: '',
  activeTag: null,
  detail: null,
  aiEnabled: false,
  draft: { rating: 8, tags: new Set() },
};

boot();

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------
async function boot() {
  wireEvents();

  try {
    // Two independent requests, started together. With callbacks this would be
    // a nested pair or a hand-rolled counter; as promises it is one line.
    const [bootstrap, titles] = await Promise.all([
      requestJSON('/api/bootstrap'),
      requestJSON('/api/titles'),
    ]);

    state.users = bootstrap.users;
    state.tags = bootstrap.tags;
    state.activity = bootstrap.activity;
    state.aiEnabled = bootstrap.aiEnabled;
    state.titles = titles;

    // Four render calls in one task. scheduleRender coalesces them into a
    // single frame instead of four separate DOM writes.
    scheduleRender('titles', renderTitles);
    scheduleRender('activity', renderActivity);
    scheduleRender('tags', renderTagCloud);
    scheduleRender('status', renderStatus);
  } catch (err) {
    $('#title-grid').innerHTML = `<div class="empty-state">
      Could not reach the API.<br /><small>${esc(err.message)}</small>
    </div>`;
  }
}

function wireEvents() {
  $('#tabs').addEventListener('click', (event) => {
    const tab = event.target.closest('.tab');
    if (tab) switchView(tab.dataset.view);
  });

  $('#kind-filter').addEventListener('click', (event) => {
    const pill = event.target.closest('.pill');
    if (!pill) return;
    state.kind = pill.dataset.kind;
    for (const el of $$('#kind-filter .pill')) el.classList.toggle('is-active', el === pill);
    loadTitles();
  });

  // Each keystroke is its own task. Without the debounce this fires a request
  // per character; with it, only the pause at the end reaches the server.
  $('#search').addEventListener('input', debounce((event) => {
    state.search = event.target.value.trim();
    loadTitles();
  }, 250));

  $('#title-grid').addEventListener('click', (event) => {
    const card = event.target.closest('.card');
    if (card) openTitle(Number(card.dataset.id));
  });

  $('#tag-cloud').addEventListener('click', (event) => {
    const tag = event.target.closest('.tag');
    if (tag) selectTag(tag.dataset.slug);
  });

  // Delegated once on the container, which never leaves the DOM. Binding this
  // inside renderDetail() instead would add a fresh listener on every render.
  $('#detail').addEventListener('click', onRerunClick);

  $('#close-detail').addEventListener('click', closeDetail);
  $('#overlay').addEventListener('click', (event) => {
    if (event.target === $('#overlay')) closeDetail();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !$('#overlay').hidden) closeDetail();
  });
}

function switchView(view) {
  for (const el of $$('.tab')) el.classList.toggle('is-active', el.dataset.view === view);
  for (const el of $$('.view')) el.classList.toggle('is-active', el.id === `view-${view}`);

  if (view === 'critics') loadCritics();
  if (view === 'disagreements') loadDisagreements();
}

// ---------------------------------------------------------------------------
// Catalogue
// ---------------------------------------------------------------------------
async function loadTitles() {
  const params = new URLSearchParams();
  if (state.kind) params.set('kind', state.kind);
  if (state.search) params.set('q', state.search);

  state.titles = await requestJSON(`/api/titles?${params}`);
  scheduleRender('titles', renderTitles);
}

function renderTitles() {
  const grid = $('#title-grid');

  if (state.titles.length === 0) {
    grid.innerHTML = `<div class="empty-state">Nothing matches that search.</div>`;
    return;
  }

  grid.innerHTML = state.titles.map((t) => `
    <button class="card" data-id="${t.id}">
      <span class="kind-chip">${t.kind === 'movie' ? 'Film' : 'Book'}</span>
      <div class="card-emoji">${t.cover_emoji}</div>
      <h3>${esc(t.name)}</h3>
      <div class="meta">${esc(t.creator)}${t.release_year ? ` · ${t.release_year}` : ''}</div>
      <div class="foot">
        ${Number(t.review_count) > 0
          ? `<span class="score">${t.avg_rating}</span><span class="count">from ${t.review_count} review${t.review_count === '1' ? '' : 's'}</span>`
          : `<span class="score empty">No reviews yet</span>`}
      </div>
    </button>
  `).join('');
}

function renderActivity() {
  $('#activity').innerHTML = state.activity.map((a) => `
    <li>
      <span>${a.cover_emoji}</span>
      <span><span class="who">${esc(a.display_name)}</span>
      <span class="what">rated</span> ${esc(a.title_name)}
      <span class="what">${a.rating}/10</span></span>
    </li>
  `).join('');
}

function renderTagCloud() {
  $('#tag-cloud').innerHTML = state.tags.map((t) => `
    <button class="tag ${state.activeTag === t.slug ? 'is-active' : ''}" data-slug="${t.slug}">
      ${esc(t.label)}<span class="n">${t.use_count}</span>
    </button>
  `).join('');
}

function renderStatus() {
  $('#ai-status').innerHTML = state.aiEnabled
    ? `<span class="dot"></span> Gemini extraction on`
    : `<span class="dot offline"></span> Offline extractor`;
}

async function selectTag(slug) {
  if (state.activeTag === slug) {
    state.activeTag = null;
    $('#tag-results').innerHTML = '';
    scheduleRender('tags', renderTagCloud);
    return;
  }

  state.activeTag = slug;
  scheduleRender('tags', renderTagCloud);

  const hits = await requestJSON(`/api/tags/${slug}/reviews`);
  $('#tag-results').innerHTML = hits.length === 0
    ? `<div class="hit">Nobody has used this tag yet.</div>`
    : hits.map((h) => `
        <div class="hit">${h.cover_emoji} <b>${esc(h.title_name)}</b> · ${esc(h.display_name)} gave it ${h.rating}/10</div>
      `).join('');
}

// ---------------------------------------------------------------------------
// Critics / disagreements
// ---------------------------------------------------------------------------
async function loadCritics() {
  const critics = await requestJSON('/api/critics');

  $('#critics').innerHTML = `
    <table>
      <thead><tr><th>Critic</th><th>Reviews</th><th>Average</th><th>Rated highest</th></tr></thead>
      <tbody>
        ${critics.map((c) => `
          <tr>
            <td><strong>${esc(c.display_name)}</strong> <span class="count">@${esc(c.username)}</span></td>
            <td class="num">${c.review_count}</td>
            <td class="num">${c.avg_rating}</td>
            <td>${c.favourite_emoji ?? ''} ${esc(c.favourite_title ?? '—')}</td>
          </tr>`).join('')}
      </tbody>
    </table>`;
}

async function loadDisagreements() {
  const rows = await requestJSON('/api/disagreements');

  $('#disagreements').innerHTML = rows.length === 0
    ? `<div class="empty-state">Everyone agrees, for now.</div>`
    : `<table>
        <thead><tr><th>Title</th><th>Gap</th><th></th><th></th></tr></thead>
        <tbody>
          ${rows.map((r) => `
            <tr>
              <td>${r.cover_emoji} <strong>${esc(r.title_name)}</strong></td>
              <td class="num"><span class="gap-bar" style="width:${r.gap * 9}px"></span>${r.gap}</td>
              <td>${esc(r.critic_a)} · <strong>${r.rating_a}</strong></td>
              <td>${esc(r.critic_b)} · <strong>${r.rating_b}</strong></td>
            </tr>`).join('')}
        </tbody>
      </table>`;
}

// ---------------------------------------------------------------------------
// Title detail + review form
// ---------------------------------------------------------------------------
async function openTitle(titleId) {
  $('#overlay').hidden = false;
  $('#detail').innerHTML = `<div class="empty-state">Loading…</div>`;

  state.detail = await requestJSON(`/api/titles/${titleId}`);
  state.draft = { rating: 8, tags: new Set() };

  scheduleRender('detail', renderDetail);
}

function closeDetail() {
  $('#overlay').hidden = true;
  state.detail = null;
}

async function refreshDetail() {
  if (!state.detail) return;
  state.detail = await requestJSON(`/api/titles/${state.detail.title.id}`);
  scheduleRender('detail', renderDetail);
}

function renderDetail() {
  const { title, reviews } = state.detail;

  $('#detail').innerHTML = `
    <div class="detail-head">
      <div class="emoji">${title.cover_emoji}</div>
      <div>
        <h2 id="detail-title">${esc(title.name)}</h2>
        <div class="meta">${title.kind === 'movie' ? 'Film' : 'Book'} · ${esc(title.creator)}${title.release_year ? ` · ${title.release_year}` : ''}</div>
        ${title.blurb ? `<p class="blurb">${esc(title.blurb)}</p>` : ''}
      </div>
      <div class="agg">
        <div class="score">${Number(title.review_count) > 0 ? title.avg_rating : '—'}</div>
        <div class="count">${title.review_count} review${title.review_count === '1' ? '' : 's'}</div>
      </div>
    </div>

    ${reviews.map(renderReview).join('')}
    ${renderForm()}
  `;

  wireForm();
}

function renderReview(r) {
  return `
    <article class="review" data-review="${r.id}">
      <div class="review-head">
        <span class="name">${esc(r.display_name)}</span>
        <span class="count">@${esc(r.username)}</span>
        <span class="rating">${r.rating}/10</span>
      </div>
      <p class="review-body">${esc(r.body)}</p>
      ${r.tags.length > 0
        ? `<div class="review-tags">${r.tags.map((t) => `<span>${esc(t)}</span>`).join('')}</div>`
        : ''}
      ${renderExtraction(r)}
    </article>`;
}

// The structured record the model produced, rendered field by field. Because
// the response was schema-constrained, this template can index straight into
// the fields — there is no prose to parse and no "sometimes it's a string,
// sometimes an array" branch.
function renderExtraction(r) {
  if (!r.ai_status || r.ai_status === 'pending' || r.ai_status === 'running') {
    return `<div class="ai pending" data-ai="${r.id}">
      <div class="ai-head"><span class="pulse"></span> Reading this review…</div>
    </div>`;
  }

  if (r.ai_status === 'failed') {
    return `<div class="ai failed" data-ai="${r.id}">
      <div class="ai-head">Extraction failed
        <span class="spacer"></span>
        <button class="rerun" data-rerun="${r.id}">Try again</button>
      </div>
    </div>`;
  }

  return `
    <div class="ai" data-ai="${r.id}">
      <div class="ai-head">Editorial summary
        <span class="spacer"></span>
        <button class="rerun" data-rerun="${r.id}">Re-run</button>
      </div>
      <h4>${esc(r.ai_headline ?? '')}</h4>
      <p>${esc(r.ai_summary ?? '')}</p>
      <div class="ai-facts">
        <div><b>Sentiment</b><span class="sentiment ${r.ai_sentiment}">${esc(r.ai_sentiment ?? '')}</span></div>
        <div><b>Implied score</b>${r.ai_rating_guess ?? '—'}/10 <span class="count">(they gave ${r.rating})</span></div>
        <div><b>Spoilers</b>${esc(r.ai_spoiler_risk ?? 'none')}</div>
      </div>
    </div>`;
}

function renderForm() {
  const options = state.users.map((u) => `<option value="${u.id}">${esc(u.display_name)}</option>`).join('');
  const tagButtons = state.tags.map((t) => `
    <button type="button" data-tag="${t.slug}" class="${state.draft.tags.has(t.slug) ? 'is-on' : ''}">${esc(t.label)}</button>
  `).join('');

  return `
    <form class="form" id="review-form">
      <h3>Add a review</h3>
      <div class="row">
        <div class="field">
          <label for="critic">Posting as</label>
          <select id="critic">${options}</select>
        </div>
        <div class="field">
          <label for="rating">Your score</label>
          <div class="rating-row">
            <input id="rating" type="range" min="1" max="10" value="${state.draft.rating}" />
            <output id="rating-out">${state.draft.rating}</output>
          </div>
        </div>
      </div>
      <div class="field">
        <label for="body">What did you think?</label>
        <textarea id="body" placeholder="At least 15 characters. The model reads this, not your score." maxlength="4000"></textarea>
      </div>
      <div class="field">
        <label>Tags (optional — the model will suggest more)</label>
        <div class="chooser" id="tag-chooser">${tagButtons}</div>
      </div>
      <button type="submit" class="submit" id="submit-review">Post review</button>
      <span class="hint" id="form-hint"></span>
    </form>`;
}

function wireForm() {
  const form = $('#review-form');
  if (!form) return;

  $('#rating').addEventListener('input', (event) => {
    state.draft.rating = Number(event.target.value);
    $('#rating-out').textContent = state.draft.rating;
  });

  $('#tag-chooser').addEventListener('click', (event) => {
    const button = event.target.closest('[data-tag]');
    if (!button) return;
    const slug = button.dataset.tag;

    if (state.draft.tags.has(slug)) state.draft.tags.delete(slug);
    else if (state.draft.tags.size < 3) state.draft.tags.add(slug);

    button.classList.toggle('is-on', state.draft.tags.has(slug));
  });

  form.addEventListener('submit', submitReview);
}

async function submitReview(event) {
  event.preventDefault();

  const button = $('#submit-review');
  const hint = $('#form-hint');
  button.disabled = true;
  hint.textContent = 'Posting…';

  try {
    // The server answers as soon as the rows are committed; the model call is
    // still queued behind this response.
    const created = await requestJSON('/api/reviews', {
      method: 'POST',
      body: {
        userId: Number($('#critic').value),
        titleId: state.detail.title.id,
        rating: state.draft.rating,
        body: $('#body').value,
        tags: [...state.draft.tags],
      },
    });

    hint.textContent = 'Posted. Reading it now…';
    await refreshDetail();

    // Then wait for the background job by polling — one request at a time,
    // rescheduled only after each response (see scheduler.js).
    await watchExtraction(created.id);
    hint.textContent = '';
  } catch (err) {
    toast(err.message, true);
    hint.textContent = '';
  } finally {
    button.disabled = false;
  }
}

async function watchExtraction(reviewId) {
  const finished = await poll(async () => {
    const row = await requestJSON(`/api/reviews/${reviewId}/extraction`);
    return row.status === 'done' || row.status === 'failed' ? row : null;
  });

  await refreshDetail();
  refreshActivity();

  if (finished?.status === 'failed') toast('The model could not read that review.', true);
  else if (finished) toast('Review posted and summarised.');
}

async function onRerunClick(event) {
  const button = event.target.closest('[data-rerun]');
  if (!button) return;

  const reviewId = Number(button.dataset.rerun);
  button.disabled = true;
  button.textContent = 'Running…';

  try {
    // This endpoint uses the queue's *promise* API, so the request stays open
    // until the job resolves and there is nothing to poll for.
    await requestJSON(`/api/reviews/${reviewId}/extraction`, { method: 'POST' });
    await refreshDetail();
  } catch (err) {
    toast(err.message, true);
    button.disabled = false;
    button.textContent = 'Re-run';
  }
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

// The one place the callback-style HTTP helper is used. There is nothing to
// compose here and nobody waiting on the result, which is exactly the case
// where a callback costs nothing — everywhere else in this file is a sequence
// of dependent steps, and those are all promises.
function refreshActivity() {
  getJSON('/api/activity', (err, activity) => {
    if (err) return console.warn('activity refresh failed:', err.message);
    state.activity = activity;
    scheduleRender('activity', renderActivity);
  });
}

let toastTimer = null;
function toast(message, isBad = false) {
  const el = $('#toast');
  el.textContent = message;
  el.className = `toast${isBad ? ' bad' : ''}`;
  el.hidden = false;

  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3200);
}

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[ch]);
}

function $(selector) { return document.querySelector(selector); }
function $$(selector) { return [...document.querySelectorAll(selector)]; }
