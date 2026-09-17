'use strict';

const API_URL = 'https://script.google.com/macros/s/AKfycbyfeSB3gvBHTfHuCwozfPG-GUflo6AmJmer8HJSUStmY_IdCutZWJdnHTsVfIfdpHfc/exec';
const DEFAULT_LESSON_ID = 'PLANTS_01';
const CACHE_PREFIX = 'plants_bootstrap_v3_';
const PLAYER_STORAGE_KEY = 'plants_player';
const DEVICE_STORAGE_KEY = 'plants_device_id';
const RUN_STORAGE_PREFIX = 'plants_lesson_run_v1_';
const RUN_RESUME_KEY = 'plants_active_lesson_run_v1';
const params = new URLSearchParams(window.location.search);
const DIRECT_LESSON_ID = String(params.get('lesson') || params.get('lesson_id') || '').trim();

const state = {
  content: null,
  player: null,
  selectedLessonId: DIRECT_LESSON_ID || DEFAULT_LESSON_ID,
  loadPromise: null,
  pendingLessonId: '',
  usingCache: false,
  appearance: {
    themeId: 'THEME_05',
    displayModeId: 'normal',
    themeChosenByStudent: false,
    modeChosenByStudent: false
  },
  group: {
    teams: [],
    stealEnabled: false,
    activeTeamIndex: 0,
    questionTeamIndex: 0,
    questionAttempt: 1,
    awaitingSteal: false
  },
  lessonRun: {
    lessonId: '',
    completedLevels: new Map(),
    usedQuestionIds: new Set(),
    sessionId: '',
    resultId: '',
    startPromise: null,
    saveQueue: Promise.resolve()
  },
  game: {
    level: null,
    deck: [],
    firstCard: null,
    secondCard: null,
    locked: false,
    matchedPairs: 0,
    moves: 0,
    roundToken: 0,
    nextLevel: null,
    currentQuestion: null,
    selectedOption: '',
    questionStartedAt: 0,
    questionTimerId: 0,
    questionSecondsLeft: 0,
    advanceAfterQuestion: false,
    correctAnswers: 0,
    wrongAnswers: 0,
    score: 0,
    teamStats: [],
    answerLog: [],
    levelStartedAt: 0
  }
};

const $ = (selector) => document.querySelector(selector);

function showView(id) {
  ['loadingView', 'loginView', 'lessonView', 'groupSetupView', 'readyView', 'gameView', 'resultView'].forEach((viewId) => {
    $(`#${viewId}`).hidden = viewId !== id;
  });
  document.body.classList.toggle('game-active', id === 'gameView');
  window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
}

function isGroupMode() {
  return state.player?.game_mode === 'class';
}

function activeTeam() {
  return state.group.teams[state.group.activeTeamIndex] || null;
}

function nextTeamIndex(index = state.group.activeTeamIndex) {
  return state.group.teams.length ? (index + 1) % state.group.teams.length : 0;
}

function advanceTeam() {
  if (!isGroupMode() || !state.group.teams.length) return;
  state.group.activeTeamIndex = nextTeamIndex();
}

function defaultTeams(count = 2) {
  return Array.from({ length: count }, (_, index) => ({
    team_id: `TEAM_${index + 1}`,
    team_name: state.group.teams[index]?.team_name || `الفريق ${index + 1}`
  }));
}

function renderGroupSetup() {
  const count = Math.min(4, Math.max(2, state.group.teams.length || 2));
  const radio = document.querySelector(`input[name="team_count"][value="${count}"]`);
  if (radio) radio.checked = true;
  $('#questionStealEnabled').checked = Boolean(state.group.stealEnabled);
  renderTeamNameFields(count);
  $('#groupSetupMessage').textContent = '';
  showView('groupSetupView');
}

function renderTeamNameFields(count) {
  const teams = defaultTeams(count);
  $('#teamNameFields').innerHTML = teams.map((team, index) => `
    <label>اسم الفريق ${index + 1}
      <input type="text" name="team_name_${index + 1}" maxlength="60" value="${escapeHtml(team.team_name)}" placeholder="مثال: فريق الأوراق" required>
    </label>`).join('');
}

function proceedAfterLessonSelection() {
  if (isGroupMode()) renderGroupSetup();
  else {
    restoreLessonRun(state.selectedLessonId);
    renderReady();
  }
}

function emptyLessonRun(lessonId = state.selectedLessonId) {
  return {
    lessonId: String(lessonId || ''),
    completedLevels: new Map(),
    usedQuestionIds: new Set(),
    sessionId: '',
    resultId: '',
    startPromise: null,
    saveQueue: Promise.resolve()
  };
}

function basePlayerIdentity() {
  if (!state.player) return '';
  return [
    state.player.game_mode || 'solo',
    state.player.student_name || '',
    state.player.class_name || '',
    state.player.school_name || ''
  ].map((value) => String(value).trim().toLowerCase()).join('|');
}

function runStorageKey(lessonId = state.selectedLessonId) {
  const playerIdentity = basePlayerIdentity();
  if (!playerIdentity) return '';
  const identity = [
    playerIdentity,
    ...(isGroupMode() ? state.group.teams.map((team) => team.team_name || '') : []),
    lessonId || ''
  ].map((value) => String(value).trim().toLowerCase()).join('|');
  return `${RUN_STORAGE_PREFIX}${encodeURIComponent(identity)}`;
}

function saveLessonRun(run = state.lessonRun) {
  const key = runStorageKey(run.lessonId);
  if (!key || !run.lessonId) return;
  try {
    sessionStorage.setItem(key, JSON.stringify({
      lessonId: run.lessonId,
      completedLevels: [...run.completedLevels.entries()],
      usedQuestionIds: [...run.usedQuestionIds],
      sessionId: run.sessionId || '',
      resultId: run.resultId || ''
    }));
    sessionStorage.setItem(RUN_RESUME_KEY, JSON.stringify({
      lessonId: run.lessonId,
      playerIdentity: basePlayerIdentity(),
      teams: isGroupMode() ? state.group.teams : [],
      stealEnabled: isGroupMode() && state.group.stealEnabled
    }));
  } catch (_) {}
}

function resumableLessonId() {
  try {
    const saved = JSON.parse(sessionStorage.getItem(RUN_RESUME_KEY) || 'null');
    if (!saved || saved.playerIdentity !== basePlayerIdentity() || !saved.lessonId) return '';
    if (isGroupMode()) {
      state.group.teams = Array.isArray(saved.teams) ? saved.teams : [];
      state.group.stealEnabled = Boolean(saved.stealEnabled);
    }
    return sessionStorage.getItem(runStorageKey(saved.lessonId)) ? String(saved.lessonId) : '';
  } catch (_) {
    sessionStorage.removeItem(RUN_RESUME_KEY);
    return '';
  }
}

function restoreLessonRun(lessonId = state.selectedLessonId) {
  const run = emptyLessonRun(lessonId);
  const key = runStorageKey(lessonId);
  if (key) {
    try {
      const saved = JSON.parse(sessionStorage.getItem(key) || 'null');
      if (saved && String(saved.lessonId) === String(lessonId)) {
        run.completedLevels = new Map(Array.isArray(saved.completedLevels) ? saved.completedLevels : []);
        run.usedQuestionIds = new Set(Array.isArray(saved.usedQuestionIds) ? saved.usedQuestionIds.map(String) : []);
        run.sessionId = String(saved.sessionId || '');
        run.resultId = String(saved.resultId || '');
        if (run.sessionId && run.resultId) run.startPromise = Promise.resolve(run);
      }
    } catch (_) {
      sessionStorage.removeItem(key);
    }
  }
  state.lessonRun = run;
  return run;
}

function resetLessonRun(lessonId = state.selectedLessonId, clearStored = false) {
  const key = runStorageKey(lessonId);
  if (clearStored && key) {
    try {
      sessionStorage.removeItem(key);
      const marker = JSON.parse(sessionStorage.getItem(RUN_RESUME_KEY) || 'null');
      if (marker?.playerIdentity === basePlayerIdentity() && String(marker?.lessonId) === String(lessonId)) {
        sessionStorage.removeItem(RUN_RESUME_KEY);
      }
    } catch (_) {}
  }
  state.lessonRun = emptyLessonRun(lessonId);
}

function ensureLessonRunStarted() {
  const run = state.lessonRun;
  if (run.startPromise) return run.startPromise;
  const recordedPlayerName = isGroupMode()
    ? `جولة جماعية: ${state.group.teams.map((team) => team.team_name).join(' × ')}`
    : state.player.student_name;
  run.startPromise = apiPost('start_lesson_run', {
    student_name: recordedPlayerName,
    class_name: state.player.class_name,
    school_name: state.player.school_name,
    lesson_id: run.lessonId,
    game_mode: state.player.game_mode,
    level_id: '',
    theme_id: state.appearance.themeId,
    display_mode_id: state.appearance.displayModeId,
    device_id: deviceId()
  }).then((started) => {
    run.sessionId = started.session_id;
    run.resultId = started.result_id;
    saveLessonRun(run);
    return run;
  }).catch(() => {
    run.startPromise = null;
    return null;
  });
  return run.startPromise;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]);
}

function isActive(value) {
  if (value === false || value === 0) return false;
  return !['false', '0', 'no', 'لا', 'غير مفعل'].includes(String(value ?? '').trim().toLowerCase());
}

function explicitlyEnabled(value) {
  if (value === true || value === 1) return true;
  return ['true', '1', 'yes', 'نعم', 'مفعل', 'مفعّل'].includes(String(value ?? '').trim().toLowerCase());
}

