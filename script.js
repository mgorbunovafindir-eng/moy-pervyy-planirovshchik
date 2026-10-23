"use strict";

// Pure calendar and task logic. Kept independent from the DOM for reproducible checks.
const PlannerCore = (() => {
  const MIN_DATE = "1900-01-01", MAX_DATE = "2100-12-31", STORAGE_KEY = "personalPlanner.v1";
  const pad = value => String(value).padStart(2, "0");
  const keyFromUTC = value => `${value.getUTCFullYear()}-${pad(value.getUTCMonth() + 1)}-${pad(value.getUTCDate())}`;
  function validDate(value) {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value < MIN_DATE || value > MAX_DATE) return false;
    const [y, m, d] = value.split("-").map(Number);
    return keyFromUTC(new Date(Date.UTC(y, m - 1, d))) === value;
  }
  function dateUTC(value) { const [y, m, d] = value.split("-").map(Number); return new Date(Date.UTC(y, m - 1, d)); }
  function todayKey(now = new Date()) { return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`; }
  function addDays(value, amount) { const date = dateUTC(value); date.setUTCDate(date.getUTCDate() + amount); return keyFromUTC(date); }
  function addMonths(value, amount) {
    const date = dateUTC(value), day = date.getUTCDate();
    date.setUTCDate(1); date.setUTCMonth(date.getUTCMonth() + amount);
    const last = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
    date.setUTCDate(Math.min(day, last)); return keyFromUTC(date);
  }
  function weekStart(value) { return addDays(value, -((dateUTC(value).getUTCDay() + 6) % 7)); }
  function monthDays(value) {
    const first = value.slice(0, 8) + "01", start = weekStart(first);
    const date = dateUTC(first), last = keyFromUTC(new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)));
    const days = []; let current = start;
    do { days.push(current); current = addDays(current, 1); } while (current <= last || days.length % 7 !== 0);
    return days;
  }
  function formatDate(value, options) { return new Intl.DateTimeFormat("ru-RU", { ...options, timeZone: "UTC" }).format(dateUTC(value)); }
  const minutes = value => { const [h, m] = value.split(":").map(Number); return h * 60 + m; };
  const validTime = value => typeof value === "string" && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
  function inputErrors(input, today, original = null) {
    const errors = {}, title = typeof input.title === "string" ? input.title.trim() : "";
    if (!title) errors.title = "Введите название задачи";
    else if (title.length > 200 || /[\r\n]/.test(title)) errors.title = "Название — одна строка, не более 200 символов";
    if (typeof input.note !== "string" || input.note.length > 2000) errors.note = "Заметка — не более 2000 символов";
    if (!validDate(input.date)) errors.date = "Выберите корректную дату с 1900 по 2100 год";
    else if (!(original && original.status === "done") && input.date < today) errors.date = "Добавлять и переносить задачи можно на сегодня и будущие даты";
    if (input.startTime !== null || input.endTime !== null) {
      if (!validTime(input.startTime) || !validTime(input.endTime)) errors.time = "Укажите начало и окончание в формате ЧЧ:ММ";
      else if (input.endTime <= input.startTime) errors.time = "Окончание должно быть позже начала в пределах одного дня";
    }
    if (original && original.status === "done" && (input.date !== original.date || input.startTime !== original.startTime || input.endTime !== original.endTime)) errors.date = "Чтобы изменить дату или время, сначала верните задачу в работу";
    return errors;
  }
  function emptyState(now = new Date()) { return { schemaVersion: 1, revision: 0, updatedAt: now.toISOString(), lastReconciledDate: todayKey(now), settings: { showFullDay: false, completedExpanded: true }, tasks: [], series: [], occurrenceExceptions: [] }; }
  const record = value => value !== null && typeof value === "object" && !Array.isArray(value);
  const timestamp = value => typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value.replace(/Z$/, value.includes(".") ? "Z" : ".000Z");
  function validBaseState(data) {
    if (!record(data) || data.schemaVersion !== 1 || !Number.isSafeInteger(data.revision) || data.revision < 0 || !validDate(data.lastReconciledDate) || !timestamp(data.updatedAt) || !record(data.settings) || typeof data.settings.showFullDay !== "boolean" || typeof data.settings.completedExpanded !== "boolean" || !Array.isArray(data.tasks) || !Array.isArray(data.series) || !Array.isArray(data.occurrenceExceptions)) return false;
    const ids = new Set();
    return data.tasks.every(task => {
      if (!task || typeof task.id !== "string" || !task.id || ids.has(task.id)) return false;
      ids.add(task.id);
      return typeof task.title === "string" && !!task.title.trim() && task.title.length <= 200 && !/[\r\n]/.test(task.title) && typeof task.note === "string" && task.note.length <= 2000 && validDate(task.date) && validDate(task.originalDate) && ["todo", "done", "merged"].includes(task.status) && Number.isInteger(task.order) && task.order >= 0 && typeof task.autoMoved === "boolean" && (task.lastAutoMovedTo === null || validDate(task.lastAutoMovedTo)) && Number.isFinite(Date.parse(task.createdAt)) && Number.isFinite(Date.parse(task.updatedAt)) && (task.status === "done" ? Number.isFinite(Date.parse(task.completedAt)) : task.completedAt === null) && ((task.startTime === null && task.endTime === null) || (validTime(task.startTime) && validTime(task.endTime) && task.startTime < task.endTime)) && ((task.seriesId === null && task.occurrenceDate === null) || (typeof task.seriesId === "string" && validDate(task.occurrenceDate))) && (task.mergedIntoId === null || typeof task.mergedIntoId === "string");
    });
  }
  const clone = data => JSON.parse(JSON.stringify(data));
  const compareBase = (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
  const compareUntimed = (a, b) => a.order - b.order || compareBase(a, b);
  const compareTimed = (a, b) => a.startTime.localeCompare(b.startTime) || a.endTime.localeCompare(b.endTime) || compareBase(a, b);
  function storedTasksForDay(data, date) {
    const tasks = data.tasks.filter(task => task.date === date && task.status !== "merged");
    return { untimed: tasks.filter(t => t.status === "todo" && t.startTime === null).sort(compareUntimed), timed: tasks.filter(t => t.status === "todo" && t.startTime !== null).sort(compareTimed), done: tasks.filter(t => t.status === "done").sort((a,b) => b.completedAt.localeCompare(a.completedAt) || compareBase(a,b)) };
  }
  function dayPlan(daily) {
    return { untimed: [...daily.untimed, ...daily.done.filter(t => t.startTime === null)].sort(compareUntimed), timed: [...daily.timed, ...daily.done.filter(t => t.startTime !== null)].sort(compareTimed) };
  }
  function nextOrder(data, date) { return Math.max(-1, ...data.tasks.filter(t => t.date === date && t.status !== "merged" && t.startTime === null).map(t => t.order)) + 1; }
  function saveOrdinaryTask(data, input, id, now = new Date()) {
    const old = id ? data.tasks.find(task => task.id === id) : null;
    if (id && !old) throw new Error("Задача больше не существует");
    const errors = inputErrors(input, todayKey(now), old);
    if (Object.keys(errors).length) return { errors };
    const next = clone(data), timestamp = now.toISOString();
    if (old) {
      const task = next.tasks.find(t => t.id === id), moved = task.date !== input.date, timeChanged = task.startTime !== input.startTime || task.endTime !== input.endTime;
      if ((moved || task.startTime !== null) && input.startTime === null) task.order = nextOrder(next, input.date);
      Object.assign(task, { title: input.title.trim(), note: input.note, date: input.date, startTime: input.startTime, endTime: input.endTime, updatedAt: timestamp });
      if (moved || timeChanged) { task.autoMoved = false; task.lastAutoMovedTo = null; }
    } else {
      const taskId = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
      next.tasks.push({ id: taskId, title: input.title.trim(), note: input.note, date: input.date, originalDate: input.date, startTime: input.startTime, endTime: input.endTime, status: "todo", order: nextOrder(next, input.date), createdAt: timestamp, updatedAt: timestamp, completedAt: null, autoMoved: false, lastAutoMovedTo: null, seriesId: null, occurrenceDate: null, mergedIntoId: null });
    }
    return { data: next };
  }
  function toggleOrdinaryTask(data, id, now = new Date()) {
    const next = clone(data), task = next.tasks.find(t => t.id === id);
    if (!task || task.status === "merged") throw new Error("Задача больше не существует");
    if (task.status === "todo") { task.status = "done"; task.completedAt = now.toISOString(); task.autoMoved = false; task.lastAutoMovedTo = null; }
    else {
      task.status = "todo"; task.completedAt = null;
      if (task.date < todayKey(now)) { task.date = todayKey(now); task.startTime = null; task.endTime = null; task.autoMoved = true; task.lastAutoMovedTo = task.date; task.order = nextOrder(data, task.date); }
    }
    task.updatedAt = now.toISOString(); return next;
  }
  function uniqueId() { return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`; }
  const occurrenceId = (seriesId, date) => `occ:${seriesId}:${date}`;
  const exceptionFor = (data, seriesId, date) => data.occurrenceExceptions.find(e => e.seriesId === seriesId && e.occurrenceDate === date);
  function putException(data, seriesId, date, type, targetId = null) {
    const entry = { seriesId, occurrenceDate: date, type };
    if (type === "override") entry.taskId = targetId;
    if (type === "merged") entry.mergedIntoId = targetId;
    const index = data.occurrenceExceptions.findIndex(e => e.seriesId === seriesId && e.occurrenceDate === date);
    if (index < 0) data.occurrenceExceptions.push(entry); else data.occurrenceExceptions[index] = entry;
  }
  function occurrenceOnOrAfter(series, from) {
    let date = from > series.startDate ? from : series.startDate;
    if (!validDate(date)) return null;
    if (series.kind === "weekdays") {
      const weekday = dateUTC(date).getUTCDay();
      if (weekday === 6) date = addDays(date, 2); else if (weekday === 0) date = addDays(date, 1);
    } else if (series.kind === "weekly") {
      const weekday = dateUTC(date).getUTCDay();
      date = addDays(date, (series.anchorWeekday - weekday + 7) % 7);
    } else {
      const [year, month] = date.split("-").map(Number);
      const inMonth = (y, m) => keyFromUTC(new Date(Date.UTC(y, m - 1, Math.min(series.anchorDay, new Date(Date.UTC(y, m, 0)).getUTCDate()))));
      let candidate = inMonth(year, month);
      if (candidate < date) { const next = dateUTC(addMonths(date.slice(0, 8) + "01", 1)); candidate = inMonth(next.getUTCFullYear(), next.getUTCMonth() + 1); }
      date = candidate;
    }
    return validDate(date) && (!series.stopBeforeDate || date < series.stopBeforeDate) ? date : null;
  }
  function nextOccurrence(series, date) { return date >= MAX_DATE ? null : occurrenceOnOrAfter(series, addDays(date, 1)); }
  function templateAt(series, date) { return [...series.templateVersions].reverse().find(v => v.effectiveFrom <= date); }
  function occurrenceTask(data, series, date, index = null) {
    const template = templateAt(series, date);
    return { id: occurrenceId(series.id, date), title: template.title, note: template.note, date, originalDate: date, startTime: template.startTime, endTime: template.endTime, status: "todo", order: index ? (index.orders.get(date) ?? -1) + 1 : nextOrder(data, date), createdAt: series.createdAt, updatedAt: series.updatedAt, completedAt: null, autoMoved: false, lastAutoMovedTo: null, seriesId: series.id, occurrenceDate: date, mergedIntoId: null };
  }
  function virtualTask(data, series, date, index = null) {
    const key = `${series.id}/${date}`;
    if (!series.nextOccurrenceDate || date < series.nextOccurrenceDate || occurrenceOnOrAfter(series, date) !== date || (index ? index.occurrences.has(key) : exceptionFor(data, series.id, date) || data.tasks.some(t => t.seriesId === series.id && t.occurrenceDate === date))) return null;
    return { ...occurrenceTask(data, series, date, index), isVirtual: true };
  }
  function getTask(data, id) {
    const stored = data.tasks.find(task => task.id === id);
    if (stored) return stored;
    const match = /^occ:([^:]+):(\d{4}-\d{2}-\d{2})$/.exec(id || "");
    if (!match) return null;
    const series = data.series.find(item => item.id === match[1]);
    return series && validDate(match[2]) ? virtualTask(data, series, match[2]) : null;
  }
  function materialize(data, id) {
    const stored = data.tasks.find(task => task.id === id);
    if (stored) return stored;
    const task = getTask(data, id);
    if (!task) throw new Error("Задача уже изменена или объединена. Ваш текст остаётся в форме; откройте актуальную задачу после закрытия формы.");
    delete task.isVirtual; data.tasks.push(task); putException(data, task.seriesId, task.occurrenceDate, "override", task.id); return task;
  }
  function dayIndex(data) {
    const days = new Map(), orders = new Map(), occurrences = new Set();
    for (const task of data.tasks) {
      if (!days.has(task.date)) days.set(task.date, []); days.get(task.date).push(task);
      if (task.status !== "merged" && task.startTime === null) orders.set(task.date, Math.max(orders.get(task.date) ?? -1, task.order));
      if (task.seriesId) occurrences.add(`${task.seriesId}/${task.occurrenceDate}`);
    }
    for (const entry of data.occurrenceExceptions) occurrences.add(`${entry.seriesId}/${entry.occurrenceDate}`);
    return { days, orders, occurrences };
  }
  function tasksForDay(data, date, index = null) {
    const tasks = [...(index ? index.days.get(date) || [] : data.tasks.filter(t => t.date === date))];
    for (const series of data.series) { const task = virtualTask(data, series, date, index); if (task) tasks.push(task); }
    return storedTasksForDay({ ...data, tasks }, date);
  }
  function mergeInto(data, source, target, timestamp) {
    if (source.id === target.id) return;
    source.status = "merged"; source.completedAt = null; source.mergedIntoId = target.id; source.updatedAt = timestamp;
    putException(data, source.seriesId, source.occurrenceDate, "merged", target.id);
    for (const task of data.tasks) if (task.mergedIntoId === source.id) task.mergedIntoId = target.id;
    for (const entry of data.occurrenceExceptions) if (entry.type === "merged" && entry.mergedIntoId === source.id) entry.mergedIntoId = target.id;
  }
  function consolidate(data, today, timestamp, preferredId = null) {
    for (const series of data.series) {
      const open = data.tasks.filter(t => t.seriesId === series.id && t.status === "todo" && t.occurrenceDate <= today).sort((a, b) => a.occurrenceDate.localeCompare(b.occurrenceDate) || compareBase(a, b));
      if (open.length < 2) continue;
      const target = open.find(t => t.id === preferredId) || open[0];
      for (const source of open) if (source !== target) mergeInto(data, source, target, timestamp);
    }
  }
  function reconcile(data, now = new Date(), preferredId = null) {
    const next = clone(data), today = todayKey(now), timestamp = now.toISOString();
    if (!validDate(today)) return next;
    const storedOccurrences = new Map(next.tasks.filter(t => t.seriesId).map(t => [`${t.seriesId}/${t.occurrenceDate}`, t]));
    const exceptions = new Set(next.occurrenceExceptions.map(e => `${e.seriesId}/${e.occurrenceDate}`)), firstOpen = new Map();
    for (const task of next.tasks) if (task.seriesId && task.status === "todo" && (!firstOpen.has(task.seriesId) || task.occurrenceDate < firstOpen.get(task.seriesId))) firstOpen.set(task.seriesId, task.occurrenceDate);
    for (const series of next.series) {
      let date = series.nextOccurrenceDate;
      if (date && occurrenceOnOrAfter(series, date) !== date) date = occurrenceOnOrAfter(series, date);
      while (date && date <= today) {
        // Once an open execution is due, all later missed dates are absorbed by it.
        // Stored overrides are consolidated below; no intermediate task generation is needed.
        if (firstOpen.has(series.id) && firstOpen.get(series.id) <= date) { date = today >= MAX_DATE ? null : occurrenceOnOrAfter(series, addDays(today, 1)); break; }
        const key = `${series.id}/${date}`, stored = storedOccurrences.get(key), exception = exceptions.has(key);
        if (!stored && !exception) {
          const task = occurrenceTask(next, series, date); next.tasks.push(task); putException(next, series.id, date, "override", task.id); firstOpen.set(series.id, date);
        }
        date = nextOccurrence(series, date);
      }
      series.nextOccurrenceDate = date;
    }
    consolidate(next, today, timestamp, preferredId);
    const overdue = next.tasks.filter(t => t.status === "todo" && t.date < today).sort((a, b) => a.date.localeCompare(b.date) || compareUntimed(a, b));
    for (const task of overdue) {
      task.order = nextOrder(next, today); task.date = today; task.startTime = null; task.endTime = null; task.autoMoved = true; task.lastAutoMovedTo = today; task.updatedAt = timestamp;
    }
    if (today > next.lastReconciledDate) next.lastReconciledDate = today;
    return next;
  }
  function saveTask(data, input, id, now = new Date(), scope = "single") {
    const old = id ? getTask(data, id) : null;
    if (id && (!old || old.status === "merged")) return { errors: { form: "Задача уже изменена или объединена. Введённый текст сохранён в форме; откройте актуальную задачу." } };
    const errors = inputErrors(input, todayKey(now), old);
    const repeatKind = input.repeatKind || "none";
    if (!["none", "weekdays", "weekly", "monthly"].includes(repeatKind)) errors.repeat = "Выберите правило повторения";
    if (old?.status === "done" && !old.seriesId && repeatKind !== "none") errors.repeat = "Чтобы включить повторение, сначала верните задачу в работу";
    if (old?.seriesId && scope === "future" && input.date !== old.date) errors.date = "Для переноса даты выберите «Только эта задача»";
    if (Object.keys(errors).length) return { errors };
    if ((!old || (!old.seriesId && old.status === "todo")) && repeatKind !== "none") {
      const next = old ? saveOrdinaryTask(data, input, id, now).data : clone(data), timestamp = now.toISOString();
      let startDate = input.date;
      if (repeatKind === "weekdays") { const weekday = dateUTC(startDate).getUTCDay(); if (weekday === 6) startDate = addDays(startDate, 2); else if (weekday === 0) startDate = addDays(startDate, 1); }
      if (!validDate(startDate)) return { errors: { date: "Первое выполнение выходит за поддерживаемый диапазон дат" } };
      const series = { id: uniqueId(), kind: repeatKind, startDate, anchorWeekday: repeatKind === "weekly" ? dateUTC(startDate).getUTCDay() : null, anchorDay: repeatKind === "monthly" ? Number(startDate.slice(8)) : null, stopBeforeDate: null, nextOccurrenceDate: startDate, createdAt: timestamp, updatedAt: timestamp, templateVersions: [{ effectiveFrom: startDate, title: input.title.trim(), note: input.note, startTime: input.startTime, endTime: input.endTime }] };
      next.series.push(series);
      if (old) {
        // A stopped recipient may still own absorbed occurrences from its old series.
        // Keep their tombstones, but detach those links before joining a new series.
        removeStored(next, next.tasks.filter(t => t.status === "merged" && t.mergedIntoId === id).map(t => t.id));
        for (const entry of next.occurrenceExceptions) if (entry.type === "merged" && entry.mergedIntoId === id) {
          entry.type = "deleted"; delete entry.mergedIntoId;
        }
        const task = next.tasks.find(item => item.id === id);
        if (task.date !== startDate) { if (task.startTime === null) task.order = nextOrder(next, startDate); task.date = startDate; task.autoMoved = false; task.lastAutoMovedTo = null; }
        task.seriesId = series.id; task.occurrenceDate = startDate;
        putException(next, series.id, startDate, "override", task.id);
      }
      return { data: reconcile(next, now) };
    }
    if (!old?.seriesId) return saveOrdinaryTask(data, input, id, now);
    let next = clone(data); materialize(next, id);
    if (scope === "future" && old.status !== "done") {
      const series = next.series.find(s => s.id === old.seriesId), timestamp = now.toISOString();
      series.templateVersions = series.templateVersions.filter(v => v.effectiveFrom < old.occurrenceDate);
      series.templateVersions.push({ effectiveFrom: old.occurrenceDate, title: input.title.trim(), note: input.note, startTime: input.startTime, endTime: input.endTime }); series.updatedAt = timestamp;
      for (const task of next.tasks.filter(t => t.seriesId === series.id && t.occurrenceDate >= old.occurrenceDate && t.status === "todo")) {
        const timeChanged = task.startTime !== input.startTime || task.endTime !== input.endTime;
        if (task.startTime !== null && input.startTime === null) task.order = nextOrder(next, task.date);
        Object.assign(task, { title: input.title.trim(), note: input.note, startTime: input.startTime, endTime: input.endTime, updatedAt: timestamp });
        if (timeChanged) { task.autoMoved = false; task.lastAutoMovedTo = null; }
      }
    } else { const result = saveOrdinaryTask(next, input, id, now); if (!result.data) return result; next = result.data; }
    return { data: reconcile(next, now) };
  }
  function toggleTask(data, id, now = new Date()) {
    const prepared = reconcile(data, now); materialize(prepared, id);
    return reconcile(toggleOrdinaryTask(prepared, id, now), now, id);
  }
  function removeStored(data, ids) {
    const removed = new Set(ids); let expanded;
    do { expanded = false; for (const task of data.tasks) if (task.status === "merged" && removed.has(task.mergedIntoId) && !removed.has(task.id)) { removed.add(task.id); expanded = true; } } while (expanded);
    for (const task of data.tasks) if (removed.has(task.id) && task.seriesId) putException(data, task.seriesId, task.occurrenceDate, "deleted");
    for (const entry of data.occurrenceExceptions) if (entry.type === "merged" && removed.has(entry.mergedIntoId)) { entry.type = "deleted"; delete entry.mergedIntoId; }
    data.tasks = data.tasks.filter(t => !removed.has(t.id));
  }
  function stopFrom(series, date, now) {
    series.stopBeforeDate = series.stopBeforeDate && series.stopBeforeDate < date ? series.stopBeforeDate : date;
    if (series.nextOccurrenceDate && series.nextOccurrenceDate >= series.stopBeforeDate) series.nextOccurrenceDate = null;
    series.updatedAt = now.toISOString();
  }
  function removeTask(data, id, scope = "single", now = new Date()) {
    const next = clone(data), task = getTask(next, id);
    if (!task) throw new Error("Задача больше не существует");
    const ids = [id];
    if (task.seriesId) {
      putException(next, task.seriesId, task.occurrenceDate, "deleted");
      if (scope === "future") {
        const series = next.series.find(s => s.id === task.seriesId); stopFrom(series, task.occurrenceDate, now);
        ids.push(...next.tasks.filter(t => t.seriesId === task.seriesId && t.status === "todo" && t.occurrenceDate >= task.occurrenceDate).map(t => t.id));
      }
    }
    removeStored(next, ids); return reconcile(next, now);
  }
  function stopSeries(data, id, now = new Date()) {
    const next = clone(data), task = materialize(next, id);
    if (!task.seriesId || task.status !== "todo") throw new Error("Повторение этой задачи уже прекращено");
    const seriesId = task.seriesId, date = task.occurrenceDate;
    stopFrom(next.series.find(s => s.id === seriesId), date, now);
    removeStored(next, next.tasks.filter(t => t.seriesId === seriesId && t.status === "todo" && t.occurrenceDate >= date && t.id !== task.id).map(t => t.id));
    putException(next, seriesId, date, "deleted"); task.seriesId = null; task.occurrenceDate = null; task.updatedAt = now.toISOString();
    return reconcile(next, now);
  }
  function moveTask(data, id, date, now = new Date()) {
    if (!validDate(date) || date < todayKey(now)) throw new Error("Нельзя перенести задачу на прошедшую или некорректную дату");
    const next = reconcile(data, now), source = getTask(next, id);
    if (!source) throw new Error("Задача больше не существует");
    if (source.status !== "todo") throw new Error("Переносить можно только незавершённую задачу");
    if (source.date === date) return next;
    const task = materialize(next, id);
    task.date = date; if (task.startTime === null) task.order = nextOrder(next, date);
    task.autoMoved = false; task.lastAutoMovedTo = null; task.updatedAt = now.toISOString(); return reconcile(next, now);
  }
  function shiftTaskTime(data, id, start, now = new Date()) {
    const next = reconcile(data, now), task = getTask(next, id);
    if (!task || task.status !== "todo" || task.startTime === null || task.date < todayKey(now)) throw new Error("Перемещать по времени можно только незавершённую задачу с интервалом на сегодня или будущую дату");
    const duration = minutes(task.endTime) - minutes(task.startTime);
    if (!Number.isInteger(start) || start % 10 !== 0 || start < 0 || start + duration > 1439) throw new Error("Выберите время с шагом 10 минут в пределах одного дня");
    if (start === minutes(task.startTime)) return next;
    const time = value => `${pad(Math.floor(value / 60))}:${pad(value % 60)}`;
    const result = saveTask(next, { title: task.title, note: task.note, date: task.date, startTime: time(start), endTime: time(start + duration) }, id, now, "single");
    if (!result.data) throw new Error(Object.values(result.errors).join(". "));
    return result.data;
  }
  function reorderTask(data, id, targetId, before = true, now = new Date()) {
    const next = reconcile(data, now), task = getTask(next, id), target = getTask(next, targetId);
    if (!task || !target || task.status !== "todo" || !["todo", "done"].includes(target.status) || task.startTime !== null || target.startTime !== null || task.date !== target.date) throw new Error("Порядок можно менять только у задач без времени одного дня");
    const list = dayPlan(tasksForDay(next, task.date)).untimed;
    // Materialize visible future occurrences so the manually selected order stays stable.
    for (const item of list) materialize(next, item.id);
    const ordered = list.map(item => item.id).filter(itemId => itemId !== id);
    let at = ordered.indexOf(targetId); if (at < 0) return next;
    if (!before) at++; ordered.splice(at, 0, id);
    ordered.forEach((itemId, index) => { const item = next.tasks.find(t => t.id === itemId); item.order = index; item.updatedAt = now.toISOString(); }); return next;
  }
  function shiftTask(data, id, direction, now = new Date()) {
    const task = getTask(data, id); if (!task) throw new Error("Задача больше не существует");
    const list = dayPlan(tasksForDay(data, task.date)).untimed, index = list.findIndex(t => t.id === id), target = list[index + direction];
    return target ? reorderTask(data, id, target.id, direction < 0, now) : clone(data);
  }
  function seriesImpact(data, id) {
    const task = getTask(data, id);
    if (!task?.seriesId) return { otherOpen: 0, overrides: 0 };
    const series = data.series.find(s => s.id === task.seriesId);
    const affected = data.tasks.filter(t => t.seriesId === task.seriesId && t.status === "todo" && t.occurrenceDate >= task.occurrenceDate);
    return { otherOpen: affected.filter(t => t.id !== id).length, overrides: affected.filter(t => { const v = templateAt(series, t.occurrenceDate); return ["title", "note", "startTime", "endTime"].some(field => t[field] !== v[field]); }).length };
  }
  function validState(data) {
    if (!validBaseState(data)) return false;
    const seriesIds = new Set(), keys = new Set(), taskIds = new Map(data.tasks.map(t => [t.id, t]));
    for (const series of data.series) {
      if (!record(series) || typeof series.id !== "string" || !series.id || series.id.includes(":") || seriesIds.has(series.id) || taskIds.has(series.id) || !["weekdays", "weekly", "monthly"].includes(series.kind) || !validDate(series.startDate) || (series.stopBeforeDate !== null && (!validDate(series.stopBeforeDate) || series.stopBeforeDate < series.startDate)) || (series.nextOccurrenceDate !== null && (!validDate(series.nextOccurrenceDate) || occurrenceOnOrAfter(series, series.nextOccurrenceDate) !== series.nextOccurrenceDate)) || !timestamp(series.createdAt) || !timestamp(series.updatedAt) || !Array.isArray(series.templateVersions) || !series.templateVersions.length) return false;
      if (series.kind === "weekly" ? !Number.isInteger(series.anchorWeekday) || series.anchorWeekday < 0 || series.anchorWeekday > 6 || series.anchorDay !== null : series.kind === "monthly" ? !Number.isInteger(series.anchorDay) || series.anchorDay < 1 || series.anchorDay > 31 || series.anchorWeekday !== null : series.anchorDay !== null || series.anchorWeekday !== null) return false;
      let previous = "";
      for (const version of series.templateVersions) {
        if (!version || !validDate(version.effectiveFrom) || version.effectiveFrom <= previous || Object.keys(inputErrors({ ...version, date: version.effectiveFrom }, MIN_DATE)).length) return false;
        previous = version.effectiveFrom;
      }
      if (series.templateVersions[0].effectiveFrom !== series.startDate || occurrenceOnOrAfter({ ...series, stopBeforeDate: null }, series.startDate) !== series.startDate) return false;
      if (series.nextOccurrenceDate === null && data.lastReconciledDate < MAX_DATE && occurrenceOnOrAfter(series, addDays(data.lastReconciledDate, 1)) !== null) return false;
      seriesIds.add(series.id);
    }
    for (const task of data.tasks) {
      if (task.seriesId !== null) { const key = `${task.seriesId}/${task.occurrenceDate}`; if (!seriesIds.has(task.seriesId) || keys.has(key)) return false; keys.add(key); }
      if (!timestamp(task.createdAt) || !timestamp(task.updatedAt) || (task.completedAt !== null && !timestamp(task.completedAt)) || !Number.isSafeInteger(task.order)) return false;
      if (task.status === "merged") { const target = taskIds.get(task.mergedIntoId); if (!task.seriesId || !target || target.status === "merged" || target.id === task.id || (target.seriesId !== null && target.seriesId !== task.seriesId)) return false; }
      else if (task.mergedIntoId !== null) return false;
    }
    const exceptionKeys = new Set();
    for (const entry of data.occurrenceExceptions) {
      if (!record(entry)) return false;
      const key = `${entry.seriesId}/${entry.occurrenceDate}`;
      if (!seriesIds.has(entry.seriesId) || !validDate(entry.occurrenceDate) || exceptionKeys.has(key) || !["override", "deleted", "merged"].includes(entry.type)) return false;
      exceptionKeys.add(key);
      if (entry.type === "override") { const task = taskIds.get(entry.taskId); if (!task || task.seriesId !== entry.seriesId || task.occurrenceDate !== entry.occurrenceDate || task.status === "merged") return false; }
      if (entry.type === "merged") { const task = taskIds.get(entry.mergedIntoId); if (!task || task.status === "merged" || (task.seriesId !== null && task.seriesId !== entry.seriesId)) return false; }
    }
    const seriesMap = new Map(data.series.map(s => [s.id, s])), exceptions = new Map(data.occurrenceExceptions.map(e => [`${e.seriesId}/${e.occurrenceDate}`, e]));
    // Stored IDs must not impersonate an execution that can still be projected.
    // Materialized/stopped occurrences legitimately retain the same ID prefix.
    for (const task of data.tasks) {
      const match = /^occ:([^:]+):(\d{4}-\d{2}-\d{2})$/.exec(task.id);
      if (!match) continue;
      const owner = seriesMap.get(match[1]), date = match[2], key = `${match[1]}/${date}`;
      if (owner?.nextOccurrenceDate && validDate(date) && date >= owner.nextOccurrenceDate && !keys.has(key) && !exceptionKeys.has(key) && occurrenceOnOrAfter(owner, date) === date) return false;
    }
    for (const item of [...data.tasks.filter(t => t.seriesId), ...data.occurrenceExceptions]) {
      const series = seriesMap.get(item.seriesId);
      if (occurrenceOnOrAfter({ ...series, stopBeforeDate: null }, item.occurrenceDate) !== item.occurrenceDate) return false;
    }
    for (const task of data.tasks.filter(t => t.seriesId)) {
      const entry = exceptions.get(`${task.seriesId}/${task.occurrenceDate}`);
      if (!entry || (task.status === "merged" ? entry.type !== "merged" || entry.mergedIntoId !== task.mergedIntoId : entry.type !== "override" || entry.taskId !== task.id)) return false;
    }
    return true;
  }
  // Whitelisting also prevents unknown imported fields from becoming application state.
  function cleanState(data) {
    const pick = (object, fields) => Object.fromEntries(fields.split(" ").map(key => [key, object[key]]));
    return { ...pick(data, "schemaVersion revision updatedAt lastReconciledDate"), settings: pick(data.settings, "showFullDay completedExpanded"),
      tasks: data.tasks.map(t => pick(t, "id title note date originalDate startTime endTime status order createdAt updatedAt completedAt autoMoved lastAutoMovedTo seriesId occurrenceDate mergedIntoId")),
      series: data.series.map(s => ({ ...pick(s, "id kind startDate anchorWeekday anchorDay stopBeforeDate nextOccurrenceDate createdAt updatedAt"), templateVersions: s.templateVersions.map(v => pick(v, "effectiveFrom title note startTime endTime")) })),
      occurrenceExceptions: data.occurrenceExceptions.map(e => pick(e, `seriesId occurrenceDate type${e.type === "override" ? " taskId" : e.type === "merged" ? " mergedIntoId" : ""}`)) };
  }
  function backupPayload(data, now = new Date()) {
    if (!validState(data)) throw new Error("Нельзя выгрузить некорректное состояние");
    return { format: "personal-planner-backup", schemaVersion: 1, exportedAt: now.toISOString(), data: cleanState(reconcile(data, now)) };
  }
  function parseBackup(text) {
    let value; try { value = JSON.parse(text); } catch { throw new Error("Файл не содержит корректный JSON"); }
    if (!record(value) || value.format !== "personal-planner-backup" || value.schemaVersion !== 1 || !timestamp(value.exportedAt)) throw new Error("Формат или версия резервной копии не поддерживается");
    if (!validState(value.data)) throw new Error("Резервная копия повреждена: проверьте поля, даты, интервалы, уникальность ID и ссылки");
    return { exportedAt: value.exportedAt, data: cleanState(value.data) };
  }
  function prepareRestore(imported, revision, now = new Date()) {
    const next = reconcile(cleanState(imported), now); next.revision = Math.max(revision, imported.revision) + 1; next.updatedAt = now.toISOString();
    if (!validState(next)) throw new Error("Не удалось подготовить корректные данные для восстановления");
    return next;
  }
  function layoutIntervals(tasks, minimumMinutes = 0, dayEnd = 1440) {
    // The true interval stays unchanged; reserve a separate footprint for short controls.
    const sorted = tasks.map(task => {
      const start = minutes(task.startTime), end = minutes(task.endTime);
      const labelStart = Math.min(start, dayEnd - Math.max(end - start, minimumMinutes));
      return { task, labelStart, end: Math.max(end, labelStart + minimumMinutes) };
    }).sort((a, b) => a.labelStart - b.labelStart || compareTimed(a.task, b.task)), result = []; let group = [], end = -1;
    function flush() {
      if (!group.length) return;
      const columns = []; let maxColumns = 0;
      for (const item of group) {
        let column = columns.findIndex(until => until <= item.labelStart);
        if (column < 0) column = columns.length;
        columns[column] = item.end; maxColumns = Math.max(maxColumns, columns.length);
        result.push({ task: item.task, column, columns: 0, ...(minimumMinutes ? { labelStart: item.labelStart } : {}) });
      }
      for (let i = result.length - group.length; i < result.length; i++) result[i].columns = maxColumns;
      group = []; end = -1;
    }
    for (const item of sorted) { if (item.labelStart >= end) flush(); group.push(item); end = Math.max(end, item.end); }
    flush(); return result.sort((a, b) => compareTimed(a.task, b.task));
  }
  return { MIN_DATE, MAX_DATE, STORAGE_KEY, validDate, todayKey, addDays, addMonths, weekStart, monthDays, formatDate, minutes, inputErrors, emptyState, validState, tasksForDay, saveTask, toggleTask, removeTask, layoutIntervals, occurrenceOnOrAfter, nextOccurrence, getTask, reconcile, stopSeries, moveTask, shiftTaskTime, reorderTask, shiftTask, seriesImpact, dayIndex, dayPlan, cleanState, backupPayload, parseBackup, prepareRestore };
})();