function settingValue(key, fallback = '') {
  const settings = state.content?.settings;
  if (Array.isArray(settings)) {
    const row = settings.find((item) => isActive(item.active) && String(item.setting_key || '') === key);
    return row ? row.setting_value : fallback;
  }
  if (settings && typeof settings === 'object' && Object.prototype.hasOwnProperty.call(settings, key)) {
    return settings[key];
  }
  return fallback;
}

function activeThemes() {
  return (state.content?.themes || []).filter((theme) => isActive(theme.active));
}

function activeDisplayModes() {
  return (state.content?.display_modes || []).filter((mode) => isActive(mode.active));
}

function themeColor(themeId) {
  return ({ THEME_02: '#173f4a', THEME_04: '#123f39', THEME_05: '#087552', THEME_08: '#0b5960' })[themeId] || '#087552';
}

function applyAppearance(themeId = state.appearance.themeId, displayModeId = state.appearance.displayModeId, studentChoice = '') {
  state.appearance.themeId = themeId;
  state.appearance.displayModeId = displayModeId;
  if (studentChoice === 'theme') state.appearance.themeChosenByStudent = true;
  if (studentChoice === 'mode') state.appearance.modeChosenByStudent = true;
  document.body.dataset.theme = themeId;
  document.body.dataset.displayMode = displayModeId;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', themeColor(themeId));
  document.querySelectorAll('[data-theme-id]').forEach((button) => {
    const selected = button.dataset.themeId === themeId;
    button.classList.toggle('is-selected', selected);
    button.setAttribute('aria-checked', String(selected));
  });
  document.querySelectorAll('[data-display-mode-id]').forEach((button) => {
    const selected = button.dataset.displayModeId === displayModeId;
    button.classList.toggle('is-selected', selected);
    button.setAttribute('aria-checked', String(selected));
  });
  const themeName = activeThemes().find((theme) => String(theme.theme_id) === themeId)?.theme_name || 'الدفيئة المرحة';
  const modeName = activeDisplayModes().find((mode) => String(mode.display_mode_id) === displayModeId)?.display_mode_name || 'عادي';
  if ($('#appearanceSummary')) $('#appearanceSummary').textContent = `${themeName} · ${modeName}`;
}

function initializeAppearance() {
  const themes = activeThemes();
  const modes = activeDisplayModes();
  const defaultTheme = String(settingValue('default_theme', themes.find((theme) => isActive(theme.is_default))?.theme_id || 'THEME_05'));
  const defaultMode = String(settingValue('default_display_mode', settingValue('display_mode_id', settingValue('default_card_display_mode', modes.find((mode) => isActive(mode.is_default))?.display_mode_id || 'normal'))));
  const allowThemeChoice = isActive(settingValue('allow_student_theme_choice', true));
  const allowModeChoice = isActive(settingValue('allow_student_display_mode_choice', true));
  const selectedThemeIsAvailable = themes.some((theme) => String(theme.theme_id) === state.appearance.themeId);
  const selectedModeIsAvailable = modes.some((mode) => String(mode.display_mode_id) === state.appearance.displayModeId);
  const themeId = allowThemeChoice && state.appearance.themeChosenByStudent && selectedThemeIsAvailable
    ? state.appearance.themeId
    : defaultTheme;
  const displayModeId = allowModeChoice && state.appearance.modeChosenByStudent && selectedModeIsAvailable
    ? state.appearance.displayModeId
    : defaultMode;
  applyAppearance(
    themes.some((theme) => String(theme.theme_id) === themeId) ? themeId : (themes[0]?.theme_id || 'THEME_05'),
    modes.some((mode) => String(mode.display_mode_id) === displayModeId) ? displayModeId : (modes[0]?.display_mode_id || 'normal')
  );
}

function renderAppearanceControls() {
  const themes = activeThemes();
  const modes = activeDisplayModes();
  const showAppearancePanel = isActive(currentLesson()?.appearance_panel_enabled ?? true);
  const allowThemeChoice = isActive(settingValue('allow_student_theme_choice', true)) && themes.length > 1;
  const allowModeChoice = isActive(settingValue('allow_student_display_mode_choice', true)) && modes.length > 1;
  $('#appearancePanel').hidden = !showAppearancePanel || (!allowThemeChoice && !allowModeChoice);
  $('#themeChoiceGroup').hidden = !allowThemeChoice;
  $('#displayModeChoiceGroup').hidden = !allowModeChoice;
  $('#themeChoices').innerHTML = allowThemeChoice ? themes.map((theme) => `
    <button class="theme-choice" type="button" role="radio" aria-checked="false" data-theme-id="${escapeHtml(theme.theme_id)}">
      <span class="theme-swatch swatch-${escapeHtml(theme.theme_id.toLowerCase().replace('_', '-'))}" aria-hidden="true"><i></i></span>
      <strong>${escapeHtml(theme.theme_name || 'تصميم')}</strong>
      <small>${escapeHtml(theme.description || '')}</small>
    </button>`).join('') : '';
  const modeIcons = { normal: '▭', tilted: '◩', '3d': '⬢' };
  $('#displayModeChoices').innerHTML = allowModeChoice ? modes.map((mode) => `
    <button class="display-mode-choice" type="button" role="radio" aria-checked="false" data-display-mode-id="${escapeHtml(mode.display_mode_id)}">
      <span aria-hidden="true">${modeIcons[mode.display_mode_id] || '▭'}</span>
      <strong>${escapeHtml(mode.display_mode_name || 'عرض')}</strong>
      <small>${escapeHtml(mode.description || '')}</small>
    </button>`).join('') : '';
  applyAppearance();
}

function shuffle(items) {
  const shuffled = [...items];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const randomIndex = Math.floor(Math.random() * (index + 1));
    [shuffled[index], shuffled[randomIndex]] = [shuffled[randomIndex], shuffled[index]];
  }
  return shuffled;
}

async function apiPost(action, data) {
  const response = await fetch(API_URL, {
    method: 'POST',
    redirect: 'follow',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ action, data })
  });
  if (!response.ok) throw new Error('تعذر الاتصال بقاعدة البيانات.');
  const payload = await response.json();
  if (!payload.ok) throw new Error(payload.error || 'لم تكتمل عملية الحفظ.');
  return payload.data;
}

function deviceId() {
  let id = '';
  try { id = localStorage.getItem(DEVICE_STORAGE_KEY) || ''; } catch (_) {}
  if (!id) {
    id = globalThis.crypto?.randomUUID?.() || `DEVICE_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    try { localStorage.setItem(DEVICE_STORAGE_KEY, id); } catch (_) {}
  }
  return id;
}

function displayImageUrls(value) {
  const url = String(value || '').trim();
  if (!url) return [];
  if (!url.includes('drive.google.com')) return [url];
  const idMatch = url.match(/[?&]id=([^&]+)/) || url.match(/\/d\/([^/]+)/);
  if (!idMatch) return [url];
  const fileId = encodeURIComponent(idMatch[1]);
  const thumbnailUrl = `https://drive.google.com/thumbnail?id=${fileId}&sz=w1200`;
  return [
    thumbnailUrl,
    `${thumbnailUrl}&retry=${Date.now()}`,
    `https://lh3.googleusercontent.com/d/${fileId}=w1200`
  ];
}

function levelKey(level, index = -1) {
  const id = level?.level_id;
  return String(id === undefined || id === null || id === '' ? index : id);
}

function getActiveLessons() {
  return (state.content?.lessons || []).filter((lesson) => isActive(lesson.active));
}

function lessonAllowsGroupMode(lesson) {
  return isActive(lesson?.group_mode_enabled);
}

function getLessonsForSelectedMode() {
  const lessons = getActiveLessons();
  return isGroupMode() ? lessons.filter(lessonAllowsGroupMode) : lessons;
}

function updatePlayerModeLabels(group) {
  $('#playerNameLabel').textContent = group ? 'اسم منظم الجولة' : 'اسم الطالب';
  $('#studentName').placeholder = group ? 'اكتب اسم المنظم' : 'اكتب اسمك';
}

function applyGameModeAvailability() {
  const groupRadio = document.querySelector('input[name="game_mode"][value="class"]');
  const soloRadio = document.querySelector('input[name="game_mode"][value="solo"]');
  const groupAvailable = getActiveLessons().some(lessonAllowsGroupMode);
  $('#gameModeField').hidden = !groupAvailable;
  groupRadio.disabled = !groupAvailable;
  if (!groupAvailable) {
    soloRadio.checked = true;
    if (state.player) state.player.game_mode = 'solo';
    updatePlayerModeLabels(false);
  }
}

function enforceSelectedLessonMode() {
  if (!isGroupMode() || lessonAllowsGroupMode(currentLesson())) return;
  state.player.game_mode = 'solo';
  const soloRadio = document.querySelector('input[name="game_mode"][value="solo"]');
  if (soloRadio) soloRadio.checked = true;
  updatePlayerModeLabels(false);
}

function cacheKey(lessonId) {
  return `${CACHE_PREFIX}${lessonId}`;
}

function readCachedContent(lessonId) {
  try {
    const cached = JSON.parse(localStorage.getItem(cacheKey(lessonId)) || 'null');
    return cached?.data ? cached.data : null;
  } catch (_) {
    return null;
  }
}

function saveCachedContent(lessonId, data) {
  try {
    localStorage.setItem(cacheKey(lessonId), JSON.stringify({ saved_at: Date.now(), data }));
  } catch (_) {
    // تستمر اللعبة حتى إذا منع المتصفح التخزين المحلي.
  }
}

function validateLesson(data, lessonId) {
  const activeLessons = (data.lessons || []).filter((lesson) => isActive(lesson.active));
  if (DIRECT_LESSON_ID && !activeLessons.some((lesson) => String(lesson.lesson_id) === lessonId)) {
    throw new Error('رابط الدرس غير صحيح أو أن الدرس غير مفعّل.');
  }
}

async function fetchBootstrap(lessonId) {
  const url = `${API_URL}?action=bootstrap&lesson_id=${encodeURIComponent(lessonId)}&_=${Date.now()}`;
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(url, { cache: 'no-store', signal: controller.signal });
    if (!response.ok) throw new Error('تعذر الاتصال بقاعدة البيانات.');
    const payload = await response.json();
    if (!payload.ok || !payload.data) throw new Error(payload.error || 'لم تصل بيانات الدرس.');
    validateLesson(payload.data, lessonId);
    return payload.data;
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('استغرق الاتصال وقتًا أطول من المتوقع. حاول مرة أخرى.');
    throw error;
  } finally {
    window.clearTimeout(timeoutId);
  }
}

function applyContent(data, lessonId, fromCache = false) {
  state.content = data;
  state.selectedLessonId = lessonId;
  state.usingCache = fromCache;
  initializeAppearance();
  renderLoginContent();
}

function setContentLoading() {
  $('#contentStatus').hidden = true;
  $('#contentStatus').innerHTML = '';
}

function setContentError(message) {
  $('#contentStatus').hidden = false;
  $('#contentStatus').innerHTML = `<span class="status-chip status-error">${escapeHtml(message)}</span>`;
}

async function beginInitialLoad() {
  const lessonId = state.selectedLessonId;
  const cached = readCachedContent(lessonId);
  if (cached) applyContent(cached, lessonId, true);
  else setContentLoading();

  state.loadPromise = fetchBootstrap(lessonId)
    .then((data) => {
      saveCachedContent(lessonId, data);
      applyContent(data, lessonId, false);
      return data;
    })
    .catch((error) => {
      if (cached) {
        state.usingCache = true;
        renderLoginContent('تعذر التحديث؛ ستُستخدم البيانات المحفوظة');
        return cached;
      }
      setContentError(error.message || 'تعذر تحميل الدروس. تحقق من الإنترنت ثم حاول مجددًا.');
      throw error;
    })
    .finally(() => {
      state.loadPromise = null;
    });

  state.loadPromise.catch(() => {});
  return state.loadPromise;
}

function currentLesson() {
  return (state.content?.lessons || []).find((item) => String(item.lesson_id) === state.selectedLessonId);
}

function renderLoginContent(note = '') {
  $('#contentStatus').hidden = true;
  $('#contentStatus').innerHTML = '';
  applyGameModeAvailability();
}

function restorePlayer() {
  try {
    const saved = JSON.parse(localStorage.getItem(PLAYER_STORAGE_KEY) || 'null');
    if (!saved) return null;
    state.player = saved;
    $('#studentName').value = saved.student_name || '';
    $('#className').value = saved.class_name || '';
    $('#schoolName').value = saved.school_name || 'مدرسة جرير الابتدائية بالقطيف';
    const savedMode = ['solo', 'class'].includes(saved.game_mode) ? saved.game_mode : 'solo';
    const mode = document.querySelector(`input[name="game_mode"][value="${savedMode}"]`);
    if (mode) mode.checked = true;
    return saved;
  } catch (_) {
    localStorage.removeItem(PLAYER_STORAGE_KEY);
    return null;
  }
}

function renderLessonPicker() {
  const lessons = getLessonsForSelectedMode();
  $('#lessonPlayerName').textContent = state.player?.student_name || '';
  $('#lessonGrid').innerHTML = lessons.map((lesson, index) => {
    const lessonId = String(lesson.lesson_id || '');
    const isCurrent = lessonId === state.selectedLessonId;
    return `
      <button class="lesson-choice${isCurrent ? ' current' : ''}" type="button" data-lesson-id="${escapeHtml(lessonId)}">
        <span class="lesson-choice-number">${index + 1}</span>
        <span class="lesson-choice-copy">
          <strong>${escapeHtml(lesson.lesson_name || `الدرس ${index + 1}`)}</strong>
          <small>${escapeHtml(lesson.description || lesson.subject || 'اضغط لاختيار هذا الدرس')}</small>
        </span>
        <span class="lesson-choice-arrow" aria-hidden="true">←</span>
      </button>`;
  }).join('');
  showView('lessonView');
}

function showLoading(message, lessonId) {
  state.pendingLessonId = lessonId;
  $('#loadingMessage').textContent = message;
  $('#retryButton').hidden = true;
  showView('loadingView');
}

async function selectLesson(lessonId) {
  if (lessonId === state.selectedLessonId && state.content) {
    enforceSelectedLessonMode();
    proceedAfterLessonSelection();
    return;
  }

  const cached = readCachedContent(lessonId);
  if (cached) {
    applyContent(cached, lessonId, true);
    enforceSelectedLessonMode();
    proceedAfterLessonSelection();
    fetchBootstrap(lessonId).then((data) => {
      saveCachedContent(lessonId, data);
      applyContent(data, lessonId, false);
      enforceSelectedLessonMode();
      if (!$('#readyView').hidden) renderReady();
    }).catch(() => {});
    return;
  }

  showLoading('جارٍ تجهيز الدرس المختار…', lessonId);
  try {
    const data = await fetchBootstrap(lessonId);
    saveCachedContent(lessonId, data);
    applyContent(data, lessonId, false);
    enforceSelectedLessonMode();
    proceedAfterLessonSelection();
  } catch (error) {
    $('#loadingMessage').textContent = error.message || 'تعذر تجهيز الدرس. تحقق من الإنترنت.';
    $('#retryButton').hidden = false;
  }
}

async function ensureContent() {
  if (state.content) return state.content;
  if (state.loadPromise) return state.loadPromise;
  await beginInitialLoad();
  if (state.loadPromise) return state.loadPromise;
  if (!state.content) throw new Error('تعذر تحميل الدروس. تحقق من الإنترنت ثم حاول مجددًا.');
  return state.content;
}

async function continueAfterLogin() {
  await ensureContent();
  let lessons = getLessonsForSelectedMode();
  if (!lessons.length && isGroupMode()) {
    state.player.game_mode = 'solo';
    document.querySelector('input[name="game_mode"][value="solo"]').checked = true;
    updatePlayerModeLabels(false);
    lessons = getActiveLessons();
  }
  if (!lessons.length) throw new Error('لا توجد دروس مفعّلة حاليًا.');

  if (DIRECT_LESSON_ID) {
    await selectLesson(DIRECT_LESSON_ID);
    return;
  }
  if (lessons.length > 1) {
    renderLessonPicker();
    return;
  }
  await selectLesson(String(lessons[0].lesson_id));
}

function renderReady() {
  if (state.lessonRun.lessonId !== String(state.selectedLessonId)) restoreLessonRun(state.selectedLessonId);
  const modeName = state.player.game_mode === 'class' ? 'اللعب الجماعي' : 'اللعب الفردي';
  $('#playerName').textContent = state.player.student_name;
  $('#readyGreeting').innerHTML = isGroupMode()
    ? `الفرق جاهزة: <span id="playerName">${state.group.teams.map((team) => escapeHtml(team.team_name)).join(' · ')}</span>`
    : `مرحبًا <span id="playerName">${escapeHtml(state.player.student_name)}</span>`;
  $('#playerDetails').textContent = `${state.player.class_name} · ${state.player.school_name}`;
  $('#modeBadge').textContent = modeName;
  const lesson = currentLesson();
  $('#readyLessonTitle').textContent = lesson?.lesson_name ? `درس ${lesson.lesson_name}` : 'الدرس';
  $('#changeLessonButton').hidden = Boolean(DIRECT_LESSON_ID) || getLessonsForSelectedMode().length < 2;
  $('#editTeamsButton').hidden = !isGroupMode();
  renderAppearanceControls();

  const levels = (state.content.levels || []).filter((level) => isActive(level.active));
  const sequential = sequentialLevelsEnabled();
  $('#levelSequenceHint').hidden = !sequential;
  $('#completedRunBanner').hidden = !levels.length || !levels.every((level, index) => state.lessonRun.completedLevels.has(levelKey(level, index)));
  $('#levelsGrid').innerHTML = levels.length ? levels.map((level, index) => {
    const completed = state.lessonRun.completedLevels.has(levelKey(level, index));
    const locked = isLevelLocked(level, index, levels);
    const statusText = locked ? 'أكمل المستوى السابق' : completed ? '✓ مكتمل — أعد المستوى' : 'ابدأ المستوى';
    return `
    <button class="level-card${locked ? ' is-locked' : ''}${completed ? ' is-completed' : ''}" type="button" data-level-id="${escapeHtml(levelKey(level, index))}" data-locked="${locked}" ${locked ? 'disabled aria-disabled="true"' : ''}>
      <span class="level-number${locked ? ' is-lock' : ''}" aria-label="${locked ? 'المستوى مقفل' : `المستوى ${index + 1}`}">${locked ? '<span aria-hidden="true">🔒</span>' : index + 1}</span>
      <h3>${escapeHtml(level.level_name || `المستوى ${index + 1}`)}</h3>
      <p>${escapeHtml(level.card_count || 0)} بطاقات · ${escapeHtml(level.question_time_seconds || 30)} ثانية للسؤال</p>
      <span class="level-start">${statusText}</span>
    </button>`;
  }).join('') : '<article class="level-card"><h3>لا توجد مستويات مفعّلة</h3><p>يمكن إضافتها من لوحة المعلم.</p></article>';
  $('#levelMessage').textContent = '';
  showView('readyView');
}