if (typeof module !== "undefined" && module.exports) module.exports = PlannerCore;

if (typeof document !== "undefined") (() => {
  const C = PlannerCore, $ = id => document.getElementById(id), now = () => new Date();
  const ui = { selected: C.todayKey(now()), lastToday: C.todayKey(now()), editingId: null, initialDraft: "", returnFocus: null, confirm: null, dirty: false, blocked: false, toastTimer: null, dragId: null, renderPending: false, suppressClick: false, clockMessageDate: null };
  let data = C.emptyState(now()), storage = null;
  Object.assign(ui, { baseRaw: null, rawDamaged: null, conflict: false, draftStale: false, storageAvailable: false });
  function storageError(message, blocked = false) {
    ui.dirty = true; ui.blocked = blocked;
    $("storage-alert").hidden = false; $("storage-message").textContent = message;
    $("save-status").textContent = blocked ? "Данные не загружены" : "Не сохранено"; $("save-status").classList.add("warning");
    $("retry-save").hidden = blocked || ui.conflict;
    $("download-raw").hidden = ui.rawDamaged === null;
    $("emergency-export").hidden = blocked;
    $("load-external").hidden = !ui.conflict;
    $("export-backup").disabled = blocked;
  }
  function saved() {
    ui.dirty = false; ui.blocked = false; ui.conflict = false; ui.rawDamaged = null; ui.storageAvailable = true;
    $("storage-alert").hidden = true; $("save-status").textContent = "Сохранено в браузере"; $("save-status").classList.remove("warning"); $("export-backup").disabled = false;
  }
  function readState(raw) {
    if (raw === null) throw new Error("Данные удалены другой вкладкой. Для защиты записей автоматическая замена остановлена.");
    let value; try { value = JSON.parse(raw); } catch { throw new Error("Сохранённые данные повреждены"); }
    if (!C.validState(value)) throw new Error("Формат сохранённых данных не поддерживается или повреждён");
    return C.cleanState(value);
  }
  function initializeStorage() {
    try {
      storage = window.localStorage;
      const raw = storage.getItem(C.STORAGE_KEY);
      ui.baseRaw = raw;
      if (raw !== null) {
        try { data = readState(raw); }
        catch (error) { ui.rawDamaged = raw; ui.storageAvailable = true; storageError(`${error.message}. Они не перезаписаны. Скачайте исходные данные или восстановите резервную копию. Редактирование заблокировано.`, true); return; }
      }
      const probe = `${C.STORAGE_KEY}.probe.${Date.now()}`;
      storage.setItem(probe, "ok"); if (storage.getItem(probe) !== "ok") throw new Error("Storage verification failed"); storage.removeItem(probe);
      saved();
    } catch { storageError("Временный режим — изменения не сохраняются в браузере. Скачайте резервную копию перед закрытием страницы. Восстановление доступно после устранения ошибки хранения."); }
  }
  function markStale() {
    if ($("task-dialog").open) { ui.draftStale = true; setError("task-form-error", "Данные изменены в другой вкладке. Ваш текст сохранён в форме. Закройте форму и откройте задачу заново перед сохранением."); }
  }
  function conflict(message) {
    ui.conflict = true;
    storageError(`${message} Изменения этой вкладки не перезаписаны. Скачайте мою копию или загрузите данные другой вкладки. Продолжайте редактирование в одной вкладке: при одновременной работе возможны конфликты.`, ui.blocked);
  }
  // Compare the actual stored string as well as revision: localStorage has no compare-and-swap.
  function checkExternal() {
    if (ui.conflict) return false;
    let raw;
    try { if (!storage) storage = window.localStorage; raw = storage.getItem(C.STORAGE_KEY); }
    catch { ui.storageAvailable = false; ui.readFailed = true; return true; }
    ui.readFailed = false;
    if (raw === ui.baseRaw) return true;
    if (ui.dirty || ui.blocked) { conflict("Обнаружены изменения другой вкладки при наличии локальных несохранённых данных."); return false; }
    try {
      const incoming = readState(raw);
      data = incoming; ui.baseRaw = raw; saved(); markStale(); render(); showToast("Данные обновлены из другой вкладки");
    } catch (error) { conflict(error.message); }
    return false; // The action was prepared against a different state; do not apply it.
  }
  function commit(next) {
    if (ui.blocked || !checkExternal()) { render(); return false; }
    next = C.reconcile(next, now());
    if (!C.validState(next)) { showToast("Не удалось сохранить: неверные данные"); return false; }
    next.revision = data.revision + 1; next.updatedAt = now().toISOString();
    if (!C.validState(next)) { showToast("Не удалось сохранить: недопустимая ревизия данных"); return false; }
    data = next;
    try {
      if (!storage) storage = window.localStorage;
      if (ui.readFailed) throw new Error("Невозможно проверить сохранённые данные перед записью");
      const raw = JSON.stringify(data); storage.setItem(C.STORAGE_KEY, raw); ui.baseRaw = raw; saved();
    } catch { storageError("Изменения не сохранены в браузере и доступны только в этой вкладке. Скачайте резервную копию перед закрытием страницы или повторите сохранение."); }
    render(); return true;
  }
  function backupError(message = "") { $("backup-error").textContent = message; $("backup-error").hidden = !message; }
  function fileStamp() { const date = now(); return `${C.todayKey(date)}-${String(date.getHours()).padStart(2,"0")}${String(date.getMinutes()).padStart(2,"0")}${String(date.getSeconds()).padStart(2,"0")}`; }
  function download(text, filename, type) {
    const url = URL.createObjectURL(new Blob([text], { type: `${type};charset=utf-8` })), anchor = document.createElement("a");
    anchor.href = url; anchor.download = filename; document.body.append(anchor); anchor.click(); anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function exportBackup() {
    if (ui.blocked) { backupError("Сначала скачайте исходную строку повреждённых данных или восстановите копию"); return; }
    try { download(JSON.stringify(C.backupPayload(data, now()), null, 2), `planner-backup-${fileStamp()}.json`, "application/json"); backupError(); $("backup-menu").open = false; showToast("Резервная копия подготовлена для скачивания"); }
    catch (error) { backupError(error.message); }
  }
  function chooseBackup() {
    $("backup-menu").open = false;
    if (!ui.storageAvailable) { backupError("Восстановление недоступно во временном режиме. Включите сохранение данных в браузере и нажмите «Повторить сохранение». Текущую копию можно скачать."); return; }
    $("backup-file").value = ""; $("backup-file").click();
  }
  async function importBackup(file) {
    if (!file) return;
    backupError();
    if (!ui.storageAvailable) { backupError("Восстановление недоступно: сначала устраните ошибку хранения"); return; }
    if (file.size > 20 * 1024 * 1024) { backupError("Файл превышает ограничение 20 MiB. Текущие данные не изменены."); return; }
    const base = ui.baseRaw, current = data, recovering = ui.conflict;
    try {
      const externalRaw = storage.getItem(C.STORAGE_KEY);
      let externalRevision = 0;
      if (recovering) { try { externalRevision = readState(externalRaw).revision; } catch { /* Damaged external data can be replaced explicitly. */ } }
      const recoveryUnchanged = () => {
        try { return data === current && ui.baseRaw === base && ui.conflict === recovering && ui.storageAvailable && storage.getItem(C.STORAGE_KEY) === externalRaw; }
        catch { return false; }
      };
      const imported = C.parseBackup(await file.text());
      if (data !== current || ui.baseRaw !== base || (recovering ? !recoveryUnchanged() : !checkExternal())) throw new Error("Данные изменились во время чтения файла. Выберите файл заново.");
      const tasks = imported.data.tasks.filter(t => t.status !== "merged"), done = tasks.filter(t => t.status === "done");
      const date = new Intl.DateTimeFormat("ru-RU", { dateStyle: "medium", timeStyle: "short" }).format(new Date(imported.exportedAt));
      confirmAction("Восстановить резервную копию?", `Копия от ${date}.\nЗадач: ${tasks.length}; выполнено: ${done.length}; серий: ${imported.data.series.length}.\nВсе текущие задачи, история и настройки будут заменены. Данные копии будут актуализированы на сегодня.${recovering ? "\nБудут заменены и несохранённая версия этой вкладки, и данные другой вкладки в браузере. Открытый черновик будет закрыт. Если нужна своя версия, отмените замену и сначала скачайте мою копию." : ""}`, "Заменить все данные", () => {
        try {
          const next = C.prepareRestore(imported.data, Math.max(data.revision, externalRevision), now()), raw = JSON.stringify(next);
          // Persist first. A failed import must leave both memory and the previous stored value intact.
          storage.setItem(C.STORAGE_KEY, raw);
          if ($("task-dialog").open) closeTask();
          data = next; ui.baseRaw = raw; saved(); backupError(); ui.selected = C.todayKey(now()); render(); showToast("Резервная копия восстановлена");
        } catch { backupError("Не удалось записать резервную копию в браузер. Текущие данные не изменены. Освободите место или разрешите локальное хранение и повторите восстановление."); }
      }, "Отмена", recovering ? recoveryUnchanged : true);
    } catch (error) { backupError(`${error.message}. Текущие данные не изменены.`); }
  }
  function loadExternal() {
    confirmAction("Загрузить данные другой вкладки?", "Все несохранённые изменения этой вкладки и открытый черновик будут потеряны. Перед заменой скачайте мою копию.", "Загрузить данные", () => {
      try {
        const raw = storage.getItem(C.STORAGE_KEY), incoming = readState(raw);
        if ($("task-dialog").open) closeTask();
        data = incoming; ui.baseRaw = raw; saved(); backupError(); ui.draftStale = false; refresh(); showToast("Загружены данные другой вкладки");
      } catch (error) { backupError(`${error.message}. Локальные данные не изменены. Можно восстановить исходные данные другой вкладки, затем повторить загрузку.`); }
    }, "Отмена", false);
  }
  function refresh() {
    if (ui.blocked || !checkExternal()) return false;
    const current = now(), today = C.todayKey(current);
    if (today < data.lastReconciledDate && ui.clockMessageDate !== today) { ui.clockMessageDate = today; showToast("Дата компьютера изменилась. Ранее перенесённые задачи сохранены"); }
    if (today !== ui.lastToday) { if (ui.selected === ui.lastToday && C.validDate(today)) ui.selected = today; ui.lastToday = today; }
    const next = C.reconcile(data, current);
    if (JSON.stringify(next) !== JSON.stringify(data)) return commit(next); else render();
    return true;
  }
  function showToast(message) { clearTimeout(ui.toastTimer); $("toast").textContent = message; $("toast").hidden = false; ui.toastTimer = setTimeout(() => { $("toast").hidden = true; }, 4000); }
  function make(tag, className, text) { const el = document.createElement(tag); if (className) el.className = className; if (text !== undefined) el.textContent = text; return el; }
  function button(label, className, action) { const el = make("button", className, label); el.type = "button"; el.addEventListener("click", action); return el; }
  function selectedDay(date) { if (!C.validDate(date) || ui.suppressClick) return; refresh(); ui.selected = date; render(); }
  function renderTask(task, timeline = false) {
    const card = make("article", `task-card${task.status === "done" ? " done" : ""}${timeline ? " timeline-task" : ""}`); card.dataset.taskId = task.id;
    const checkbox = document.createElement("input"); checkbox.type = "checkbox"; checkbox.checked = task.status === "done"; checkbox.setAttribute("aria-label", `${task.status === "done" ? "Вернуть в работу" : "Выполнить"}: ${task.title}`); checkbox.disabled = ui.blocked;
    checkbox.addEventListener("change", () => {
      if (!refresh()) { render(); return; } try { commit(C.toggleTask(data, task.id, now())); } catch (error) { showToast(error.message); render(); }
      const updated = document.querySelector(`[data-task-id="${CSS.escape(task.id)}"] input`);
      if (updated && !updated.closest("[hidden]")) updated.focus({ preventScroll: true });
      else $("today-button").focus({ preventScroll: true });
    });
    const open = button("", "task-open", () => openTask(task.id)); open.setAttribute("aria-label", `Открыть задачу: ${task.title}`); open.title = `${task.startTime ? `${task.startTime}–${task.endTime} · ` : ""}${task.title}${task.note ? `\n${task.note}` : ""}`;
    if (task.startTime) open.append(make("span", "task-time", `${task.startTime}–${task.endTime}`));
    open.append(make("span", "task-title", task.title));
    if (task.note) open.append(make("span", "task-note", task.note));
    if (task.autoMoved && !timeline) open.append(make("span", "task-badge", "Перенесено"));
    if (task.seriesId && !timeline) open.append(make("span", "task-badge", "↻ Повторяется"));
    if (task.seriesId) {
      open.title += "\nПовторяющаяся задача";
      open.setAttribute("aria-label", `Открыть задачу: ${task.title}. Повторяющаяся задача`);
      if (timeline) {
        const marker = make("span", "task-badge repeat-marker", "↻"); marker.setAttribute("aria-hidden", "true");
        open.classList.add("has-repeat"); open.append(marker);
      }
    }
    if (task.status === "todo" && !ui.blocked) {
      const handle = button("⠿", "drag-handle", () => { if (!ui.suppressClick) openTask(task.id); }); handle.draggable = true; handle.setAttribute("aria-label", `Перетащить задачу: ${task.title}`); handle.title = timeline ? "Перетащите вверх или вниз с шагом 10 минут; на календарь — на другую дату" : "Перетащите задачу на дату или внутри списка";
      if (timeline) { card.draggable = true; open.draggable = true; }
      card.addEventListener("dragstart", event => {
        if (event.target.closest("input") || ui.conflict) { event.preventDefault(); return; }
        ui.dragId = task.id; event.dataTransfer.setData("text/plain", task.id); event.dataTransfer.effectAllowed = "move"; card.classList.add("dragging");
        if (timeline) {
          const image = make("canvas", "time-drag-image"); image.width = 1; image.height = 1; image.setAttribute("aria-hidden", "true"); document.body.append(image); event.dataTransfer.setDragImage(image, 0, 0);
          ui.timeDrag = { id: task.id, date: task.date, startTime: task.startTime, endTime: task.endTime, baseRaw: ui.baseRaw, card, offset: event.clientY - card.getBoundingClientRect().top, start: C.minutes(task.startTime), duration: C.minutes(task.endTime) - C.minutes(task.startTime), image };
          document.body.classList.add("time-drag-active");
        }
      });
      card.addEventListener("dragend", finishDrag); card.append(handle);
      if (!timeline && task.startTime === null) {
        card.addEventListener("dragover", event => { const source = C.getTask(data, ui.dragId); if (!source || source.id === task.id || source.startTime !== null || source.date !== task.date) return; event.preventDefault(); event.stopPropagation(); clearDropMarks(); card.classList.add(event.clientY < card.getBoundingClientRect().top + card.offsetHeight / 2 ? "drop-before" : "drop-after"); });
        card.addEventListener("drop", event => { if (!ui.dragId) return; const id = ui.dragId; event.preventDefault(); event.stopPropagation(); const before = event.clientY < card.getBoundingClientRect().top + card.offsetHeight / 2; try { if (!refresh()) return; if (id !== task.id) commit(C.reorderTask(data, id, task.id, before, now())); } catch (error) { showToast(error.message); } finally { finishDrag(); } });
      }
    }
    if (task.status === "done") { const spacer = make("span", "drag-handle drag-placeholder", "⠿"); spacer.setAttribute("aria-hidden", "true"); card.append(spacer); }
    card.append(checkbox, open); return card;
  }
  function render() {
    if (ui.dragId) { ui.renderPending = true; return; }
    const index = C.dayIndex(data), today = C.todayKey(now()), selected = ui.selected, current = C.tasksForDay(data, selected, index), plan = C.dayPlan(current), isPast = selected < today;
    $("day-title").textContent = C.formatDate(selected, { day: "numeric", month: "long" });
    $("day-context").textContent = `${C.formatDate(selected, { weekday: "long" }).toLocaleUpperCase("ru-RU")} · ${selected.slice(0,4)}${selected === today ? " · СЕГОДНЯ" : ""}`;
    $("previous-day").disabled = selected <= C.MIN_DATE; $("next-day").disabled = selected >= C.MAX_DATE;
    $("add-area").hidden = isPast || ui.blocked; $("past-message").hidden = !isPast || ui.blocked;
    $("untimed-count").textContent = String(plan.untimed.length);
    $("untimed-list").replaceChildren(...plan.untimed.map(t => renderTask(t)));
    if (!plan.untimed.length) $("untimed-list").append(make("p", "empty-state", ui.blocked ? "Данные недоступны. Восстановите резервную копию." : isPast ? "Нет задач без времени на этот день" : plan.timed.length ? "Нет задач без времени" : "Пока нет задач. Добавьте первую"));
    const outside = plan.timed.some(t => C.minutes(t.startTime) < 480 || C.minutes(t.endTime) > 1200), full = data.settings.showFullDay || outside, startHour = full ? 0 : 8, endHour = full ? 24 : 20;
    $("toggle-hours").textContent = full ? "Показать рабочие часы" : "Показать весь день";
    $("toggle-hours").disabled = outside && !data.settings.showFullDay;
    const canCreate = !isPast && !ui.blocked;
    $("schedule-hint").textContent = [outside ? "Показаны все часы: есть задачи вне рабочего диапазона" : "", canCreate ? "Дважды щёлкните по свободному месту, чтобы добавить задачу. Карточки можно двигать по времени с шагом 10 минут" : ""].filter(Boolean).join(". ");
    $("schedule-hint").hidden = !$("schedule-hint").textContent;
    const timeline = $("timeline"); timeline.replaceChildren(); timeline.style.height = `${(endHour - startHour) * 56}px`; timeline.dataset.startHour = String(startHour); timeline.dataset.endHour = String(endHour);
    for (let hour = startHour; hour <= endHour; hour++) { const label = make("span", "hour-label", `${String(hour).padStart(2,"0")}:00`); label.style.top = `${(hour - startHour) * 56}px`; label.dataset.hour = String(hour); timeline.append(label); }
    const intervals = C.layoutIntervals(plan.timed, 20, endHour * 60);
    // Dense short intervals scroll inside the schedule instead of shrinking controls to nothing.
    timeline.style.minWidth = `${intervals.reduce((width, item) => Math.max(width, item.columns * 64), 0)}px`;
    for (const item of intervals) {
      const card = renderTask(item.task, true), duration = C.minutes(item.task.endTime) - C.minutes(item.task.startTime);
      card.style.top = `${(C.minutes(item.task.startTime) - startHour * 60) * 56 / 60}px`; card.style.height = `${duration * 56 / 60}px`;
      card.style.left = `calc(${item.column * 100 / item.columns}% + 5px)`; card.style.width = `calc(${100 / item.columns}% - 10px)`;
      if (duration < 60) card.classList.add("short");
      if (duration < 30) {
        card.classList.add("compact");
        const controls = make("div", "compact-controls"); controls.style.top = `${(item.labelStart - C.minutes(item.task.startTime)) * 56 / 60}px`;
        controls.append(...card.childNodes); card.append(controls);
      }
      timeline.append(card);
    }
    $("completed-title").textContent = ui.blocked ? "Данные о выполнении недоступны" : `Выполнено задач: ${current.done.length}`;
    const start = C.weekStart(selected), weekEnd = C.addDays(start, 6);
    $("week-heading").textContent = start === C.weekStart(today) ? "Эта неделя" : "Неделя";
    $("week-range").textContent = `${C.formatDate(start,{day:"numeric",month:"short"})} — ${C.formatDate(weekEnd,{day:"numeric",month:"short"})}`;
    const week = $("week-list"); week.replaceChildren();
    for (let offset = 0; offset < 7; offset++) {
      const date = C.addDays(start, offset), valid = C.validDate(date), daily = C.tasksForDay(data, date, index), tasks = [...daily.timed, ...daily.untimed];
      const row = make("div", `week-row${date === selected ? " selected" : ""}${date === today ? " is-today" : ""}`); row.dataset.date = date;
      const dateButton = button("", "week-date", () => selectedDay(date)); dateButton.disabled = !valid; dateButton.setAttribute("aria-label", C.formatDate(date,{weekday:"long",day:"numeric",month:"long",year:"numeric"})); dateButton.append(make("span", "", C.formatDate(date,{weekday:"short"})), make("strong", "", String(Number(date.slice(8)))));
      const preview = make("div", "week-preview");
      for (const task of tasks.slice(0,3)) { const link = button(`${task.startTime ? task.startTime + " " : ""}${task.title}`,"week-task",() => openTask(task.id)); link.title = task.title; preview.append(link); }
      if (tasks.length > 3) preview.append(button(`Ещё ${tasks.length - 3}`,"text-button week-more",() => selectedDay(date)));
      if (!tasks.length) preview.append(make("span","week-empty","—"));
      row.append(dateButton, preview, make("span","week-count", tasks.length ? String(tasks.length) : "")); attachDateDrop(row, date); week.append(row);
    }
    $("month-heading").textContent = C.formatDate(selected,{month:"long",year:"numeric"}).replace(/\s*г\.$/, "");
    $("previous-month").disabled = C.addMonths(selected,-1) < C.MIN_DATE; $("next-month").disabled = C.addMonths(selected,1) > C.MAX_DATE;
    const month = $("month-grid"); month.replaceChildren();
    for (const date of C.monthDays(selected)) {
      const daily = C.tasksForDay(data,date,index), count = daily.timed.length + daily.untimed.length;
      const day = button("",`month-day${date.slice(0,7) !== selected.slice(0,7) ? " adjacent" : ""}${date === today ? " is-today" : ""}${date === selected ? " selected" : ""}`,() => selectedDay(date)); day.dataset.date = date; day.disabled = !C.validDate(date); day.setAttribute("aria-label",`${C.formatDate(date,{day:"numeric",month:"long",year:"numeric"})}${count ? `, незавершённых задач: ${count}` : ""}`);
      if (date === selected) day.setAttribute("aria-pressed","true"); if (date === today) day.setAttribute("aria-current","date");
      day.append(make("span","",String(Number(date.slice(8))))); if(count) day.append(make("span","month-count",String(count))); attachDateDrop(day, date); month.append(day);
    }
    $("toggle-hours").disabled ||= ui.blocked;
  }
  function clearDropMarks() { document.querySelectorAll(".drop-target,.drop-before,.drop-after").forEach(element => element.classList.remove("drop-target", "drop-before", "drop-after")); }
  function finishDrag() { const pending = ui.renderPending, timed = ui.timeDrag; timed?.image.remove(); ui.timeDrag = null; ui.dragId = null; ui.renderPending = false; ui.suppressClick = true; document.body.classList.remove("time-drag-active"); clearDropMarks(); document.querySelectorAll(".dragging").forEach(el => el.classList.remove("dragging")); if (pending || timed) render(); setTimeout(() => { ui.suppressClick = false; }, 0); }
  function previewTime(event) {
    const drag = ui.timeDrag, timeline = $("timeline");
    if (!drag || ui.dragId !== drag.id || drag.date !== ui.selected || ui.blocked || ui.conflict) return false;
    const first = Number(timeline.dataset.startHour) * 60, end = Math.min(1439, Number(timeline.dataset.endHour) * 60), min = Math.ceil(first / 10) * 10, max = Math.floor((end - drag.duration) / 10) * 10;
    if (max < min) return false;
    event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = "move";
    const raw = first + (event.clientY - timeline.getBoundingClientRect().top - drag.offset) * 60 / 56, original = C.minutes(drag.startTime);
    drag.start = Math.abs(raw - original) < 5 ? original : Math.max(min, Math.min(max, Math.round(raw / 10) * 10));
    const time = value => `${String(Math.floor(value / 60)).padStart(2,"0")}:${String(value % 60).padStart(2,"0")}`;
    drag.card.style.top = `${(drag.start - first) * 56 / 60}px`; drag.card.querySelector(".task-time").textContent = `${time(drag.start)}–${time(drag.start + drag.duration)}`;
    return true;
  }
  $("timeline").addEventListener("dragover", previewTime);
  $("timeline").addEventListener("drop", event => {
    if (!previewTime(event)) return;
    const drag = ui.timeDrag;
    try {
      if (!refresh()) { showToast("Данные изменились. Перемещение отменено"); return; }
      const task = C.getTask(data, drag.id);
      if (ui.baseRaw !== drag.baseRaw || !task || task.status !== "todo" || task.date !== drag.date || task.startTime !== drag.startTime || task.endTime !== drag.endTime) { showToast("Задача изменилась во время перетаскивания. Перемещение отменено"); return; }
      if (drag.start !== C.minutes(task.startTime) && commit(C.shiftTaskTime(data, drag.id, drag.start, now()))) showToast(ui.dirty ? "Новое время остаётся в памяти вкладки. Скачайте резервную копию." : "Время задачи изменено");
    } catch (error) { showToast(error.message); } finally { finishDrag(); }
  });
  function attachDateDrop(element, date) {
    element.addEventListener("dragover", event => { if (!ui.dragId) return; event.preventDefault(); clearDropMarks(); const allowed = C.validDate(date) && date >= C.todayKey(now()) && !ui.blocked; event.dataTransfer.dropEffect = allowed ? "move" : "none"; if (allowed) element.classList.add("drop-target"); });
    element.addEventListener("dragenter", () => { if (ui.dragId && date < C.todayKey(now())) showToast("Нельзя перенести задачу на прошедшую дату"); });
    element.addEventListener("dragleave", event => { if (!element.contains(event.relatedTarget)) element.classList.remove("drop-target"); });
    element.addEventListener("drop", event => { if (!ui.dragId) return; const id = ui.dragId; event.preventDefault(); event.stopPropagation(); try { if (!refresh()) return; const task = C.getTask(data, id); if (task?.status === "todo" && task.date === date) return; if (commit(C.moveTask(data, id, date, now()))) showToast(`Задача перенесена на ${C.formatDate(date, { day: "2-digit", month: "2-digit", year: "numeric" })}`); } catch (error) { showToast(error.message); } finally { finishDrag(); } });
  }
  function draft() { return { title: $("task-title").value, note: $("task-note").value, date: $("task-date").value, startTime: $("task-timed").checked ? $("task-start").value : null, endTime: $("task-timed").checked ? $("task-end").value : null, repeatKind: $("task-repeat").value, scope: $("task-scope").value }; }
  function setError(id, message, fieldId) { $(id).textContent = message || ""; $(id).hidden = !message; if(fieldId) $(fieldId).setAttribute("aria-invalid", String(!!message)); }
  function clearErrors() { for(const [id,field] of [["title-error","task-title"],["note-error","task-note"],["date-error","task-date"],["time-error",null],["repeat-error","task-repeat"],["task-form-error",null]]) setError(id,"",field); }
  function updateRepeatControls() {
    const task = ui.editingId ? C.getTask(data, ui.editingId) : null, series = task?.seriesId ? data.series.find(s => s.id === task.seriesId) : null;
    const future = !!series && task.status !== "done" && $("task-scope").value === "future";
    $("series-scope-field").hidden = !series || task.status === "done";
    $("task-date").readOnly = task?.status === "done" || future;
    $("stop-repeat").hidden = !series || task.status !== "todo";
    const impact = series ? C.seriesImpact(data, task.id) : { overrides: 0 };
    $("series-scope-hint").textContent = future ? `Будут изменены эта и следующие задачи. Индивидуальные поля ${impact.overrides} сохранённых задач будут заменены. Дата переносится только в режиме «Только эта задача». Выполненная история сохранится.` : "Дата переносится только у этого выполнения. Расписание серии не сдвигается.";
    let preview = "";
    if (series) preview = "Пропущенные повторы объединяются в одну задачу. Для другого расписания прекратите повторение и создайте новую задачу.";
    else if ((!task || task.status === "todo") && $("task-repeat").value !== "none" && C.validDate($("task-date").value)) {
      const first = C.occurrenceOnOrAfter({ kind: $("task-repeat").value, startDate: $("task-date").value, anchorDay: Number($("task-date").value.slice(8)), anchorWeekday: new Date($("task-date").value + "T00:00:00Z").getUTCDay(), stopBeforeDate: null }, $("task-date").value);
      preview = first ? `Первое выполнение: ${C.formatDate(first, { weekday: "long", day: "numeric", month: "long" })}. Повторение действует, пока вы его не прекратите. Пропуски объединяются в одну задачу.` : "Первое выполнение выходит за доступный диапазон дат";
    }
    else if (task?.status === "done") preview = "Чтобы включить повторение, сначала верните задачу в работу.";
    $("repeat-preview").textContent = preview; $("repeat-preview").hidden = !preview;
    const list = task ? C.dayPlan(C.tasksForDay(data, task.date)).untimed : [], index = list.findIndex(item => item.id === task?.id);
    $("order-actions").hidden = !task || task.status !== "todo" || $("task-timed").checked || future;
    $("move-up").disabled = index <= 0; $("move-down").disabled = index < 0 || index >= list.length - 1;
  }
  function openTask(id = null, defaults = null) {
    if (ui.blocked || ui.suppressClick) return;
    const sourceFocus = document.activeElement;
    if (!refresh()) return;
    const task = id ? C.getTask(data, id) : null;
    if (id && (!task || task.status === "merged")) { showToast("Задача уже изменена или объединена"); return; }
    if (!task && ui.selected < C.todayKey(now())) return;
    ui.returnFocus = sourceFocus; ui.editingId = id; ui.singleDateDraft = null; ui.draftStale = false; clearErrors();
    $("task-dialog-title").textContent = task ? "Задача" : "Новая задача";
    $("task-title").value = task?.title || ""; $("task-note").value = task?.note || ""; $("task-date").value = task?.date || ui.selected;
    const done = task?.status === "done"; $("task-date").readOnly = done; $("task-date").min = done ? C.MIN_DATE : C.todayKey(now());
    $("task-timed").checked = task ? !!task.startTime : !!defaults?.startTime; $("task-timed").disabled = done;
    $("task-start").value = task ? task.startTime || "" : defaults?.startTime || ""; $("task-end").value = task ? task.endTime || "" : defaults?.endTime || ""; $("task-start").disabled = done; $("task-end").disabled = done;
    $("time-fields").hidden = !$("task-timed").checked; $("delete-task").hidden = !task;
    $("task-origin").hidden = !task?.autoMoved; $("task-origin").textContent = task?.autoMoved ? `Первоначальная дата: ${C.formatDate(task.originalDate,{day:"numeric",month:"long",year:"numeric"})}` : "";
    $("task-repeat").value = task?.seriesId ? data.series.find(s => s.id === task.seriesId).kind : "none"; $("task-repeat").disabled = !!task?.seriesId || done; $("task-scope").value = "single"; updateRepeatControls();
    ui.initialDraft = JSON.stringify(draft()); $("task-dialog").showModal(); $("task-title").focus();
  }
  function closeTask() {
    const taskId = ui.editingId; $("task-dialog").close(); ui.editingId = null; ui.initialDraft = ""; ui.draftStale = false;
    const currentButton = taskId ? document.querySelector(`[data-task-id="${CSS.escape(taskId)}"] .task-open`) : null;
    const target = ui.returnFocus?.isConnected && ui.returnFocus !== document.body && !ui.returnFocus.closest("[hidden]") ? ui.returnFocus : currentButton && !currentButton.closest("[hidden]") ? currentButton : !$("add-area").hidden ? $("quick-title") : $("today-button");
    target.focus({ preventScroll: true });
  }
  function confirmAction(title, message, acceptLabel, action, cancelLabel = "Отмена", guarded = true) {
    ui.confirmFocus = document.activeElement;
    ui.confirm = action; ui.confirmGuarded = guarded; ui.confirmBase = ui.baseRaw; ui.confirmRevision = data.revision; ui.confirmTaskId = null; $("confirm-scope-field").hidden = true; $("confirm-title").textContent = title; $("confirm-message").textContent = message; $("confirm-accept").textContent = acceptLabel; $("confirm-cancel").textContent = cancelLabel; $("confirm-dialog").showModal(); $("confirm-cancel").focus();
  }
  function closeConfirmation() {
    $("confirm-dialog").close();
    const previous = ui.confirmFocus;
    const target = previous?.isConnected && previous !== document.body && previous !== document.documentElement && previous.getClientRects().length && !previous.disabled ? previous : $("task-dialog").open ? $("task-title") : $("backup-menu").querySelector("summary");
    target.focus({ preventScroll: true });
  }
  function deletionMessage(task, scope) {
    const impact = C.seriesImpact(data, task.id);
    return scope === "future" ? `Будут удалены выбранная задача «${task.title}», ещё ${impact.otherOpen} сохранённых незавершённых задач и будущие повторы этой серии. Остальная выполненная история сохранится.` : `Будет удалена задача «${task.title}»${task.seriesId ? ". Остальные повторы продолжатся" : ""}. Это действие нельзя отменить.`;
  }
  function requestClose() { if(JSON.stringify(draft()) === ui.initialDraft) closeTask(); else confirmAction("Отменить изменения?", "Несохранённые изменения будут потеряны.", "Отменить изменения", closeTask, "Продолжить редактирование", false); }
  function freshTask() {
    const current = refresh();
    if (!current || ui.draftStale || ui.conflict || ui.blocked) { setError("task-form-error", "Данные изменились. Ваш текст остаётся в форме; закройте её и откройте актуальную задачу. При конфликте сначала выберите нужную копию данных."); return false; }
    return true;
  }
  $("quick-form").addEventListener("submit", event => {
    event.preventDefault(); if(ui.blocked || !refresh()) return;
    const result = C.saveTask(data,{title:$("quick-title").value,note:"",date:ui.selected,startTime:null,endTime:null},null,now());
    setError("quick-error",result.errors?.title || result.errors?.date,"quick-title");
    if(result.data && commit(result.data)) { $("quick-title").value = ""; $("quick-title").focus(); }
  });
  $("quick-title").addEventListener("input", () => setError("quick-error","","quick-title"));
  $("add-details").addEventListener("click",()=>openTask());
  $("timeline").addEventListener("dblclick", event => {
    if (event.button !== 0 || ui.blocked || ui.selected < C.todayKey(now()) || event.target.closest(".task-card") || $("task-dialog").open || $("confirm-dialog").open) return;
    const timeline = $("timeline"), startHour = Number(timeline.dataset.startHour), endHour = Number(timeline.dataset.endHour);
    const hourLabel = event.target.closest(".hour-label");
    const offset = hourLabel ? (Number(hourLabel.dataset.hour) - startHour) * 56 : event.clientY - timeline.getBoundingClientRect().top;
    // The visible grid has half-hour cells; the chosen interval remains editable.
    const start = Math.max(startHour * 60, Math.min(1410, endHour * 60, startHour * 60 + Math.floor(Math.max(0, offset) / 28) * 30));
    const end = Math.min(start + 60, 1439);
    const time = value => `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
    openTask(null, { startTime: time(start), endTime: time(end) });
  });
  $("task-timed").addEventListener("change",()=>{ const timed=$("task-timed").checked; $("time-fields").hidden=!timed; $("task-start").value=timed?"10:00":""; $("task-end").value=timed?"11:00":""; setError("time-error",""); updateRepeatControls(); });
  $("task-repeat").addEventListener("change", updateRepeatControls); $("task-date").addEventListener("change", updateRepeatControls);
  $("task-scope").addEventListener("change",()=>{const task=C.getTask(data,ui.editingId);if(task){if($("task-scope").value==="future"){ui.singleDateDraft=$("task-date").value;$("task-date").value=task.date;}else if(ui.singleDateDraft){$("task-date").value=ui.singleDateDraft;ui.singleDateDraft=null;}}updateRepeatControls();});
  function submitTask(confirmed = false) {
    if (!freshTask()) return; clearErrors();
    const input = draft(), result = C.saveTask(data, input, ui.editingId, now(), input.scope);
    if(result.errors) { setError("title-error",result.errors.title,"task-title"); setError("note-error",result.errors.note,"task-note"); setError("date-error",result.errors.date,"task-date"); setError("time-error",result.errors.time); setError("repeat-error",result.errors.repeat,"task-repeat"); setError("task-form-error",result.errors.form); if (result.errors.date && input.date < C.todayKey(now())) $("date-error").textContent += ` Выберите сегодня: ${C.formatDate(C.todayKey(now()), { day: "numeric", month: "long" })}.`; const invalid=$("task-form").querySelector('[aria-invalid="true"]'); if(invalid) invalid.focus(); else if(result.errors.time) $("task-start").focus(); return; }
    const impact = ui.editingId ? C.seriesImpact(data, ui.editingId) : null;
    if (!confirmed && input.scope === "future" && impact?.overrides) { confirmAction("Изменить эту и следующие?", `Индивидуальные название, заметка и время ${impact.overrides} сохранённых задач будут заменены. Выполненная история сохранится.`, "Применить", () => submitTask(true)); return; }
    if(commit(result.data)) { closeTask(); showToast(ui.dirty ? "Задача остаётся в памяти вкладки. Скачайте резервную копию." : "Задача сохранена"); }
  }
  $("task-form").addEventListener("submit",event=>{ event.preventDefault(); submitTask(); });
  $("cancel-task").addEventListener("click",requestClose); $("close-task").addEventListener("click",requestClose);
  $("task-dialog").addEventListener("cancel",event=>{event.preventDefault();requestClose();});
  $("confirm-dialog").addEventListener("cancel",event=>{event.preventDefault();ui.confirm=null;closeConfirmation();});
  $("confirm-cancel").addEventListener("click",()=>{ui.confirm=null;closeConfirmation();});
  $("confirm-accept").addEventListener("click",()=>{const action=ui.confirm, base=ui.confirmBase, revision=ui.confirmRevision, guarded=ui.confirmGuarded;ui.confirm=null;closeConfirmation();const unchanged=typeof guarded==="function"?guarded():!guarded||(checkExternal()&&!ui.readFailed&&base===ui.baseRaw&&revision===data.revision);if(!unchanged){const message="Данные изменились после открытия подтверждения. Действие отменено; повторите его после проверки актуальных данных.";if($("task-dialog").open)setError("task-form-error",message);else backupError(message);return;}if(action)action();});
  $("delete-task").addEventListener("click",()=>{if(!freshTask())return;const task=C.getTask(data,ui.editingId);if(!task)return;const scope = task.seriesId ? $("task-scope").value : "single"; confirmAction("Удалить задачу?",deletionMessage(task,scope),"Удалить",()=>{const chosenScope=task.seriesId?$("confirm-scope").value:"single";if(!freshTask())return;try{if(commit(C.removeTask(data,task.id,chosenScope,now()))){closeTask();showToast("Задача удалена");}}catch(error){showToast(error.message);}});if(task.seriesId){ui.confirmTaskId=task.id;$("confirm-scope-field").hidden=false;$("confirm-scope").value=scope;}});
  $("confirm-scope").addEventListener("change",()=>{const task=C.getTask(data,ui.confirmTaskId);if(task)$("confirm-message").textContent=deletionMessage(task,$("confirm-scope").value);});
  $("stop-repeat").addEventListener("click",()=>{ if(!freshTask())return; const task=C.getTask(data,ui.editingId);if(!task?.seriesId)return;const impact=C.seriesImpact(data,task.id);confirmAction("Прекратить повторение?",`Эта задача останется обычной. Ещё ${impact.otherOpen} сохранённых незавершённых задач и будущие повторы будут удалены. Выполненная история сохранится. Несохранённые изменения формы не применяются.`,"Прекратить повторение",()=>{if(!freshTask())return;try{if(commit(C.stopSeries(data,task.id,now()))){closeTask();showToast("Повторение прекращено");}}catch(error){showToast(error.message);}});});
  for (const [id,direction] of [["move-up",-1],["move-down",1]]) $(id).addEventListener("click",()=>{if(!freshTask())return;try{commit(C.shiftTask(data,ui.editingId,direction,now()));updateRepeatControls();}catch(error){showToast(error.message);}});
  $("previous-day").addEventListener("click",()=>selectedDay(C.addDays(ui.selected,-1))); $("next-day").addEventListener("click",()=>selectedDay(C.addDays(ui.selected,1))); $("today-button").addEventListener("click",()=>selectedDay(C.todayKey(now())));
  $("previous-month").addEventListener("click",()=>selectedDay(C.addMonths(ui.selected,-1))); $("next-month").addEventListener("click",()=>selectedDay(C.addMonths(ui.selected,1)));
  $("toggle-hours").addEventListener("click",()=>{const next=JSON.parse(JSON.stringify(data));next.settings.showFullDay=!next.settings.showFullDay;commit(next);});
  $("retry-save").addEventListener("click",()=>commit(JSON.parse(JSON.stringify(data))));
  $("export-backup").addEventListener("click", exportBackup); $("emergency-export").addEventListener("click", exportBackup);
  $("import-backup").addEventListener("click", chooseBackup); $("recovery-import").addEventListener("click", chooseBackup);
  $("backup-file").addEventListener("change", () => importBackup($("backup-file").files[0]));
  $("download-raw").addEventListener("click", () => { if (ui.rawDamaged !== null) download(ui.rawDamaged, `planner-original-${fileStamp()}.txt`, "text/plain"); });
  $("load-external").addEventListener("click", loadExternal);
  window.addEventListener("storage", event => { if (event.storageArea === storage && (event.key === C.STORAGE_KEY || event.key === null)) { checkExternal(); if (!ui.conflict && !ui.blocked) refresh(); } });
  document.addEventListener("keydown", event => { if (event.key === "Escape" && $("backup-menu").open && !$("task-dialog").open && !$("confirm-dialog").open) { $("backup-menu").open = false; $("backup-menu").querySelector("summary").focus(); } });
  document.addEventListener("click", event => { if (!$("backup-menu").contains(event.target)) $("backup-menu").open = false; });
  window.addEventListener("beforeunload",event=>{if(ui.dirty || ($("task-dialog").open && JSON.stringify(draft())!==ui.initialDraft)){event.preventDefault();event.returnValue="";}});
  document.addEventListener("click",event=>{if(ui.suppressClick){event.preventDefault();event.stopImmediatePropagation();}},true);
  document.addEventListener("keydown",event=>{if(event.key==="Escape"&&ui.dragId){event.preventDefault();finishDrag();}},true);
  document.addEventListener("visibilitychange",()=>{if(document.visibilityState==="visible")refresh();}); window.addEventListener("focus",refresh); setInterval(refresh,60000);
  initializeStorage(); refresh(); render();
})();