function cardFaceMarkup(card) {
  const imageUrls = displayImageUrls(card.image_url);
  const imageUrl = imageUrls[0] || '';
  const title = card.card_title || 'بطاقة نباتية';
  if (imageUrl) {
    return `<span class="memory-card-visual"><img src="${escapeHtml(imageUrl)}" data-image-candidates="${escapeHtml(JSON.stringify(imageUrls))}" alt="${escapeHtml(card.image_description || title)}" loading="eager" decoding="async"><span class="card-fallback" aria-hidden="true">🌱</span></span>`;
  }
  return `<span class="memory-card-visual no-image"><span class="card-fallback" aria-hidden="true">🌱</span></span>`;
}

function buildDeck(level) {
  const cardCount = Number(level.card_count || 0);
  if (!cardCount || cardCount % 2 !== 0) throw new Error('عدد بطاقات هذا المستوى يجب أن يكون عددًا زوجيًا.');
  const pairCount = cardCount / 2;
  const availableCards = (state.content.cards || []).filter((card) => isActive(card.active));
  if (availableCards.length < pairCount) {
    throw new Error(`هذا المستوى يحتاج ${pairCount} أزواج، والمتاح حاليًا ${availableCards.length} فقط.`);
  }
  const selectedPairs = shuffle(availableCards).slice(0, pairCount);
  return shuffle(selectedPairs.flatMap((card, pairIndex) => {
    const pairId = String(card.card_id || `PAIR_${pairIndex}`);
    return [0, 1].map((copyIndex) => ({
      uid: `${pairId}_${pairIndex}_${copyIndex}_${Date.now()}`,
      pairId,
      source: card,
      flipped: false,
      matched: false
    }));
  }));
}

const SMART_ROW_LAYOUTS = Object.freeze({
  2: [2],
  4: [2, 2],
  6: [3, 3],
  8: [4, 4],
  10: [4, 3, 3],
  12: [4, 4, 4],
  14: [4, 5, 5],
  16: [5, 6, 5],
  18: [6, 5, 4, 3],
  20: [5, 5, 5, 5]
});

function parseRowLayout(value, cardCount) {
  const rows = String(value || '').trim().split(/[^0-9]+/).filter(Boolean).map(Number);
  if (!rows.length || rows.some((count) => !Number.isInteger(count) || count < 1 || count > 10)) return null;
  return rows.reduce((sum, count) => sum + count, 0) === cardCount ? rows : null;
}

function balancedRows(cardCount, maximumPerRow) {
  const rowCount = Math.max(1, Math.ceil(cardCount / maximumPerRow));
  const smallestRow = Math.floor(cardCount / rowCount);
  const largerRows = cardCount % rowCount;
  return Array.from({ length: rowCount }, (_, index) => smallestRow + (index < largerRows ? 1 : 0));
}

function smartRows(cardCount) {
  if (SMART_ROW_LAYOUTS[cardCount]) return [...SMART_ROW_LAYOUTS[cardCount]];
  const maximumPerRow = cardCount <= 8 ? 4 : cardCount <= 24 ? 6 : 7;
  return balancedRows(cardCount, maximumPerRow);
}

function responsiveRows(cardCount, availableWidth, availableHeight) {
  const gap = availableWidth <= 560 ? 7 : 11;
  if (availableWidth <= 560) {
    if (cardCount === 8) return [2, 3, 3];
    const minimumMobileCardWidth = 76;
    const columnsAllowedByWidth = Math.floor((availableWidth + gap) / (minimumMobileCardWidth + gap));
    const maximumColumns = Math.min(4, cardCount, Math.max(2, columnsAllowedByWidth));
    return balancedRows(cardCount, maximumColumns).reverse();
  }
  let best = null;
  const minimumComfortableCardWidth = 96;
  const columnsAllowedByWidth = Math.floor((availableWidth + gap) / (minimumComfortableCardWidth + gap));
  const maximumColumns = Math.min(7, cardCount, Math.max(2, columnsAllowedByWidth));

  for (let columns = 2; columns <= maximumColumns; columns += 1) {
    const rows = balancedRows(cardCount, columns).reverse();
    const actualColumns = Math.max(...rows);
    const rowCount = rows.length;
    const widthLimit = (availableWidth - gap * (actualColumns - 1)) / actualColumns;
    const heightLimit = ((availableHeight - gap * (rowCount - 1)) / rowCount) * 0.8;
    const cardWidth = Math.min(widthLimit, heightLimit);
    if (!best || cardWidth > best.cardWidth) best = { rows, cardWidth };
  }

  return best?.rows || [cardCount];
}

function resolvedRowLayout(level, cardCount, viewportWidth, availableHeight) {
  if (viewportWidth <= 850) {
    return responsiveRows(cardCount, viewportWidth, Math.max(180, availableHeight || 480));
  }
  return parseRowLayout(level?.row_layout, cardCount) || smartRows(cardCount);
}

function memoryCardMarkup(card) {
  const revealed = card.flipped || card.matched;
  const classes = ['memory-card', revealed ? 'is-flipped' : '', card.matched ? 'is-matched' : ''].filter(Boolean).join(' ');
  const label = card.matched
    ? `زوج مكتشف: ${card.source.card_title || 'بطاقة'}`
    : card.flipped
      ? `بطاقة مكشوفة: ${card.source.card_title || 'بطاقة'}`
      : 'بطاقة مغلقة';
  return `<button class="${classes}" type="button" data-card-uid="${escapeHtml(card.uid)}" aria-label="${escapeHtml(label)}" ${card.matched ? 'disabled' : ''}>
    <span class="memory-card-inner">
      <span class="memory-card-face memory-card-back" aria-hidden="true"><span class="card-back-emblem">🌿</span></span>
      <span class="memory-card-face memory-card-front">${cardFaceMarkup(card.source)}</span>
    </span>
  </button>`;
}

function renderBoard(forcedRows = null) {
  const grid = $('#memoryGrid');
  const boardSurface = grid.parentElement;
  const gameStage = boardSurface?.closest('.game-stage');
  if (boardSurface) boardSurface.dataset.cardCount = String(state.game.deck.length);
  if (gameStage) gameStage.dataset.cardCount = String(state.game.deck.length);
  const viewportHeight = window.visualViewport?.height || window.innerHeight;
  const initialWidth = Math.min(window.innerWidth, 1120);
  const rows = forcedRows || resolvedRowLayout(state.game.level, state.game.deck.length, initialWidth, viewportHeight - 180);
  let offset = 0;
  grid.dataset.rowLayout = rows.join('-');
  grid.dataset.rowCount = String(rows.length);
  grid.innerHTML = rows.map((rowLength) => {
    const rowCards = state.game.deck.slice(offset, offset + rowLength);
    offset += rowLength;
    return `<div class="memory-row">${rowCards.map(memoryCardMarkup).join('')}</div>`;
  }).join('');
  grid.querySelectorAll('img').forEach((image) => {
    let candidates = [];
    try { candidates = JSON.parse(image.dataset.imageCandidates || '[]'); } catch (_) {}
    let candidateIndex = 1;
    image.addEventListener('load', () => image.parentElement?.classList.remove('image-failed'));
    image.addEventListener('error', () => {
      if (candidateIndex < candidates.length) {
        const nextUrl = candidates[candidateIndex];
        candidateIndex += 1;
        window.setTimeout(() => { if (image.isConnected) image.src = nextUrl; }, 260 * candidateIndex);
        return;
      }
      image.parentElement?.classList.add('image-failed');
      image.remove();
    });
  });
  window.requestAnimationFrame(fitBoardToViewport);
}

function fitBoardToViewport() {
  const grid = $('#memoryGrid');
  if (!grid || $('#gameView').hidden || !state.game.deck.length) return;
  const viewportWidth = window.innerWidth;
  const gap = viewportWidth <= 560 ? 7 : 11;
  const viewportHeight = window.visualViewport?.height || window.innerHeight;
  const boardSurface = grid.parentElement;
  const availableWidth = Math.min(boardSurface?.clientWidth || grid.clientWidth, 1120);
  const boardTop = boardSurface?.getBoundingClientRect().top ?? grid.getBoundingClientRect().top;
  const reservedBottomSpace = viewportWidth <= 560 ? 30 : viewportWidth <= 850 ? 42 : 56;
  const viewportAvailableHeight = viewportHeight - boardTop - 10;
  const availableHeight = Math.max(120, viewportAvailableHeight - reservedBottomSpace);
  const rows = resolvedRowLayout(state.game.level, state.game.deck.length, availableWidth, availableHeight);
  if (grid.dataset.rowLayout !== rows.join('-')) {
    renderBoard(rows);
    return;
  }
  const columnCount = Math.max(...rows);
  const rowCount = rows.length;
  const isPortraitLevelTwo = viewportWidth <= 560 && state.game.deck.length === 8;
  const widthReferenceColumns = isPortraitLevelTwo ? 3.7 : columnCount;
  const widthLimit = (availableWidth - gap * (widthReferenceColumns - 1)) / widthReferenceColumns;
  const heightLimit = (availableHeight - gap * (rowCount - 1)) / rowCount;
  const sizeLimit = viewportWidth <= 560 ? widthLimit : Math.min(widthLimit, heightLimit * 0.8);
  const cardWidth = Math.max(28, Math.floor(sizeLimit));
  const cardHeight = Math.floor(cardWidth * 1.25);
  const boardWidth = cardWidth * columnCount + gap * (columnCount - 1);
  grid.dataset.rowCount = String(rowCount);
  grid.style.width = `${Math.min(availableWidth, boardWidth)}px`;
  grid.style.rowGap = `${gap}px`;
  grid.style.setProperty('--board-column-gap', `${gap}px`);
  grid.querySelectorAll('.memory-card').forEach((card) => {
    card.style.flex = `0 0 ${cardWidth}px`;
    card.style.width = `${cardWidth}px`;
    card.style.height = `${cardHeight}px`;
  });
}

function updateGameHud(message = '') {
  $('#movesCount').textContent = state.game.moves;
  $('#matchedCount').textContent = state.game.matchedPairs;
  $('#pairsCount').textContent = state.game.deck.length / 2;
  const pairTotal = state.game.deck.length / 2;
  const progress = pairTotal ? Math.min(100, Math.round((state.game.matchedPairs / pairTotal) * 100)) : 0;
  $('#sideMatchedCount').textContent = `${state.game.matchedPairs} / ${pairTotal}`;
  $('#sideMovesCount').textContent = state.game.moves;
  $('#sideProgressFill').style.width = `${progress}%`;
  $('#sideActivePlayer').textContent = isGroupMode() ? (activeTeam()?.team_name || 'الفريق') : (state.player?.student_name || 'الطالب');
  if (message) $('#gameMessage').textContent = message;
  renderTeamScoreboard();
}

function renderTeamScoreboard() {
  const board = $('#teamScoreboard');
  if (!isGroupMode()) {
    board.hidden = true;
    board.innerHTML = '';
    return;
  }
  board.hidden = false;
  board.innerHTML = liveTeamStats().map((team, index) => `
    <div class="team-score ${index === state.group.activeTeamIndex ? 'active' : ''}">
      <div class="team-name-line"><span>${index === state.group.activeTeamIndex ? 'الدور الآن:' : 'الفريق:'}</span><strong>${escapeHtml(team.team_name)}</strong></div>
      <strong class="team-points">النقاط: ${team.score}</strong>
      <small>${team.matched_pairs} أزواج</small>
    </div>`).join('');
}

function liveTeamStats() {
  const savedById = new Map(teamTotals().map((team) => [team.team_id, team]));
  const currentAlreadySaved = state.game.level && state.lessonRun.completedLevels.has(levelKey(state.game.level));
  return state.group.teams.map((team, index) => {
    const saved = savedById.get(team.team_id) || {};
    const current = currentAlreadySaved ? {} : (state.game.teamStats[index] || {});
    return {
      ...team,
      matched_pairs: Number(saved.matched_pairs || 0) + Number(current.matched_pairs || 0),
      correct_answers: Number(saved.correct_answers || 0) + Number(current.correct_answers || 0),
      wrong_answers: Number(saved.wrong_answers || 0) + Number(current.wrong_answers || 0),
      score: Number(saved.score || 0) + Number(current.score || 0),
      moves: Number(saved.moves || 0) + Number(current.moves || 0)
    };
  });
}

function teamStat(index) {
  return state.game.teamStats[index] || null;
}

function cardButton(uid) {
  return [...$('#memoryGrid').querySelectorAll('[data-card-uid]')].find((button) => button.dataset.cardUid === uid);
}

function setCardVisual(card, flipped, matched = false) {
  const button = cardButton(card.uid);
  if (!button) return;
  button.classList.toggle('is-flipped', flipped || matched);
  button.classList.toggle('is-matched', matched);
  button.disabled = matched;
  button.setAttribute('aria-label', matched ? `زوج مكتشف: ${card.source.card_title || 'بطاقة'}` : flipped ? `بطاقة مكشوفة: ${card.source.card_title || 'بطاقة'}` : 'بطاقة مغلقة');
}

function resetTurn() {
  state.game.firstCard = null;
  state.game.secondCard = null;
  state.game.locked = false;
}

function questionOptionEntries(question) {
  return ['A', 'B', 'C', 'D'].map((letter, index) => ({
    letter,
    text: String(question[`option_${index + 1}`] || '').trim()
  })).filter((option) => option.text);
}

function normalizedCorrectOption(question) {
  const raw = String(question.correct_option || '').trim().toUpperCase();
  if (['A', 'B', 'C', 'D'].includes(raw)) return raw;
  const numeric = Number(raw);
  return Number.isInteger(numeric) && numeric >= 1 && numeric <= 4 ? ['A', 'B', 'C', 'D'][numeric - 1] : '';
}

function questionsForMatch(card) {
  const level = state.game.level || {};
  const minimum = Number(level.min_difficulty || 1);
  const maximum = Number(level.max_difficulty || 4);
  const unused = (state.content.questions || []).filter((question) => {
    const id = String(question.question_id || '');
    const difficulty = Number(question.difficulty || 1);
    return isActive(question.active) && id && !state.lessonRun.usedQuestionIds.has(id) && difficulty >= minimum && difficulty <= maximum;
  });
  const topicId = String(card?.source?.topic_id || '');
  const sameTopic = topicId ? unused.filter((question) => String(question.topic_id || '') === topicId) : [];
  return sameTopic.length ? sameTopic : unused;
}

function stopQuestionTimer() {
  window.clearInterval(state.game.questionTimerId);
  state.game.questionTimerId = 0;
}

function renderQuestionTimer() {
  $('#questionTimer').textContent = state.game.questionSecondsLeft;
  $('.question-timer').classList.toggle('is-urgent', state.game.questionSecondsLeft <= 5);
}

function startQuestionTimer(seconds) {
  stopQuestionTimer();
  state.game.questionSecondsLeft = seconds;
  renderQuestionTimer();
  state.game.questionTimerId = window.setInterval(() => {
    state.game.questionSecondsLeft -= 1;
    renderQuestionTimer();
    if (state.game.questionSecondsLeft <= 0) submitQuestionAnswer(true);
  }, 1000);
}

function openQuestionForMatch(card) {
  const candidates = questionsForMatch(card);
  if (!candidates.length) {
    finishMatchedPair();
    return;
  }
  const question = shuffle(candidates)[0];
  state.game.currentQuestion = question;
  state.group.questionTeamIndex = state.group.activeTeamIndex;
  state.group.questionAttempt = 1;
  state.group.awaitingSteal = false;
  state.game.advanceAfterQuestion = false;
  state.lessonRun.usedQuestionIds.add(String(question.question_id));
  state.game.selectedOption = '';
  state.game.questionStartedAt = Date.now();
  $('#questionText').textContent = question.question_text || 'اختر الإجابة الصحيحة.';
  $('#questionTitle').textContent = isGroupMode() ? `السؤال للفريق: ${activeTeam()?.team_name || ''}` : 'اختر الإجابة الصحيحة';
  $('#questionOptions').innerHTML = questionOptionEntries(question).map((option) => `
    <button class="question-option" type="button" role="radio" aria-checked="false" data-option="${option.letter}">
      <span class="question-option-letter">${option.letter}</span>
      <span>${escapeHtml(option.text)}</span>
    </button>`).join('');
  $('#questionFeedback').hidden = true;
  $('#questionFeedback').className = 'question-feedback';
  $('#submitAnswerButton').disabled = true;
  $('#submitAnswerButton').textContent = 'اعتماد الإجابة';
  $('#questionDialog').showModal();
  const seconds = Math.max(5, Number(question.time_seconds || state.game.level?.question_time_seconds || 30));
  startQuestionTimer(seconds);
}

function beginStealAttempt() {
  state.group.awaitingSteal = false;
  state.group.questionAttempt = 2;
  state.group.activeTeamIndex = nextTeamIndex(state.group.questionTeamIndex);
  state.group.questionTeamIndex = state.group.activeTeamIndex;
  state.game.selectedOption = '';
  state.game.questionStartedAt = Date.now();
  $('#questionTitle').textContent = `السؤال الآن للفريق: ${activeTeam()?.team_name || ''}`;
  $('#questionOptions').querySelectorAll('[data-option]').forEach((button) => {
    button.disabled = false;
    button.classList.remove('is-selected', 'is-correct', 'is-wrong');
    button.setAttribute('aria-checked', 'false');
  });
  $('#questionFeedback').hidden = true;
  $('#questionFeedback').className = 'question-feedback';
  $('#submitAnswerButton').disabled = true;
  $('#submitAnswerButton').textContent = 'اعتماد الإجابة';
  const seconds = Math.max(5, Number(state.game.currentQuestion?.time_seconds || state.game.level?.question_time_seconds || 30));
  startQuestionTimer(seconds);
  renderTeamScoreboard();
}

function selectQuestionOption(letter) {
  if (!state.game.currentQuestion || !$('#questionFeedback').hidden) return;
  state.game.selectedOption = letter;
  $('#questionOptions').querySelectorAll('[data-option]').forEach((button) => {
    const selected = button.dataset.option === letter;
    button.classList.toggle('is-selected', selected);
    button.setAttribute('aria-checked', String(selected));
  });
  $('#submitAnswerButton').disabled = false;
}

function submitQuestionAnswer(timedOut = false) {
  const question = state.game.currentQuestion;
  if (!question || !$('#questionFeedback').hidden) return;
  if (!timedOut && !state.game.selectedOption) return;
  stopQuestionTimer();
  const correctOption = normalizedCorrectOption(question);
  const isCorrect = !timedOut && state.game.selectedOption === correctOption;
  const responseSeconds = Math.max(0, Math.round((Date.now() - state.game.questionStartedAt) / 1000));
  if (isCorrect) {
    state.game.correctAnswers += 1;
    state.game.score += Math.max(1, Number(question.points || 1));
  } else {
    state.game.wrongAnswers += 1;
  }
  const answeringTeam = isGroupMode() ? teamStat(state.group.questionTeamIndex) : null;
  if (answeringTeam) {
    if (isCorrect) {
      answeringTeam.correct_answers += 1;
      answeringTeam.score += Math.max(1, Number(question.points || 1));
    } else {
      answeringTeam.wrong_answers += 1;
    }
  }
  state.game.answerLog.push({
    question_id: String(question.question_id || ''),
    card_id: String(state.game.firstCard?.source?.card_id || ''),
    selected_option: timedOut ? '' : state.game.selectedOption,
    is_correct: isCorrect,
    response_time_seconds: responseSeconds,
    attempt_number: isGroupMode() ? state.group.questionAttempt : 1,
    team_id: answeringTeam?.team_id || '',
    team_name: answeringTeam?.team_name || '',
    question_text: String(question.question_text || ''),
    selected_answer: String(questionOptionEntries(question).find((option) => option.letter === state.game.selectedOption)?.text || ''),
    correct_answer: String(question.correct_answer || questionOptionEntries(question).find((option) => option.letter === correctOption)?.text || ''),
    feedback: String(question.feedback || '')
  });
  const canSteal = isGroupMode() && !isCorrect && state.group.stealEnabled && state.group.questionAttempt === 1;
  $('#questionOptions').querySelectorAll('[data-option]').forEach((button) => {
    button.disabled = true;
    button.classList.remove('is-selected');
    if (!canSteal && button.dataset.option === correctOption) button.classList.add('is-correct');
    if (!isCorrect && button.dataset.option === state.game.selectedOption) button.classList.add('is-wrong');
  });
  const feedback = String(question.feedback || '').trim();
  const answer = String(question.correct_answer || questionOptionEntries(question).find((option) => option.letter === correctOption)?.text || '').trim();
  const heading = isCorrect ? 'إجابة صحيحة، أحسنت!' : timedOut ? 'انتهى الوقت.' : 'الإجابة غير صحيحة.';
  const details = isCorrect
    ? (feedback || 'أحسنت، تابع إلى الزوج التالي.')
    : canSteal
      ? `تنتقل فرصة الإجابة إلى ${state.group.teams[nextTeamIndex(state.group.questionTeamIndex)]?.team_name || 'الفريق التالي'}.`
      : [answer ? `الإجابة الصحيحة: ${answer}.` : '', feedback].filter(Boolean).join(' ') || 'تابع إلى الزوج التالي.';
  $('#questionFeedback').className = `question-feedback ${isCorrect ? 'correct' : 'wrong'}`;
  $('#questionFeedback').innerHTML = `<strong>${escapeHtml(heading)}</strong>${escapeHtml(details)}`;
  $('#questionFeedback').hidden = false;
  $('#submitAnswerButton').disabled = false;
  if (canSteal) {
    state.group.awaitingSteal = true;
    $('#submitAnswerButton').textContent = 'انتقال السؤال للفريق التالي';
  } else {
    state.game.advanceAfterQuestion = isGroupMode() && !isCorrect && !state.group.stealEnabled;
    $('#submitAnswerButton').textContent = 'متابعة';
  }
  renderTeamScoreboard();
}

function finishMatchedPair() {
  stopQuestionTimer();
  if ($('#questionDialog').open) $('#questionDialog').close();
  state.game.currentQuestion = null;
  if (state.game.advanceAfterQuestion) advanceTeam();
  state.game.advanceAfterQuestion = false;
  resetTurn();
  updateGameHud(isGroupMode() ? `الدور الآن: ${activeTeam()?.team_name || ''}.` : 'تطابق رائع! ابحث عن الزوج التالي.');
  if (state.game.matchedPairs === state.game.deck.length / 2) completeLevel();
  else window.requestAnimationFrame(fitBoardToViewport);
}

function completedGameSnapshot() {
  return {
    lessonId: state.selectedLessonId,
    levelId: levelKey(state.game.level),
    matchedPairs: state.game.matchedPairs,
    correctAnswers: state.game.correctAnswers,
    wrongAnswers: state.game.wrongAnswers,
    score: state.game.score,
    moves: state.game.moves,
    teamStats: state.game.teamStats.map((team) => ({ ...team })),
    answerLog: state.game.answerLog.map((answer) => ({ ...answer })),
    durationSeconds: Math.max(0, Math.round((Date.now() - state.game.levelStartedAt) / 1000)),
    saveStarted: false
  };
}

function teamTotals(run = state.lessonRun) {
  const totals = new Map(state.group.teams.map((team) => [team.team_id, {
    ...team, matched_pairs: 0, correct_answers: 0, wrong_answers: 0, score: 0, moves: 0
  }]));
  [...run.completedLevels.values()].forEach((level) => {
    (level.teamStats || []).forEach((team) => {
      const total = totals.get(team.team_id);
      if (!total) return;
      total.matched_pairs += Number(team.matched_pairs || 0);
      total.correct_answers += Number(team.correct_answers || 0);
      total.wrong_answers += Number(team.wrong_answers || 0);
      total.score += Number(team.score || 0);
      total.moves += Number(team.moves || 0);
    });
  });
  return [...totals.values()].sort((a, b) => b.score - a.score || b.matched_pairs - a.matched_pairs || a.moves - b.moves);
}

function rankedTeamTotals(run = state.lessonRun) {
  const rows = teamTotals(run);
  let previousKey = '';
  let rank = 0;
  return rows.map((team, index) => {
    const key = `${team.score}|${team.matched_pairs}|${team.moves}`;
    if (key !== previousKey) rank = index + 1;
    previousKey = key;
    return { ...team, rank };
  });
}

function activeLevels() {
  return (state.content.levels || []).filter((level) => isActive(level.active));
}

function sequentialLevelsEnabled() {
  return explicitlyEnabled(currentLesson()?.sequential_levels_enabled);
}

function isLevelLocked(level, index, levels = activeLevels()) {
  if (!sequentialLevelsEnabled()) return false;
  const firstIncompleteIndex = levels.findIndex((item, itemIndex) => !state.lessonRun.completedLevels.has(levelKey(item, itemIndex)));
  return firstIncompleteIndex !== -1 && index > firstIncompleteIndex;
}

function lessonTotals(run = state.lessonRun) {
  const rows = [...run.completedLevels.values()];
  return rows.reduce((totals, row) => ({
    levels: totals.levels + 1,
    matchedPairs: totals.matchedPairs + row.matchedPairs,
    correctAnswers: totals.correctAnswers + row.correctAnswers,
    wrongAnswers: totals.wrongAnswers + row.wrongAnswers,
    score: totals.score + row.score,
    moves: totals.moves + row.moves,
    durationSeconds: totals.durationSeconds + row.durationSeconds,
    answers: totals.answers.concat(row.answerLog)
  }), { levels: 0, matchedPairs: 0, correctAnswers: 0, wrongAnswers: 0, score: 0, moves: 0, durationSeconds: 0, answers: [] });
}

function formatGameDuration(seconds) {
  const total = Math.max(0, Number(seconds || 0));
  const minutes = Math.floor(total / 60);
  const remainder = total % 60;
  return minutes ? `${minutes} د ${remainder} ث` : `${remainder} ث`;
}

function renderFinalResult() {
  const totals = lessonTotals();
  const answerCount = totals.correctAnswers + totals.wrongAnswers;
  const stars = answerCount ? Math.round((totals.correctAnswers / answerCount) * 5) : 0;
  const teams = isGroupMode() ? rankedTeamTotals() : [];
  if (isGroupMode()) {
    const winners = teams.filter((team) => team.rank === 1);
    $('#finalHeading').innerHTML = winners.length > 1
      ? `تعادل رائع بين ${winners.map((team) => escapeHtml(team.team_name)).join(' و ')}!`
      : `الفائز: ${escapeHtml(winners[0]?.team_name || '')}!`;
    $('#finalTeamResults').hidden = false;
    $('#finalTeamResults').innerHTML = teams.map((team) => `
      <article class="final-team-card ${team.rank === 1 ? 'winner' : ''}">
        <span>المركز ${team.rank}</span><strong>${escapeHtml(team.team_name)}</strong>
        <small>${team.score} نقطة · ${team.correct_answers} صحيحة · ${team.matched_pairs} أزواج</small>
      </article>`).join('');
  } else {
    $('#finalHeading').innerHTML = `أحسنت يا <span id="finalPlayerName">${escapeHtml(state.player?.student_name || '')}</span>!`;
    $('#finalTeamResults').hidden = true;
    $('#finalTeamResults').innerHTML = '';
  }
  $('#finalLessonName').textContent = `درس ${currentLesson()?.lesson_name || ''}`;
  $('#finalLevels').textContent = totals.levels;
  $('#finalCorrect').textContent = totals.correctAnswers;
  $('#finalWrong').textContent = totals.wrongAnswers;
  $('#finalScore').textContent = totals.score;
  $('#finalMoves').textContent = totals.moves;
  $('#finalPairs').textContent = totals.matchedPairs;
  $('#finalDuration').textContent = formatGameDuration(totals.durationSeconds);
  $('#finalStars').innerHTML = Array.from({ length: 5 }, (_, index) => `<span class="${index < stars ? '' : 'empty-star'}">★</span>`).join('');
  $('#reviewFinalErrorsButton').hidden = totals.wrongAnswers === 0;
  $('#finalSaveStatus').textContent = 'جارٍ حفظ تقدم المستوى الأخير…';
  showView('resultView');
}

function renderFinalErrors() {
  const errors = lessonTotals().answers.filter((answer) => !answer.is_correct);
  $('#finalErrorsList').innerHTML = errors.length ? errors.map((answer, index) => `
    <article class="final-error-item">
      <h3>${index + 1}. ${escapeHtml(answer.question_text || 'السؤال')}</h3>
      <p><strong>إجابتك:</strong> ${escapeHtml(answer.selected_answer || 'لم تُجب قبل انتهاء الوقت')}</p>
      <p><strong>الإجابة الصحيحة:</strong> ${escapeHtml(answer.correct_answer || '—')}</p>
      ${answer.feedback ? `<p><strong>التغذية الراجعة:</strong> ${escapeHtml(answer.feedback)}</p>` : ''}
    </article>`).join('') : '<p>لا توجد أسئلة خاطئة، أحسنت!</p>';
  $('#finalErrorsDialog').showModal();
}

async function persistCompletedLevel(run, completedGame, isFinalLevel, totals) {
  if (completedGame.saveStarted) return;
  completedGame.saveStarted = true;
  try {
    const startedRun = await run.startPromise;
    if (!startedRun?.sessionId || !startedRun?.resultId) throw new Error('لم تبدأ محاولة الدرس.');
    await apiPost('save_level_result', {
      session_id: run.sessionId,
      result_id: run.resultId,
      level_id: completedGame.levelId,
      matched_pairs: completedGame.matchedPairs,
      correct_answers: completedGame.correctAnswers,
      wrong_answers: completedGame.wrongAnswers,
      score: completedGame.score,
      stars: completedGame.answerLog.length ? Math.round((completedGame.correctAnswers / completedGame.answerLog.length) * 5) : 0,
      duration_seconds: completedGame.durationSeconds,
      moves: completedGame.moves
    });
    if (completedGame.answerLog.length) {
      await apiPost('save_answers', { answers: completedGame.answerLog.map((answer) => ({
        ...answer,
        session_id: run.sessionId,
        result_id: run.resultId,
        level_id: completedGame.levelId
      })) });
    }
    if (isGroupMode()) {
      await apiPost('save_team_results', {
        session_id: run.sessionId,
        result_id: run.resultId,
        teams: rankedTeamTotals(run)
      });
    }
    const answerCount = totals.correctAnswers + totals.wrongAnswers;
    await apiPost('update_result', {
      result_id: run.resultId,
      matched_pairs: totals.matchedPairs,
      correct_answers: totals.correctAnswers,
      wrong_answers: totals.wrongAnswers,
      score: totals.score,
      stars: answerCount ? Math.round((totals.correctAnswers / answerCount) * 5) : 0,
      duration_seconds: totals.durationSeconds,
      completed: isFinalLevel
    });
    if (isFinalLevel) await apiPost('complete_session', { session_id: run.sessionId });
    if (isFinalLevel) $('#finalSaveStatus').textContent = 'تم حفظ جميع نتائج المستويات.';
    else if (!$('#levelCompletePanel').hidden && levelKey(state.game.level) === completedGame.levelId) $('#completeSummary').textContent = 'تم حفظ تقدم هذا المستوى، ويمكنك الانتقال للمستوى التالي.';
  } catch (error) {
    const detail = String(error?.message || '').trim();
    const message = `تعذر حفظ تقدم هذا المستوى الآن${detail ? `: ${detail}` : '.'}`;
    if (isFinalLevel) $('#finalSaveStatus').textContent = message;
    else if (!$('#levelCompletePanel').hidden && levelKey(state.game.level) === completedGame.levelId) $('#completeSummary').textContent = message;
  }
}

function saveCompletedLevel(run, completedGame, isFinalLevel, totals) {
  const task = () => persistCompletedLevel(run, completedGame, isFinalLevel, totals);
  run.saveQueue = run.saveQueue.then(task, task);
  return run.saveQueue;
}

function completeLevel() {
  const levels = activeLevels();
  const run = state.lessonRun;
  const currentLevelKey = levelKey(state.game.level);
  const currentIndex = levels.findIndex((level) => levelKey(level) === currentLevelKey);
  const completedGame = completedGameSnapshot();
  run.completedLevels.set(currentLevelKey, completedGame);
  saveLessonRun(run);
  const totals = lessonTotals(run);
  const unfinished = levels.filter((level) => !run.completedLevels.has(levelKey(level)));
  const isFinalLevel = unfinished.length === 0;
  if (isFinalLevel) {
    renderFinalResult();
  } else {
    const laterUnfinished = levels.slice(currentIndex + 1).find((level) => !run.completedLevels.has(levelKey(level)));
    state.game.nextLevel = laterUnfinished || unfinished[0];
    $('#nextLevelButton').hidden = false;
    $('#levelCompleteTitle').textContent = `أحسنت! أكملت ${state.game.level.level_name || 'المستوى'}`;
    $('#completeSummary').textContent = 'يمكنك الانتقال إلى المستوى التالي.';
    $('#levelCompletePanel').hidden = false;
    $('#gameMessage').textContent = 'اكتملت جميع الأزواج بنجاح.';
  }
  saveCompletedLevel(run, completedGame, isFinalLevel, totals);
}

function beginNewRound() {
  const confirmed = window.confirm('هل تريد بدء جولة جديدة؟ سيُصفّر تقدم هذه الجولة، وستبقى نتائجك السابقة محفوظة لدى المعلم.');
  if (!confirmed) return;
  resetLessonRun(state.selectedLessonId, true);
  state.game.roundToken += 1;
  state.game.level = null;
  state.game.nextLevel = null;
  renderReady();
}

function compareCards(roundToken) {
  const first = state.game.firstCard;
  const second = state.game.secondCard;
  state.game.moves += 1;
  if (isGroupMode()) {
    const current = teamStat(state.group.activeTeamIndex);
    if (current) current.moves += 1;
  }
  updateGameHud();

  if (first.pairId === second.pairId) {
    window.setTimeout(() => {
      if (roundToken !== state.game.roundToken) return;
      first.matched = true;
      second.matched = true;
      state.game.matchedPairs += 1;
      if (isGroupMode()) {
        const current = teamStat(state.group.activeTeamIndex);
        if (current) current.matched_pairs += 1;
      }
      setCardVisual(first, true, true);
      setCardVisual(second, true, true);
      updateGameHud('تطابق رائع! أجب عن سؤال الزوج.');
      openQuestionForMatch(first);
    }, 420);
    return;
  }

  window.setTimeout(() => {
    if (roundToken !== state.game.roundToken) return;
    first.flipped = false;
    second.flipped = false;
    setCardVisual(first, false);
    setCardVisual(second, false);
    resetTurn();
    if (isGroupMode()) advanceTeam();
    updateGameHud(isGroupMode() ? `غير متطابقتين؛ الدور الآن: ${activeTeam()?.team_name || ''}.` : 'غير متطابقتين، حاول تذكّر موقعيهما.');
  }, 950);
}

function revealCard(uid) {
  if (state.game.locked) return;
  const card = state.game.deck.find((item) => item.uid === uid);
  if (!card || card.matched || card.flipped) return;
  card.flipped = true;
  setCardVisual(card, true);

  if (!state.game.firstCard) {
    state.game.firstCard = card;
    $('#gameMessage').textContent = 'اختر بطاقة ثانية.';
    return;
  }
  state.game.secondCard = card;
  state.game.locked = true;
  compareCards(state.game.roundToken);
}

function startLevel(level) {
  try {
    state.game.roundToken += 1;
    state.game.level = level;
    state.game.deck = buildDeck(level);
    state.game.firstCard = null;
    state.game.secondCard = null;
    state.game.locked = false;
    state.game.matchedPairs = 0;
    state.game.moves = 0;
    state.game.nextLevel = null;
    state.game.currentQuestion = null;
    state.game.selectedOption = '';
    state.game.correctAnswers = 0;
    state.game.wrongAnswers = 0;
    state.game.score = 0;
    state.group.activeTeamIndex = 0;
    state.group.questionTeamIndex = 0;
    state.group.questionAttempt = 1;
    state.group.awaitingSteal = false;
    state.game.advanceAfterQuestion = false;
    state.game.teamStats = isGroupMode() ? state.group.teams.map((team) => ({
      ...team, matched_pairs: 0, correct_answers: 0, wrong_answers: 0, score: 0, moves: 0
    })) : [];
    state.game.answerLog = [];
    state.game.levelStartedAt = Date.now();
    stopQuestionTimer();
    if ($('#questionDialog').open) $('#questionDialog').close();
    ensureLessonRunStarted();
    $('#gameLessonName').textContent = currentLesson()?.lesson_name || 'الدرس';
    $('#gameLevelName').textContent = level.level_name || 'المستوى';
    $('#sideLessonTitle').textContent = level.level_name || 'المستوى';
    $('#levelCompletePanel').hidden = true;
    renderBoard();
    updateGameHud(isGroupMode() ? `يبدأ الفريق: ${activeTeam()?.team_name || ''}. اكشف بطاقتين.` : 'اكشف بطاقتين للبحث عن صورة متطابقة.');
    showView('gameView');
  } catch (error) {
    $('#levelMessage').textContent = error.message || 'تعذر بدء هذا المستوى.';
  }
}

$('#studentForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  $('#formMessage').textContent = '';
  const values = Object.fromEntries(new FormData(event.currentTarget).entries());
  values.student_name = String(values.student_name || '').trim();
  values.class_name = String(values.class_name || '').trim();
  values.school_name = String(values.school_name || '').trim();
  if (values.student_name.length < 2) {
    $('#formMessage').textContent = 'اكتب اسم الطالب بصورة صحيحة.';
    return;
  }
  if (!values.class_name || !values.school_name) {
    $('#formMessage').textContent = 'أكمل بيانات الفصل والمدرسة.';
    return;
  }
  state.player = values;
  resetLessonRun(state.selectedLessonId);
  try {
    localStorage.setItem(PLAYER_STORAGE_KEY, JSON.stringify(values));
  } catch (_) {}

  const submitButton = $('#continueFormButton');
  submitButton.disabled = true;
  submitButton.textContent = 'جارٍ تجهيز الدروس…';
  try {
    await continueAfterLogin();
  } catch (error) {
    $('#formMessage').textContent = error.message || 'تعذر تجهيز الدروس. حاول مجددًا.';
  } finally {
    submitButton.disabled = false;
    submitButton.textContent = 'متابعة';
  }
});

document.querySelectorAll('input[name="game_mode"]').forEach((input) => input.addEventListener('change', () => {
  const group = document.querySelector('input[name="game_mode"]:checked')?.value === 'class';
  updatePlayerModeLabels(group);
}));

document.querySelectorAll('input[name="team_count"]').forEach((input) => input.addEventListener('change', () => {
  const existing = [...$('#teamNameFields').querySelectorAll('input[type="text"]')].map((field) => field.value.trim());
  state.group.teams = existing.map((teamName, index) => ({ team_id: `TEAM_${index + 1}`, team_name: teamName || `الفريق ${index + 1}` }));
  renderTeamNameFields(Number(input.value));
}));

$('#groupSetupForm').addEventListener('submit', (event) => {
  event.preventDefault();
  const count = Number(document.querySelector('input[name="team_count"]:checked')?.value || 2);
  const names = Array.from({ length: count }, (_, index) => String(event.currentTarget.elements[`team_name_${index + 1}`]?.value || '').trim());
  if (names.some((name) => name.length < 2)) {
    $('#groupSetupMessage').textContent = 'اكتب اسمًا واضحًا لكل فريق.';
    return;
  }
  if (new Set(names.map((name) => name.toLowerCase())).size !== names.length) {
    $('#groupSetupMessage').textContent = 'اجعل اسم كل فريق مختلفًا.';
    return;
  }
  state.group.teams = names.map((teamName, index) => ({ team_id: `TEAM_${index + 1}`, team_name: teamName }));
  state.group.stealEnabled = $('#questionStealEnabled').checked;
  restoreLessonRun(state.selectedLessonId);
  renderReady();
});

$('#backButton').addEventListener('click', () => showView('loginView'));
$('#backFromLessonsButton').addEventListener('click', () => showView('loginView'));
$('#changeLessonButton').addEventListener('click', renderLessonPicker);
$('#editTeamsButton').addEventListener('click', renderGroupSetup);
$('#openFeedbackButton').addEventListener('click', () => {
  $('#feedbackForm').reset();
  $('#feedbackStatus').textContent = '';
  $('#feedbackStatus').classList.remove('is-success');
  $('#feedbackDialog').showModal();
  window.setTimeout(() => $('#feedbackType').focus(), 0);
});
const closeFeedbackDialog = () => {
  if ($('#feedbackDialog').open) $('#feedbackDialog').close();
};
$('#closeFeedbackButton').addEventListener('click', closeFeedbackDialog);
$('#cancelFeedbackButton').addEventListener('click', closeFeedbackDialog);
$('#feedbackDialog').addEventListener('click', (event) => {
  if (event.target === $('#feedbackDialog')) closeFeedbackDialog();
});
$('#feedbackForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const noteText = String($('#feedbackText').value || '').trim();
  const status = $('#feedbackStatus');
  status.classList.remove('is-success');
  if (noteText.length < 3) {
    status.textContent = 'اكتب الرسالة بصورة أوضح قبل الإرسال.';
    $('#feedbackText').focus();
    return;
  }

  const sendButton = $('#sendFeedbackButton');
  sendButton.disabled = true;
  sendButton.textContent = 'جارٍ الإرسال…';
  status.textContent = '';
  try {
    await apiPost('save_note', {
      session_id: state.lessonRun.sessionId || '',
      student_name: state.player?.student_name || '',
      class_name: state.player?.class_name || '',
      lesson_id: state.selectedLessonId || DEFAULT_LESSON_ID,
      note_type: $('#feedbackType').value,
      note_text: noteText
    });
    status.textContent = 'تم إرسال رسالتك للمعلم بنجاح.';
    status.classList.add('is-success');
    $('#feedbackText').value = '';
    window.setTimeout(closeFeedbackDialog, 900);
  } catch (error) {
    status.textContent = error.message || 'تعذر إرسال الرسالة. تحقق من الإنترنت وحاول مرة أخرى.';
  } finally {
    sendButton.disabled = false;
    sendButton.textContent = 'إرسال للمعلم';
  }
});
$('#backFromGroupButton').addEventListener('click', () => {
  if (!DIRECT_LESSON_ID && getActiveLessons().length > 1) renderLessonPicker();
  else showView('loginView');
});
$('#lessonGrid').addEventListener('click', (event) => {
  const button = event.target.closest('[data-lesson-id]');
  if (button) selectLesson(button.dataset.lessonId);
});
$('#levelsGrid').addEventListener('click', (event) => {
  const button = event.target.closest('[data-level-id]');
  if (!button) return;
  const levels = (state.content.levels || []).filter((level) => isActive(level.active));
  const levelIndex = levels.findIndex((item, index) => levelKey(item, index) === button.dataset.levelId);
  const level = levels[levelIndex];
  if (!level) return;
  if (button.dataset.locked === 'true' || isLevelLocked(level, levelIndex, levels)) {
    $('#levelMessage').textContent = 'أكمل المستوى السابق أولًا لفتح هذا المستوى.';
    return;
  }
  startLevel(level);
});
$('#themeChoices').addEventListener('click', (event) => {
  const button = event.target.closest('[data-theme-id]');
  if (button) applyAppearance(button.dataset.themeId, state.appearance.displayModeId, 'theme');
});
$('#displayModeChoices').addEventListener('click', (event) => {
  const button = event.target.closest('[data-display-mode-id]');
  if (button) applyAppearance(state.appearance.themeId, button.dataset.displayModeId, 'mode');
});
$('#memoryGrid').addEventListener('click', (event) => {
  const button = event.target.closest('[data-card-uid]');
  if (button) revealCard(button.dataset.cardUid);
});
$('#questionOptions').addEventListener('click', (event) => {
  const button = event.target.closest('[data-option]');
  if (button) selectQuestionOption(button.dataset.option);
});
$('#submitAnswerButton').addEventListener('click', () => {
  if ($('#questionFeedback').hidden) submitQuestionAnswer(false);
  else if (state.group.awaitingSteal) beginStealAttempt();
  else finishMatchedPair();
});
$('#questionDialog').addEventListener('cancel', (event) => event.preventDefault());
$('#reviewFinalErrorsButton').addEventListener('click', renderFinalErrors);
$('#closeFinalErrorsButton').addEventListener('click', () => $('#finalErrorsDialog').close());
$('#restartLessonButton').addEventListener('click', beginNewRound);
$('#newRoundButton').addEventListener('click', beginNewRound);
$('#finalBackToLevelsButton').addEventListener('click', renderReady);
$('#restartLevelButton').addEventListener('click', () => {
  if (state.game.level) startLevel(state.game.level);
});
$('#playAgainButton').addEventListener('click', () => {
  if (state.game.level) startLevel(state.game.level);
});
$('#nextLevelButton').addEventListener('click', () => {
  if (state.game.nextLevel) startLevel(state.game.nextLevel);
});
$('#backToLevelsButton').addEventListener('click', () => {
  state.game.roundToken += 1;
  renderReady();
});
$('#retryButton').addEventListener('click', () => {
  if (state.pendingLessonId) selectLesson(state.pendingLessonId);
  else startApplication();
});
window.addEventListener('resize', () => window.requestAnimationFrame(fitBoardToViewport));
if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', () => window.requestAnimationFrame(fitBoardToViewport));
}

const restoredPlayer = restorePlayer();
document.querySelector('input[name="game_mode"]:checked')?.dispatchEvent(new Event('change'));
const resumeLessonId = restoredPlayer ? resumableLessonId() : '';

async function startApplication() {
  const canResume = resumeLessonId && (!DIRECT_LESSON_ID || DIRECT_LESSON_ID === resumeLessonId);
  if (canResume) state.selectedLessonId = resumeLessonId;

  state.pendingLessonId = '';
  $('#loadingMessage').textContent = canResume ? 'جارٍ استعادة تقدمك…' : 'جارٍ تجهيز المظهر والدرس…';
  $('#retryButton').hidden = true;
  showView('loadingView');
  setContentLoading();

  const revealLoadedApplication = async () => {
    document.body.classList.remove('booting');
    if (canResume) {
      await selectLesson(resumeLessonId);
      if (isGroupMode()) {
        restoreLessonRun(resumeLessonId);
        renderReady();
      }
    } else {
      showView('loginView');
    }
  };

  const cached = readCachedContent(state.selectedLessonId);
  if (cached) {
    applyContent(cached, state.selectedLessonId, true);
    await revealLoadedApplication();
    beginInitialLoad().catch(() => {});
    return;
  }

  try {
    await beginInitialLoad();
    await revealLoadedApplication();
  } catch (error) {
    $('#loadingMessage').textContent = error.message || 'تعذر تجهيز الدرس. تحقق من الإنترنت.';
    $('#retryButton').hidden = false;
  }
}

startApplication();
